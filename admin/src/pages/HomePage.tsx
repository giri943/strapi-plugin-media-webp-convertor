import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  Field,
  Flex,
  ProgressBar,
  Tabs,
  Typography,
} from '@strapi/design-system';
import { Layouts } from '@strapi/strapi/admin';
import {
  getSettings,
  putSettings,
  postMigrationPreview,
  postMigrationReplaceUrls,
  postS3CopyBatch,
  postS3DeleteBatch,
  postS3TestConnection,
} from '../utils/pluginRequest';

/* ------------------------------------------------------------------ */
/*  Upload optimization tab                                            */
/* ------------------------------------------------------------------ */

const UploadOptimizationPanel = () => {
  const [quality, setQuality] = useState(82);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgVariant, setMsgVariant] = useState<'success' | 'danger'>('success');

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const s = await getSettings();
      setQuality(s.webpQuality);
      setEnabled(s.webpConversionEnabled);
    } catch (e) {
      setMsgVariant('danger');
      setMsg(e instanceof Error ? e.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await putSettings({ webpQuality: quality, webpConversionEnabled: enabled });
      setMsgVariant('success');
      setMsg('Settings saved.');
    } catch (e) {
      setMsgVariant('danger');
      setMsg(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
      <Flex direction="column" alignItems="stretch" gap={6}>
        <Box>
          <Typography variant="delta" tag="h2">Upload optimization</Typography>
          <Box paddingTop={1}>
            <Typography variant="omega" textColor="neutral600">
              Raster images are automatically converted to lossy WebP before Strapi stores them.
              SVG uploads are validated only.
            </Typography>
          </Box>
        </Box>

        <Divider />

        <Checkbox
          checked={enabled}
          onCheckedChange={(v: boolean | 'indeterminate') => setEnabled(v === true)}
          disabled={loading || saving}
        >
          Enable WebP conversion on upload
        </Checkbox>

        <Box>
          <Field.Root name="webpQuality">
            <Field.Label>WebP quality — {quality}</Field.Label>
            <Box paddingTop={2} style={{ maxWidth: 360 }}>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={quality}
                disabled={loading || saving}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setQuality(Number(e.target.value))}
                style={{ width: '100%', accentColor: '#4945ff', cursor: 'pointer' }}
              />
            </Box>
            <Box paddingTop={1}>
              <Typography variant="pi" textColor="neutral500">
                75–90 recommended. Higher = sharper but larger. Default 82.
              </Typography>
            </Box>
          </Field.Root>
        </Box>

        {msg && (
          <Alert
            title={msgVariant === 'success' ? 'Success' : 'Error'}
            variant={msgVariant}
            closeLabel="Dismiss"
            onClose={() => setMsg(null)}
          >
            {msg}
          </Alert>
        )}

        <Flex gap={2}>
          <Button onClick={() => void save()} loading={saving} disabled={loading}>
            Save settings
          </Button>
          <Button variant="secondary" onClick={() => void load()} disabled={loading || saving}>
            Reload
          </Button>
        </Flex>
      </Flex>
    </Box>
  );
};

/* ------------------------------------------------------------------ */
/*  Migration tab                                                       */
/* ------------------------------------------------------------------ */

const gridRow: React.CSSProperties = {
  display: 'grid',
  gap: 16,
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  width: '100%',
};

/** Red asterisk for required labels (design system has no built-in required marker on Field). */
const RequiredMark = () => (
  <Typography tag="span" variant="pi" textColor="danger600" fontWeight="bold" style={{ marginLeft: '0.125rem' }}>
    *
  </Typography>
);

/** Alert title already says "Connection OK"; strip any duplicate prefix from the API message (incl. older servers). */
function s3ConnectionSuccessDetail(message: string): string | null {
  const stripped = message.replace(/^\s*Connection OK:?\s*/i, '').trim();
  return stripped.length > 0 ? stripped : null;
}

/** RFC 4180: fields that may contain `,` or `"` are enclosed in double quotes; `"` inside a field is escaped as `""`. */
function csvEscapeField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Match server `migration.ts` — safe join so `backup` + `upload/x` → `backup/upload/x`, not `backupupload/x`. */
function trimS3KeyPart(p: string): string {
  return p.trim().replace(/^\/+/, '');
}
function relativeKeyFromSource(objectKey: string, sourcePrefix: string): string {
  const key = trimS3KeyPart(objectKey);
  const raw = trimS3KeyPart(sourcePrefix);
  if (!raw) return key;
  if (key === raw) return '';
  const withSlash = raw.endsWith('/') ? raw : `${raw}/`;
  if (key.startsWith(withSlash)) return key.slice(withSlash.length);
  return key;
}
function joinDestObjectKey(destPrefix: string, relativeKey: string): string {
  const dp = destPrefix.trim().replace(/^\/+|\/+$/g, '');
  const rk = trimS3KeyPart(relativeKey);
  if (!dp) return rk;
  if (!rk) return `${dp}/`;
  return `${dp}/${rk}`;
}

/** HH:MM:SS timestamp for copy/delete log lines. */
function nowTimestamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function logLine(msg: string): string {
  return `[${nowTimestamp()}] ${msg}`;
}

const MigrationPanel = () => {
  const [oldUrl, setOldUrl] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [preview, setPreview] = useState<{ matchCount: number; samples: string[] } | null>(null);
  /** URL migration preview/replace only — kept separate so S3 "Start copy" is not blocked after a successful test. */
  const [urlBusy, setUrlBusy] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [logVariant, setLogVariant] = useState<'success' | 'danger' | 'warning'>('warning');

  const [sourceAccessKeyId, setSourceAccessKeyId] = useState('');
  const [sourceSecretAccessKey, setSourceSecretAccessKey] = useState('');
  const [destAccessKeyId, setDestAccessKeyId] = useState('');
  const [destSecretAccessKey, setDestSecretAccessKey] = useState('');
  const [region, setRegion] = useState('');
  const [srcBucket, setSrcBucket] = useState('');
  const [srcPrefix, setSrcPrefix] = useState('');
  const [dstBucket, setDstBucket] = useState('');
  const [destRegion, setDestRegion] = useState('');
  const [dstPrefix, setDstPrefix] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [copyLog, setCopyLog] = useState<string[]>([]);
  const [s3ConnectionOk, setS3ConnectionOk] = useState(false);
  const [s3TestBusy, setS3TestBusy] = useState(false);
  const [s3TestMessage, setS3TestMessage] = useState<string | null>(null);
  const [s3SourceObjectCount, setS3SourceObjectCount] = useState<number | null>(null);
  const [s3SourceCountTruncated, setS3SourceCountTruncated] = useState(false);
  /** Cumulative objects copied in the current run (since last successful test). */
  const [s3CopiedSoFar, setS3CopiedSoFar] = useState(0);
  /** True while the auto-copy loop is running batches automatically. */
  const [s3CopyRunning, setS3CopyRunning] = useState(false);
  /** Ref-based stop flag — checked between batches to allow the user to stop. */
  const s3StopRef = useRef(false);
  /** Accumulated list of {sourceKey, destKey} for the downloadable CSV report. */
  const [s3CopyReport, setS3CopyReport] = useState<{ sourceKey: string; destKey: string }[]>([]);
  /** True once a full copy run finishes (done=true from server). */
  const [s3CopyComplete, setS3CopyComplete] = useState(false);

  /* ------ Delete section state ------ */
  const [delExpanded, setDelExpanded] = useState(false);
  const [delRegion, setDelRegion] = useState('');
  const [delBucket, setDelBucket] = useState('');
  const [delPrefix, setDelPrefix] = useState('');
  const [delAccessKeyId, setDelAccessKeyId] = useState('');
  const [delSecretAccessKey, setDelSecretAccessKey] = useState('');
  const [delRunning, setDelRunning] = useState(false);
  const [delLog, setDelLog] = useState<string[]>([]);
  const [delCursor, setDelCursor] = useState<string | undefined>(undefined);
  const delStopRef = useRef(false);
  const [delTotalDeleted, setDelTotalDeleted] = useState(0);
  const [delComplete, setDelComplete] = useState(false);

  const invalidateS3Connection = useCallback(() => {
    setS3ConnectionOk(false);
    setS3TestMessage(null);
    setS3SourceObjectCount(null);
    setS3SourceCountTruncated(false);
    setS3CopiedSoFar(0);
    setCursor(undefined);
    setS3CopyReport([]);
    setS3CopyComplete(false);
  }, []);

  const s3PayloadBase = useCallback(
    () => ({
      region,
      sourceBucket: srcBucket,
      sourcePrefix: srcPrefix,
      destBucket: dstBucket,
      destPrefix: dstPrefix,
      destRegion: destRegion.trim() || undefined,
      sourceAccessKeyId: sourceAccessKeyId.trim(),
      sourceSecretAccessKey: sourceSecretAccessKey.trim(),
      destAccessKeyId: destAccessKeyId.trim() || undefined,
      destSecretAccessKey: destSecretAccessKey.trim() || undefined,
    }),
    [
      region,
      srcBucket,
      srcPrefix,
      dstBucket,
      dstPrefix,
      destRegion,
      sourceAccessKeyId,
      sourceSecretAccessKey,
      destAccessKeyId,
      destSecretAccessKey,
    ]
  );

  const clearS3Secrets = () => {
    setSourceAccessKeyId('');
    setSourceSecretAccessKey('');
    setDestAccessKeyId('');
    setDestSecretAccessKey('');
    setS3ConnectionOk(false);
    setS3TestMessage(null);
    setS3SourceObjectCount(null);
    setS3SourceCountTruncated(false);
    setS3CopiedSoFar(0);
    setCursor(undefined);
    setS3CopyRunning(false);
    s3StopRef.current = false;
  };

  /** After a successful full copy: clear AWS keys from the form; keep counts + report for progress readout and CSV. */
  const clearS3CredentialFieldsAfterSuccess = useCallback(() => {
    setSourceAccessKeyId('');
    setSourceSecretAccessKey('');
    setDestAccessKeyId('');
    setDestSecretAccessKey('');
    setS3ConnectionOk(false);
    setS3TestMessage(null);
    setCursor(undefined);
  }, []);

  const runPreview = async () => {
    const oldP = oldUrl.trim();
    const newP = newUrl.trim();
    if (!oldP || !newP) {
      setPreview(null);
      setLogVariant('danger');
      setLog('Old URL prefix and new URL prefix are required. Fill both fields (no blank-only values).');
      return;
    }
    setUrlBusy(true);
    setLog(null);
    setPreview(null);
    try {
      const r = await postMigrationPreview(oldP, newP);
      setPreview(r);
      setLog(null);
    } catch (e) {
      setPreview(null);
      setLogVariant('danger');
      setLog(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setUrlBusy(false);
    }
  };

  const runReplace = async () => {
    const oldP = oldUrl.trim();
    const newP = newUrl.trim();
    if (!oldP || !newP) {
      setLogVariant('danger');
      setLog('Old URL prefix and new URL prefix are required before applying a replace.');
      return;
    }
    if (!window.confirm('This will rewrite URLs in the database. Make sure you have a backup. Continue?')) return;
    setUrlBusy(true);
    setLog(null);
    try {
      const r = await postMigrationReplaceUrls(oldP, newP);
      setLogVariant('success');
      setLog(`Updated ${r.updated} row(s). Preview had matched ${r.previewMatchCount}.`);
    } catch (e) {
      setLogVariant('danger');
      setLog(e instanceof Error ? e.message : 'Replace failed');
    } finally {
      setUrlBusy(false);
    }
  };

  const runS3TestConnection = async () => {
    if (!s3FormReady) {
      setS3ConnectionOk(false);
      setS3TestMessage('Fill every required source field and the destination bucket before testing.');
      return;
    }
    setS3TestBusy(true);
    setS3TestMessage(null);
    try {
      const r = await postS3TestConnection(s3PayloadBase());
      setS3ConnectionOk(r.ok);
      setS3TestMessage(r.message);
      if (r.ok) {
        // A fresh successful test always re-enables Start copy, even after a previous completed run.
        setS3CopyComplete(false);
        setS3CopiedSoFar(0);
        setCursor(undefined);
        setS3CopyReport([]);
        if (typeof r.sourceObjectCount === 'number') {
          setS3SourceObjectCount(r.sourceObjectCount);
          setS3SourceCountTruncated(Boolean(r.sourceObjectCountTruncated));
        } else {
          setS3SourceObjectCount(null);
          setS3SourceCountTruncated(false);
        }
      } else {
        setS3CopiedSoFar(0);
        setCursor(undefined);
        setS3SourceObjectCount(null);
        setS3SourceCountTruncated(false);
      }
    } catch (e) {
      setS3ConnectionOk(false);
      setS3TestMessage(e instanceof Error ? e.message : 'Test failed');
      setS3CopiedSoFar(0);
      setCursor(undefined);
      setS3SourceObjectCount(null);
      setS3SourceCountTruncated(false);
    } finally {
      setS3TestBusy(false);
    }
  };

  const startS3Copy = async () => {
    if (!s3FormReady || !s3ConnectionOk) return;
    s3StopRef.current = false;
    setS3CopyRunning(true);
    setS3CopyComplete(false);
    const copyStartedAt = Date.now();

    let token: string | undefined = cursor;
    const payload = s3PayloadBase();

    try {
      while (true) {
        if (s3StopRef.current) {
          const elapsedSec = ((Date.now() - copyStartedAt) / 1000).toFixed(1);
          setCopyLog((p) => [
            ...p,
            logLine(`Stopped by user after ${elapsedSec}s. Click Resume copy to continue from where it left off.`),
          ]);
          break;
        }

        const r = await postS3CopyBatch({ ...payload, continuationToken: token, maxKeys: 100 });

        // Use payload fields explicitly (same object sent to the API) — matches server key join rules.
        const sourcePrefix = payload.sourcePrefix ?? '';
        const destPrefix = payload.destPrefix ?? '';
        const batchReport = r.copiedKeys.map((key: string) => {
          const rel = relativeKeyFromSource(key, sourcePrefix);
          return { sourceKey: key, destKey: joinDestObjectKey(destPrefix, rel) };
        });
        setS3CopyReport((prev) => [...prev, ...batchReport]);

        token = r.done ? undefined : r.nextContinuationToken;
        setCursor(token);
        setS3CopiedSoFar((prev) => {
          if (r.done && s3SourceObjectCount != null) return s3SourceObjectCount;
          return prev + r.copiedKeys.length;
        });
        setCopyLog((p) => [...p, logLine(`Batch: listed ${r.listed}, copied ${r.copiedKeys.length}. Done = ${String(r.done)}`)]);

        if (r.done) {
          setS3CopyComplete(true);
          const elapsedMs = Date.now() - copyStartedAt;
          const elapsedStr =
            elapsedMs >= 60_000
              ? `${(elapsedMs / 60_000).toFixed(1)} min`
              : `${(elapsedMs / 1000).toFixed(1)} s`;
          setCopyLog((p) => [
            ...p,
            logLine(`All objects copied successfully in ${elapsedStr}. Credentials cleared. Download the report below.`),
          ]);
          clearS3CredentialFieldsAfterSuccess();
          break;
        }
      }
    } catch (e) {
      const elapsedSec = ((Date.now() - copyStartedAt) / 1000).toFixed(1);
      setCopyLog((p) => [...p, logLine(`${e instanceof Error ? e.message : 'S3 copy failed'} (after ${elapsedSec}s)`)]);
    } finally {
      setS3CopyRunning(false);
    }
  };

  const stopS3Copy = () => {
    s3StopRef.current = true;
  };

  const prefillDeleteFromDest = () => {
    setDelRegion(destRegion.trim() || region.trim());
    setDelBucket(dstBucket.trim());
    setDelPrefix(dstPrefix.trim());
    setDelAccessKeyId(destAccessKeyId.trim() || sourceAccessKeyId.trim());
    setDelSecretAccessKey(destSecretAccessKey.trim() || sourceSecretAccessKey.trim());
  };

  const startDelete = async () => {
    if (!delRegion.trim() || !delBucket.trim() || !delAccessKeyId.trim() || !delSecretAccessKey.trim()) {
      setDelLog((p) => [...p, logLine('Region, bucket, access key ID and secret key are required.')]);
      return;
    }
    const targetDesc = delPrefix.trim() ? `"${delPrefix.trim()}"` : '(entire bucket)';
    if (
      !window.confirm(
        `This will PERMANENTLY DELETE all objects under ${targetDesc} in bucket "${delBucket.trim()}". This cannot be undone. Continue?`
      )
    )
      return;
    delStopRef.current = false;
    setDelRunning(true);
    setDelComplete(false);
    const startedAt = Date.now();
    let token = delCursor;
    let totalDeleted = delTotalDeleted;

    try {
      while (true) {
        if (delStopRef.current) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          setDelLog((p) => [
            ...p,
            logLine(`Stopped by user after ${elapsed}s. Click Delete objects to resume.`),
          ]);
          break;
        }
        const r = await postS3DeleteBatch({
          region: delRegion.trim(),
          bucket: delBucket.trim(),
          prefix: delPrefix.trim(),
          accessKeyId: delAccessKeyId.trim(),
          secretAccessKey: delSecretAccessKey.trim(),
          continuationToken: token,
        });
        totalDeleted += r.deleted;
        setDelTotalDeleted(totalDeleted);
        token = r.done ? undefined : r.nextContinuationToken;
        setDelCursor(token);
        setDelLog((p) => [
          ...p,
          logLine(`Batch: listed ${r.listed}, deleted ${r.deleted}. Done = ${String(r.done)}`),
        ]);
        if (r.done) {
          setDelComplete(true);
          const elapsed = Date.now() - startedAt;
          const elapsedStr = elapsed >= 60_000 ? `${(elapsed / 60_000).toFixed(1)} min` : `${(elapsed / 1000).toFixed(1)} s`;
          setDelLog((p) => [
            ...p,
            logLine(`Delete complete. ${totalDeleted} object${totalDeleted === 1 ? '' : 's'} deleted in ${elapsedStr}. Credentials cleared.`),
          ]);
          setDelAccessKeyId('');
          setDelSecretAccessKey('');
          break;
        }
      }
    } catch (e) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      setDelLog((p) => [...p, logLine(`${e instanceof Error ? e.message : 'Delete failed'} (after ${elapsed}s)`)]);
    } finally {
      setDelRunning(false);
    }
  };

  const stopDelete = () => {
    delStopRef.current = true;
  };

  const resetDelete = () => {
    setDelCursor(undefined);
    setDelTotalDeleted(0);
    setDelComplete(false);
    setDelLog([]);
  };

  const downloadCsvReport = () => {
    if (s3CopyReport.length === 0) return;
    const header = '#,Source Key,Destination Key,Status';
    const rows = s3CopyReport.map(
      (r, i) => `${i + 1},${csvEscapeField(r.sourceKey)},${csvEscapeField(r.destKey)},Copied`
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `s3-copy-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /** Source: region, bucket, prefix (may be empty for whole bucket), and both source keys are required. Destination: bucket required; destination keys optional. */
  const s3FormReady = Boolean(
    region.trim() &&
      srcBucket.trim() &&
      sourceAccessKeyId.trim() &&
      sourceSecretAccessKey.trim() &&
      dstBucket.trim()
  );
  /** Disabled only when the connection test hasn't passed or a copy is already running/complete. URL-migration busy state is intentionally excluded. */
  const copyDisabled = !s3ConnectionOk || !s3FormReady || s3TestBusy || s3CopyComplete;
  const s3FieldsLocked = urlBusy || s3TestBusy || s3CopyRunning;
  const urlFormReady = Boolean(oldUrl.trim() && newUrl.trim());
  const s3TestSuccessDetail =
    s3ConnectionOk && s3TestMessage ? s3ConnectionSuccessDetail(s3TestMessage) : null;

  const s3TotalForProgress = s3SourceObjectCount ?? 0;
  const s3CopyProgressPct =
    s3TotalForProgress > 0 ? Math.min(100, Math.round((s3CopiedSoFar / s3TotalForProgress) * 100)) : 0;

  return (
    <Flex direction="column" alignItems="stretch" gap={4}>

      {/* --- URL migration card --- */}
      <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
        <Flex direction="column" alignItems="stretch" gap={5}>
          <Box>
            <Typography variant="delta" tag="h2">URL migration</Typography>
            <Box paddingTop={1}>
              <Typography variant="omega" textColor="neutral600">
                Rewrite the URL prefix stored on every media record (including format thumbnails).
                This updates the database only — files in storage are not moved.
              </Typography>
            </Box>
          </Box>

          <Divider />

          <div style={gridRow}>
            <Field.Root name="oldUrlPrefix" hint="The current prefix you want to replace.">
              <Field.Label>
                Old URL prefix
                <RequiredMark />
              </Field.Label>
              <Field.Input
                value={oldUrl}
                onChange={(e: ChangeEvent<HTMLInputElement>) => { setOldUrl(e.target.value); setLog(null); setPreview(null); }}
                placeholder="https://staging-cdn.example.com"
                disabled={urlBusy}
                required
              />
              <Field.Hint />
            </Field.Root>
            <Field.Root name="newUrlPrefix" hint="The new prefix that will replace the old one.">
              <Field.Label>
                New URL prefix
                <RequiredMark />
              </Field.Label>
              <Field.Input
                value={newUrl}
                onChange={(e: ChangeEvent<HTMLInputElement>) => { setNewUrl(e.target.value); setLog(null); setPreview(null); }}
                placeholder="https://prod-cdn.example.com"
                disabled={urlBusy}
                required
              />
              <Field.Hint />
            </Field.Root>
          </div>

          {preview !== null && (
            <Box padding={4} background="neutral100" hasRadius borderColor="neutral150" borderStyle="solid" borderWidth="1px">
              <Typography variant="omega" textColor="neutral800" fontWeight="bold">
                {preview.matchCount} matching media record{preview.matchCount === 1 ? '' : 's'}
              </Typography>
              <Box paddingTop={1}>
                <Typography variant="pi" textColor="neutral600">
                  Preview is ready. Use Apply URL replace only after you have verified the prefixes.
                </Typography>
              </Box>
            </Box>
          )}

          <Flex gap={2}>
            <Button variant="secondary" onClick={() => void runPreview()} loading={urlBusy} disabled={!urlFormReady}>
              Preview matches
            </Button>
            <Button variant="danger" onClick={() => void runReplace()} loading={urlBusy} disabled={!urlFormReady}>
              Apply URL replace
            </Button>
          </Flex>
        </Flex>
      </Box>

      {/* --- S3 copy card --- */}
      <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
        <Flex direction="column" alignItems="stretch" gap={5}>
          <Box>
            <Typography variant="delta" tag="h2">S3 batch copy</Typography>
            <Box paddingTop={1}>
              <Typography variant="omega" textColor="neutral600">
                Every field under Source is required (including both source access keys). Under Destination, only
                the access key ID and secret access key are optional — leave both blank to run CopyObject with the
                source credentials (for example when the source principal is allowed to write to the destination bucket).
                Values are sent per request only and are not stored. Run Test connection first — Run copy batch stays
                disabled until the test succeeds.
              </Typography>
            </Box>
          </Box>

          <Divider />

          {/* Source: read + list identity (required) */}
          <Box
            padding={5}
            background="neutral100"
            borderColor="neutral150"
            borderStyle="solid"
            borderWidth="1px"
            hasRadius
          >
            <Flex direction="column" alignItems="stretch" gap={4}>
              <Box>
                <Typography variant="delta" tag="h3">Source</Typography>
                <Box paddingTop={1}>
                  <Typography variant="pi" textColor="neutral600">
                    Region, bucket, key prefix, and source AWS keys are required. Prefix may be empty to list the whole bucket.
                  </Typography>
                </Box>
              </Box>

              <Field.Root name="region" hint="Use the region where the source bucket lives.">
                <Field.Label>
                  Source AWS region
                  <RequiredMark />
                </Field.Label>
                <Field.Input
                  value={region}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => { setRegion(e.target.value); invalidateS3Connection(); }}
                  placeholder="ap-south-1"
                  disabled={s3FieldsLocked}
                  required
                />
                <Field.Hint />
              </Field.Root>

              <div style={gridRow}>
                <Field.Root name="srcBucket" hint="Bucket you are copying from.">
                  <Field.Label>
                    Source bucket
                    <RequiredMark />
                  </Field.Label>
                  <Field.Input
                    value={srcBucket}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { setSrcBucket(e.target.value); invalidateS3Connection(); }}
                    placeholder="my-source-bucket"
                    disabled={s3FieldsLocked}
                    required
                  />
                  <Field.Hint />
                </Field.Root>
                <Field.Root
                  name="srcPrefix"
                  hint="Only keys starting with this prefix are listed. Leave empty to include the entire bucket."
                >
                  <Field.Label>Source key prefix (required field; may be empty)</Field.Label>
                  <Field.Input
                    value={srcPrefix}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { setSrcPrefix(e.target.value); invalidateS3Connection(); }}
                    placeholder="uploads/"
                    disabled={s3FieldsLocked}
                  />
                  <Field.Hint />
                </Field.Root>
              </div>

              <div style={gridRow}>
                <Field.Root
                  name="sourceAccessKeyId"
                  hint="IAM user or key that can list and read objects in the source bucket."
                >
                  <Field.Label>
                    Source access key ID
                    <RequiredMark />
                  </Field.Label>
                  <Field.Input
                    value={sourceAccessKeyId}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { setSourceAccessKeyId(e.target.value); invalidateS3Connection(); }}
                    placeholder="e.g. AKIAIOSFODNN7EXAMPLE"
                    disabled={s3FieldsLocked}
                    autoComplete="off"
                    required
                  />
                  <Field.Hint />
                </Field.Root>
                <Field.Root name="sourceSecretAccessKey" hint="The secret that pairs with the access key ID above.">
                  <Field.Label>
                    Source secret access key
                    <RequiredMark />
                  </Field.Label>
                  <Field.Input
                    type="password"
                    value={sourceSecretAccessKey}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { setSourceSecretAccessKey(e.target.value); invalidateS3Connection(); }}
                    placeholder="Your source secret access key"
                    disabled={s3FieldsLocked}
                    autoComplete="off"
                    required
                  />
                  <Field.Hint />
                </Field.Root>
              </div>
            </Flex>
          </Box>

          {/* Destination: write target; only access keys optional */}
          <Box
            padding={5}
            background="neutral100"
            borderColor="neutral150"
            borderStyle="solid"
            borderWidth="1px"
            hasRadius
          >
            <Flex direction="column" alignItems="stretch" gap={4}>
              <Box>
                <Typography variant="delta" tag="h3">Destination</Typography>
                <Box paddingTop={1}>
                  <Typography variant="pi" textColor="neutral600">
                    Bucket, optional destination region (defaults to the source region if empty), and optional prefix
                    define where objects are written. Destination access key and secret are optional — leave both blank
                    to perform CopyObject with the source credentials above.
                  </Typography>
                </Box>
              </Box>

              <div style={gridRow}>
                <Field.Root name="dstBucket" hint="Bucket you are copying into.">
                  <Field.Label>
                    Destination bucket
                    <RequiredMark />
                  </Field.Label>
                  <Field.Input
                    value={dstBucket}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { setDstBucket(e.target.value); invalidateS3Connection(); }}
                    placeholder="my-dest-bucket"
                    disabled={s3FieldsLocked}
                    required
                  />
                  <Field.Hint />
                </Field.Root>
                <Field.Root
                  name="destRegion"
                  hint="AWS region where the destination bucket exists. Leave blank to use the same region as the source."
                >
                  <Field.Label>Destination AWS region (optional)</Field.Label>
                  <Field.Input
                    value={destRegion}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { setDestRegion(e.target.value); invalidateS3Connection(); }}
                    placeholder="eu-west-1"
                    disabled={s3FieldsLocked}
                  />
                  <Field.Hint />
                </Field.Root>
              </div>
              <Field.Root
                name="dstPrefix"
                hint="Folder under the destination bucket. A trailing slash is added automatically — e.g. entering backup copies source objects into backup/upload/a.webp."
              >
                <Field.Label>Destination key prefix (optional)</Field.Label>
                <Field.Input
                  value={dstPrefix}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => { setDstPrefix(e.target.value); invalidateS3Connection(); }}
                  placeholder="uploads/"
                  disabled={s3FieldsLocked}
                />
                <Field.Hint />
              </Field.Root>

              <Divider />

              <Typography variant="omega" textColor="neutral700" fontWeight="bold">
                Destination AWS credentials (optional)
              </Typography>
              <div style={gridRow}>
                <Field.Root
                  name="destAccessKeyId"
                  hint="Provide both destination keys, or leave both empty to reuse source keys for writes."
                >
                  <Field.Label>Destination access key ID (optional)</Field.Label>
                  <Field.Input
                    value={destAccessKeyId}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { setDestAccessKeyId(e.target.value); invalidateS3Connection(); }}
                    placeholder="e.g. AKIAIOSFODNN7EXAMPLE"
                    disabled={s3FieldsLocked}
                    autoComplete="off"
                  />
                  <Field.Hint />
                </Field.Root>
                <Field.Root name="destSecretAccessKey" hint="The secret that pairs with the destination access key ID.">
                  <Field.Label>Destination secret access key (optional)</Field.Label>
                  <Field.Input
                    type="password"
                    value={destSecretAccessKey}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { setDestSecretAccessKey(e.target.value); invalidateS3Connection(); }}
                    placeholder="Your destination secret access key"
                    disabled={s3FieldsLocked}
                    autoComplete="off"
                  />
                  <Field.Hint />
                </Field.Root>
              </div>
            </Flex>
          </Box>

          {s3TestMessage && (
            <Alert
              title={s3ConnectionOk ? 'Connection OK' : 'Connection check'}
              variant={s3ConnectionOk ? 'success' : 'danger'}
              closeLabel="Dismiss"
              onClose={() => setS3TestMessage(null)}
            >
              {s3ConnectionOk ? (
                s3TestSuccessDetail ? (
                  <Typography variant="omega" textColor="neutral600">
                    {s3TestSuccessDetail}
                  </Typography>
                ) : null
              ) : (
                s3TestMessage
              )}
            </Alert>
          )}

          {(s3ConnectionOk || s3CopyComplete) && s3SourceObjectCount !== null && (
            <Box
              padding={4}
              background="neutral100"
              hasRadius
              borderColor="neutral150"
              borderStyle="solid"
              borderWidth="1px"
            >
              <Typography variant="omega" textColor="neutral800" fontWeight="bold">
                {s3SourceObjectCount.toLocaleString()} object
                {s3SourceObjectCount === 1 ? '' : 's'} in the source
                {srcPrefix.trim() ? ` (prefix "${srcPrefix.trim()}")` : ' (entire bucket)'} will be copied to the
                destination in batches.
              </Typography>
              {s3SourceCountTruncated && (
                <Box paddingTop={2}>
                  <Typography variant="pi" textColor="warning600">
                    Count hit the server safety limit; the true total may be higher. Re-run Test connection after
                    narrowing the prefix if needed.
                  </Typography>
                </Box>
              )}

              <Divider marginTop={4} marginBottom={4} />

              <Typography variant="sigma" textColor="neutral700" fontWeight="bold" tag="h4">
                Copy progress
              </Typography>
              <Box paddingTop={2} width="100%">
                <ProgressBar value={s3CopyProgressPct} max={100} />
              </Box>
              <Box paddingTop={2}>
                <Typography variant="pi" textColor="neutral600">
                  {s3TotalForProgress === 0
                    ? 'No objects to copy under this prefix.'
                    : `${s3CopiedSoFar.toLocaleString()} / ${s3TotalForProgress.toLocaleString()} object${
                        s3TotalForProgress === 1 ? '' : 's'
                      } copied (${s3CopyProgressPct}%${s3SourceCountTruncated ? ', approximate total' : ''})`}
                </Typography>
              </Box>
            </Box>
          )}

          <Flex gap={2} alignItems="center" wrap="wrap">
            <Button
              variant="secondary"
              onClick={() => void runS3TestConnection()}
              loading={s3TestBusy}
              disabled={!s3FormReady || urlBusy || s3CopyRunning}
            >
              Test connection
            </Button>
            {s3CopyRunning ? (
              <Button variant="danger" onClick={stopS3Copy}>
                Stop
              </Button>
            ) : (
              <Button
                onClick={() => void startS3Copy()}
                loading={false}
                disabled={copyDisabled}
              >
                {cursor ? 'Resume copy' : 'Start copy'}
              </Button>
            )}
            {s3CopyComplete && (
              <Button
                variant="secondary"
                onClick={() => {
                  setS3CopyComplete(false);
                  setS3CopiedSoFar(0);
                  setCursor(undefined);
                  setS3CopyReport([]);
                  setCopyLog([]);
                }}
              >
                New copy
              </Button>
            )}
            {s3CopyComplete && s3CopyReport.length > 0 && (
              <Button variant="secondary" onClick={downloadCsvReport}>
                Download report (CSV)
              </Button>
            )}
            {s3CopyRunning && (
              <Typography variant="pi" textColor="neutral600">
                Copying in progress — batches run automatically. Click Stop to pause.
              </Typography>
            )}
          </Flex>

          {copyLog.length > 0 && (
            <Box
              padding={3}
              background="neutral100"
              hasRadius
              style={{ maxHeight: 240, overflowY: 'auto', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}
            >
              {copyLog.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </Box>
          )}
        </Flex>
      </Box>

      {/* --- Delete danger zone --- */}
      <Box background="neutral0" padding={6} hasRadius shadow="filterShadow" borderColor="danger200" borderStyle="solid" borderWidth="1px">
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Flex justifyContent="space-between" alignItems="center">
            <Box>
              <Typography variant="delta" tag="h2" textColor="danger600">Danger zone: delete objects from bucket</Typography>
              <Box paddingTop={1}>
                <Typography variant="omega" textColor="neutral600">
                  Permanently remove all objects under a given bucket prefix. Use to clean up partially copied data before retrying.
                  Requires <code>s3:ListBucket</code> + <code>s3:DeleteObject</code>. Credentials are cleared after completion.
                </Typography>
              </Box>
            </Box>
            <Button
              variant="ghost"
              onClick={() => setDelExpanded((x) => !x)}
              style={{ flexShrink: 0, marginLeft: 16 }}
            >
              {delExpanded ? 'Collapse' : 'Expand'}
            </Button>
          </Flex>

          {delExpanded && (
            <>
              <Divider />

              <Flex gap={2} wrap="wrap">
                <Button
                  variant="tertiary"
                  size="S"
                  onClick={prefillDeleteFromDest}
                  disabled={delRunning}
                >
                  Pre-fill from destination fields above
                </Button>
                {(delLog.length > 0 || delTotalDeleted > 0) && (
                  <Button variant="ghost" size="S" onClick={resetDelete} disabled={delRunning}>
                    Reset log
                  </Button>
                )}
              </Flex>

              <div style={gridRow}>
                <Field.Root name="delRegion" hint="AWS region where the target bucket lives. e.g. ap-south-1, us-east-1">
                  <Field.Label>AWS region<RequiredMark /></Field.Label>
                  <Field.Input
                    value={delRegion}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setDelRegion(e.target.value)}
                    placeholder="e.g. ap-south-1"
                    disabled={delRunning}
                    required
                  />
                  <Field.Hint />
                </Field.Root>
                <Field.Root name="delBucket" hint="Name of the S3 bucket to delete objects from.">
                  <Field.Label>Bucket<RequiredMark /></Field.Label>
                  <Field.Input
                    value={delBucket}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setDelBucket(e.target.value)}
                    placeholder="e.g. my-media-bucket"
                    disabled={delRunning}
                    required
                  />
                  <Field.Hint />
                </Field.Root>
              </div>

              <Field.Root name="delPrefix" hint="Only objects whose key starts with this prefix are deleted. Leave empty to delete the entire bucket (use with extreme caution).">
                <Field.Label>Key prefix (optional)</Field.Label>
                <Field.Input
                  value={delPrefix}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setDelPrefix(e.target.value)}
                  placeholder="e.g. backup/ or migration-archive/"
                  disabled={delRunning}
                />
                <Field.Hint />
              </Field.Root>

              <div style={gridRow}>
                <Field.Root name="delAccessKeyId" hint="IAM identity that has s3:ListBucket + s3:DeleteObject on the target bucket.">
                  <Field.Label>Access key ID<RequiredMark /></Field.Label>
                  <Field.Input
                    value={delAccessKeyId}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setDelAccessKeyId(e.target.value)}
                    placeholder="e.g. AKIAIOSFODNN7EXAMPLE"
                    disabled={delRunning}
                    autoComplete="off"
                    required
                  />
                  <Field.Hint />
                </Field.Root>
                <Field.Root name="delSecretAccessKey" hint="The secret that pairs with the access key ID above.">
                  <Field.Label>Secret access key<RequiredMark /></Field.Label>
                  <Field.Input
                    type="password"
                    value={delSecretAccessKey}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setDelSecretAccessKey(e.target.value)}
                    placeholder="Your secret access key"
                    disabled={delRunning}
                    autoComplete="off"
                    required
                  />
                  <Field.Hint />
                </Field.Root>
              </div>

              {delTotalDeleted > 0 && (
                <Typography variant="omega" textColor="danger600">
                  {delTotalDeleted.toLocaleString()} object{delTotalDeleted === 1 ? '' : 's'} deleted so far
                  {delComplete ? ' (complete)' : ' (in progress)'}
                </Typography>
              )}

              <Flex gap={2} alignItems="center">
                {delRunning ? (
                  <Button variant="danger" onClick={stopDelete}>Stop</Button>
                ) : (
                  <Button
                    variant="danger"
                    onClick={() => void startDelete()}
                    disabled={!delRegion.trim() || !delBucket.trim() || !delAccessKeyId.trim() || !delSecretAccessKey.trim() || delComplete}
                  >
                    {delCursor ? 'Resume delete' : 'Delete objects'}
                  </Button>
                )}
                {delComplete && (
                  <Button variant="secondary" onClick={resetDelete}>Reset</Button>
                )}
              </Flex>

              {delLog.length > 0 && (
                <Box
                  padding={3}
                  background="neutral100"
                  hasRadius
                  style={{ maxHeight: 200, overflowY: 'auto', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}
                >
                  {delLog.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </Box>
              )}
            </>
          )}
        </Flex>
      </Box>

      {/* --- Alert bar --- */}
      {log && (
        <Alert title="Migration result" variant={logVariant} closeLabel="Dismiss" onClose={() => setLog(null)}>
          {log}
        </Alert>
      )}
    </Flex>
  );
};

/* ------------------------------------------------------------------ */
/*  Page shell                                                          */
/* ------------------------------------------------------------------ */

type TabKey = 'optimization' | 'migration';

const HomePage = () => {
  const [tab, setTab] = useState<TabKey>('optimization');

  return (
    <Layouts.Root>
      <Layouts.Header
        title="Media WebP & migration"
        subtitle="Configure WebP encoding for uploads and run operator-controlled migration helpers."
      />
      <Layouts.Content>
        <Tabs.Root variant="simple" value={tab} onValueChange={(v: string) => setTab(v as TabKey)}>
          <Tabs.List aria-label="Plugin sections">
            <Tabs.Trigger value="optimization">Upload optimization</Tabs.Trigger>
            <Tabs.Trigger value="migration">Migration</Tabs.Trigger>
          </Tabs.List>
          <Box paddingTop={6}>
            <Tabs.Content value="optimization">
              <UploadOptimizationPanel />
            </Tabs.Content>
            <Tabs.Content value="migration">
              <MigrationPanel />
            </Tabs.Content>
          </Box>
        </Tabs.Root>
      </Layouts.Content>
    </Layouts.Root>
  );
};

export { HomePage };
