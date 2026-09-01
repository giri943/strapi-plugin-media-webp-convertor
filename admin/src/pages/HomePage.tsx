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
  getLocalMigrationStats,
  postLocalMigrationTestConnection,
  postLocalMigrationBatch,
  getConversionStats,
  getConversionFiles,
  postConversionBatch,
  type ConversionStats,
  type ConversionFile,
  type SettingsLimits,
  type UploadLimitInfo,
} from '../utils/pluginRequest';

/* ------------------------------------------------------------------ */
/*  Upload optimization tab                                            */
/* ------------------------------------------------------------------ */

const UploadOptimizationPanel = () => {
  /** Ranges come from the server with the settings payload — never hardcoded here. */
  const [limits, setLimits] = useState<SettingsLimits>({
    minSvgSizeMb: 1,
    maxSvgSizeMb: 50,
    minWebpQuality: 1,
    maxWebpQuality: 100,
    supportedFileExtensions: [],
    supportedFileExtensionGroups: [],
    defaultFileExtensions: [],
  });
  const [uploadLimit, setUploadLimit] = useState<UploadLimitInfo | null>(null);
  const [quality, setQuality] = useState(82);
  const [enabled, setEnabled] = useState(true);
  const [pdfValidation, setPdfValidation] = useState(true);
  const [blockActiveContent, setBlockActiveContent] = useState(true);
  /** Held as a string so the field can be cleared while typing; validated on save. */
  const [maxSvgSize, setMaxSvgSize] = useState('5');
  const [typePolicy, setTypePolicy] = useState(true);
  const [allowedExtensions, setAllowedExtensions] = useState<string[]>([]);
  const [blockMultiExt, setBlockMultiExt] = useState(true);
  const [randomizeNames, setRandomizeNames] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgVariant, setMsgVariant] = useState<'success' | 'danger'>('success');

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const { settings: s, limits: l, uploadLimit: ul } = await getSettings();
      setLimits(l);
      setUploadLimit(ul);
      setQuality(s.webpQuality);
      setEnabled(s.webpConversionEnabled);
      setPdfValidation(s.pdfValidationEnabled);
      setMaxSvgSize(String(s.maxSvgSizeMb));
      setBlockActiveContent(s.blockPdfActiveContent);
      setTypePolicy(s.fileTypePolicyEnabled);
      setAllowedExtensions(s.allowedFileExtensions ?? []);
      setBlockMultiExt(s.blockMultipleExtensions);
      setRandomizeNames(s.randomizeStoredFilenames);
    } catch (e) {
      setMsgVariant('danger');
      setMsg(e instanceof Error ? e.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleExtension = (ext: string, on: boolean) => {
    setAllowedExtensions((prev) => {
      const next = new Set(prev);
      if (on) next.add(ext);
      else next.delete(ext);
      return [...next].sort();
    });
  };

  const toggleGroup = (extensions: string[], on: boolean) => {
    setAllowedExtensions((prev) => {
      const next = new Set(prev);
      for (const ext of extensions) {
        if (on) next.add(ext);
        else next.delete(ext);
      }
      return [...next].sort();
    });
  };

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const parsedSvgSize = Number(maxSvgSize);
    if (
      !Number.isFinite(parsedSvgSize) ||
      parsedSvgSize < limits.minSvgSizeMb ||
      parsedSvgSize > limits.maxSvgSizeMb
    ) {
      setMsgVariant('danger');
      setMsg(`Maximum SVG size must be between ${limits.minSvgSizeMb} and ${limits.maxSvgSizeMb} MB.`);
      return;
    }
    if (typePolicy && allowedExtensions.length === 0) {
      setMsgVariant('danger');
      setMsg('Select at least one allowed file type, or turn the allow-list off.');
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const saved = await putSettings({
        webpQuality: quality,
        webpConversionEnabled: enabled,
        pdfValidationEnabled: pdfValidation,
        maxSvgSizeMb: parsedSvgSize,
        blockPdfActiveContent: blockActiveContent,
        fileTypePolicyEnabled: typePolicy,
        allowedFileExtensions: allowedExtensions,
        blockMultipleExtensions: blockMultiExt,
        randomizeStoredFilenames: randomizeNames,
      });
      setMaxSvgSize(String(saved.maxSvgSizeMb));
      setAllowedExtensions(saved.allowedFileExtensions ?? []);
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
                min={limits.minWebpQuality}
                max={limits.maxWebpQuality}
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

        <Divider />

        <Box>
          <Typography variant="delta" tag="h2">Document validation</Typography>
          <Box paddingTop={1}>
            <Typography variant="omega" textColor="neutral600">
              PDF uploads are checked against their magic bytes — the file must start with the
              <code> %PDF-</code> signature and end with the <code>%%EOF</code> trailer. Files disguised
              as another type, and PDFs that are truncated or corrupt, are rejected before Strapi stores them.
            </Typography>
          </Box>
        </Box>

        <Checkbox
          checked={pdfValidation}
          onCheckedChange={(v: boolean | 'indeterminate') => setPdfValidation(v === true)}
          disabled={loading || saving}
        >
          Validate PDF uploads
        </Checkbox>

        <Box>
          <Checkbox
            checked={blockActiveContent}
            onCheckedChange={(v: boolean | 'indeterminate') => setBlockActiveContent(v === true)}
            disabled={loading || saving || !pdfValidation}
          >
            Reject PDFs containing JavaScript or launch actions
          </Checkbox>
          <Box paddingTop={1}>
            <Typography variant="pi" textColor="neutral500">
              Covers compressed PDFs too, at any file size — the scan streams, so a large PDF is
              checked as thoroughly as a small one. Interactive PDF forms that use scripts for field
              validation will be rejected — untick this if you need to publish one.
            </Typography>
          </Box>
        </Box>

        <Divider />

        <Box>
          <Typography variant="delta" tag="h2">Upload size</Typography>
          <Box paddingTop={1}>
            <Typography variant="omega" textColor="neutral600">
              The plugin applies no size limit of its own — it uses whatever your project allows, so
              there is one value to change and one place to change it.
            </Typography>
          </Box>
        </Box>

        <Box padding={4} background="neutral100" hasRadius>
          {uploadLimit ? (
            <>
              <Typography variant="omega" fontWeight="bold" textColor="neutral800">
                Maximum upload size: {uploadLimit.formatted}
              </Typography>
              <Box paddingTop={1}>
                <Typography variant="pi" textColor="neutral600">
                  Inherited from {uploadLimit.source}. To change it, set{' '}
                  <code>formidable.maxFileSize</code> on <code>strapi::body</code> in{' '}
                  <code>config/middlewares.ts</code> and restart Strapi.
                </Typography>
              </Box>
            </>
          ) : (
            <Typography variant="omega" textColor="neutral600">
              Upload size limit is set by your project configuration.
            </Typography>
          )}
        </Box>

        <Box>
          <Field.Root
            name="maxSvgSizeMb"
            hint={`SVGs above this are rejected. ${limits.minSvgSizeMb}–${limits.maxSvgSizeMb} MB. Default 5.`}
          >
            <Field.Label>Maximum SVG size (MB)</Field.Label>
            <Box style={{ maxWidth: 200 }}>
              <Field.Input
                type="number"
                min={limits.minSvgSizeMb}
                max={limits.maxSvgSizeMb}
                step={1}
                value={maxSvgSize}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setMaxSvgSize(e.target.value)}
                disabled={loading || saving}
              />
            </Box>
            <Field.Hint />
          </Field.Root>
          <Box paddingTop={1}>
            <Typography variant="pi" textColor="neutral500">
              The one exception to the inherited limit. SVG rules are matched against the whole
              decoded document, so it has to be read in full — and a multi-megabyte SVG is
              machine-generated junk or an attack rather than artwork.
            </Typography>
          </Box>
        </Box>

        <Divider />

        <Box>
          <Typography variant="delta" tag="h2">File type policy</Typography>
          <Box paddingTop={1}>
            <Typography variant="omega" textColor="neutral600">
              Default-deny: only the types ticked below are accepted, and each upload's bytes must
              match the extension it claims. This is what stops an executable or a script from being
              stored under an image name — Strapi itself does not restrict upload types.
            </Typography>
          </Box>
        </Box>

        <Checkbox
          checked={typePolicy}
          onCheckedChange={(v: boolean | 'indeterminate') => setTypePolicy(v === true)}
          disabled={loading || saving}
        >
          Enforce the file type allow-list
        </Checkbox>

        {!typePolicy && (
          <Box
            padding={4}
            background="danger100"
            hasRadius
            borderColor="danger200"
            borderStyle="solid"
            borderWidth="1px"
          >
            <Typography variant="omega" fontWeight="bold" textColor="danger600">
              Uploads are unrestricted
            </Typography>
            <Box paddingTop={1}>
              <Typography variant="omega" textColor="danger600">
                With this off, any file type can be uploaded — including executables and server-side
                scripts. Only turn it off temporarily, while auditing which types your editors need.
              </Typography>
            </Box>
          </Box>
        )}

        <Box>
          <Flex justifyContent="space-between" alignItems="baseline" wrap="wrap" gap={2}>
            <Typography variant="omega" fontWeight="bold" textColor="neutral800">
              Allowed types ({allowedExtensions.length} selected)
            </Typography>
            <Button
              variant="tertiary"
              onClick={() => setAllowedExtensions([...limits.defaultFileExtensions].sort())}
              disabled={loading || saving || !typePolicy || limits.defaultFileExtensions.length === 0}
            >
              Reset to recommended
            </Button>
          </Flex>

          <Box paddingTop={3}>
            <Flex direction="column" alignItems="stretch" gap={4}>
              {limits.supportedFileExtensionGroups.map((group) => {
                const allOn = group.extensions.every((e) => allowedExtensions.includes(e));
                return (
                  <Box
                    key={group.group}
                    padding={3}
                    background="neutral100"
                    hasRadius
                    borderColor="neutral150"
                    borderStyle="solid"
                    borderWidth="1px"
                  >
                    <Checkbox
                      checked={allOn}
                      onCheckedChange={(v: boolean | 'indeterminate') =>
                        toggleGroup(group.extensions, v === true)
                      }
                      disabled={loading || saving || !typePolicy}
                    >
                      <Typography variant="omega" fontWeight="bold">{group.label}</Typography>
                    </Checkbox>
                    <Box paddingTop={2} paddingLeft={6}>
                      <Flex wrap="wrap" gap={4}>
                        {group.extensions.map((ext) => (
                          <Box key={ext} style={{ minWidth: 96 }}>
                            <Checkbox
                              checked={allowedExtensions.includes(ext)}
                              onCheckedChange={(v: boolean | 'indeterminate') =>
                                toggleExtension(ext, v === true)
                              }
                              disabled={loading || saving || !typePolicy}
                            >
                              .{ext}
                            </Checkbox>
                          </Box>
                        ))}
                      </Flex>
                    </Box>
                  </Box>
                );
              })}
            </Flex>
          </Box>

          <Box paddingTop={2}>
            <Typography variant="pi" textColor="neutral500">
              Legacy <code>.doc</code> / <code>.xls</code> / <code>.ppt</code> and macro-enabled
              Office files are not offered: they are OLE containers that can carry VBA macros, and
              that container is rejected on sight. Save as <code>.docx</code> / <code>.xlsx</code> /
              <code> .pptx</code> instead.
            </Typography>
          </Box>
        </Box>

        <Box>
          <Checkbox
            checked={blockMultiExt}
            onCheckedChange={(v: boolean | 'indeterminate') => setBlockMultiExt(v === true)}
            disabled={loading || saving || !typePolicy}
          >
            Reject filenames carrying more than one extension
          </Checkbox>
          <Box paddingTop={1}>
            <Typography variant="pi" textColor="neutral500">
              Refuses <code>invoice.svg.png</code> and <code>shell.php.jpg</code>. Ordinary names
              with dots in them, like <code>report.v1.2.pdf</code>, are unaffected — only a segment
              that is itself a file extension triggers this.
            </Typography>
          </Box>
        </Box>

        <Box>
          <Checkbox
            checked={randomizeNames}
            onCheckedChange={(v: boolean | 'indeterminate') => setRandomizeNames(v === true)}
            disabled={loading || saving}
          >
            Replace stored filenames with random names
          </Checkbox>
          <Box paddingTop={1}>
            <Typography variant="pi" textColor="neutral500">
              Removes the uploader's text from the URL and the media library entirely. Strapi already
              appends 10 random characters to every stored name, so URLs aren't guessable without
              this — turn it on only if you also want the original name gone.
            </Typography>
          </Box>
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

/* ------------------------------------------------------------------ */
/*  Local → S3 migration card                                          */
/* ------------------------------------------------------------------ */

const LocalMigrationCard = () => {
  const [localStats, setLocalStats] = useState<{ count: number; totalSizeMB: number } | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const [lmRegion, setLmRegion] = useState('');
  const [lmBucket, setLmBucket] = useState('');
  const [lmAccessKeyId, setLmAccessKeyId] = useState('');
  const [lmSecretAccessKey, setLmSecretAccessKey] = useState('');
  const [lmBaseUrl, setLmBaseUrl] = useState('');
  const [lmKeyPrefix, setLmKeyPrefix] = useState('');
  const [lmPreserveFolders, setLmPreserveFolders] = useState(false);
  const [lmDeleteLocal, setLmDeleteLocal] = useState(false);

  const [lmTestBusy, setLmTestBusy] = useState(false);
  const [lmConnectionOk, setLmConnectionOk] = useState(false);
  const [lmTestMessage, setLmTestMessage] = useState<string | null>(null);

  const [lmRunning, setLmRunning] = useState(false);
  const [lmDone, setLmDone] = useState(false);
  const [lmSucceeded, setLmSucceeded] = useState(0);
  const [lmFailed, setLmFailed] = useState(0);
  const [lmInitialTotal, setLmInitialTotal] = useState(0);
  const [lmLog, setLmLog] = useState<string[]>([]);
  const lmStopRef = useRef(false);
  const [lmLogsOpen, setLmLogsOpen] = useState(false);

  const loadLocalStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      setLocalStats(await getLocalMigrationStats());
    } catch {
      // silent
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => { void loadLocalStats(); }, [loadLocalStats]);

  const invalidateLmConnection = useCallback(() => {
    setLmConnectionOk(false);
    setLmTestMessage(null);
  }, []);

  const runLmTestConnection = async () => {
    setLmTestBusy(true);
    setLmTestMessage(null);
    try {
      const r = await postLocalMigrationTestConnection({
        region: lmRegion.trim(),
        bucket: lmBucket.trim(),
        accessKeyId: lmAccessKeyId.trim(),
        secretAccessKey: lmSecretAccessKey.trim(),
      });
      setLmConnectionOk(r.ok);
      setLmTestMessage(r.message);
      if (r.ok) {
        setLmDone(false);
        setLmSucceeded(0);
        setLmFailed(0);
        setLmLog([]);
      }
    } catch (e) {
      setLmConnectionOk(false);
      setLmTestMessage(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setLmTestBusy(false);
    }
  };

  const startLmMigration = async () => {
    const total = localStats?.count ?? 0;
    if (total === 0) return;
    const deleteWarning = lmDeleteLocal
      ? ' Local files will be permanently deleted after each successful upload.'
      : '';
    if (
      !window.confirm(
        `This will upload ${total.toLocaleString()} file${total === 1 ? '' : 's'} to S3 and update database URLs.${deleteWarning} Continue?`
      )
    )
      return;

    lmStopRef.current = false;
    setLmRunning(true);
    setLmLogsOpen(true);
    setLmDone(false);
    setLmSucceeded(0);
    setLmFailed(0);
    setLmInitialTotal(total);
    const startedAt = Date.now();
    let totalSucceeded = 0;
    let totalFailed = 0;

    const payload = {
      offset: 0,
      batchSize: 5,
      region: lmRegion.trim(),
      bucket: lmBucket.trim(),
      accessKeyId: lmAccessKeyId.trim(),
      secretAccessKey: lmSecretAccessKey.trim(),
      baseUrl: lmBaseUrl.trim(),
      keyPrefix: lmKeyPrefix.trim(),
      preserveFolders: lmPreserveFolders,
      deleteLocal: lmDeleteLocal,
    };

    try {
      while (true) {
        if (lmStopRef.current) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          setLmLog((p) => [...p, logLine(`Stopped by user after ${elapsed}s.`)]);
          break;
        }

        const r = await postLocalMigrationBatch(payload);
        totalSucceeded += r.succeeded;
        totalFailed += r.failed;
        setLmSucceeded(totalSucceeded);
        setLmFailed(totalFailed);
        setLmLog((p) => [
          ...p,
          logLine(`Batch: ${r.succeeded} uploaded, ${r.failed} failed. ${r.remaining} remaining.`),
        ]);

        if (r.done) {
          const elapsed = Date.now() - startedAt;
          const elapsedStr =
            elapsed >= 60_000
              ? `${(elapsed / 60_000).toFixed(1)} min`
              : `${(elapsed / 1000).toFixed(1)} s`;
          setLmLog((p) => [
            ...p,
            logLine(
              `Migration complete in ${elapsedStr}. ${totalSucceeded} file${totalSucceeded === 1 ? '' : 's'} uploaded. Credentials cleared.`
            ),
          ]);
          setLmDone(true);
          setLmConnectionOk(false);
          setLmTestMessage(null);
          setLmAccessKeyId('');
          setLmSecretAccessKey('');
          void loadLocalStats();
          break;
        }

        if (r.processed > 0 && r.succeeded === 0) {
          setLmLog((p) => [
            ...p,
            logLine('Entire batch failed — stopping to prevent a loop. Check errors and retry.'),
          ]);
          break;
        }
      }
    } catch (e) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      setLmLog((p) => [
        ...p,
        logLine(`${e instanceof Error ? e.message : 'Migration failed'} (after ${elapsed}s)`),
      ]);
    } finally {
      setLmRunning(false);
    }
  };

  const lmFormReady = Boolean(
    lmRegion.trim() && lmBucket.trim() && lmAccessKeyId.trim() && lmSecretAccessKey.trim() && lmBaseUrl.trim()
  );
  const lmProgressPct =
    lmInitialTotal > 0 ? Math.min(100, Math.round((lmSucceeded / lmInitialTotal) * 100)) : 0;

  return (
    <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
      <Flex direction="column" alignItems="stretch" gap={5}>
        <Box>
          <Typography variant="delta" tag="h2">Local → S3 migration</Typography>
          <Box paddingTop={1}>
            <Typography variant="omega" textColor="neutral600">
              Upload all locally stored media files to an S3 bucket and rewrite the database URLs.
              Format variants (thumbnail, small, medium, large) are migrated alongside each file.
              After migration, switch your upload provider to S3 in{' '}
              <code>config/plugins.ts</code> and restart Strapi.
            </Typography>
          </Box>
        </Box>

        <Divider />

        {statsLoading ? (
          <Typography variant="omega" textColor="neutral500">Checking local files…</Typography>
        ) : localStats ? (
          localStats.count === 0 ? (
            <Box padding={4} background="neutral100" hasRadius>
              <Typography variant="omega" textColor="neutral600">
                No local files detected — all media is already on an external provider.
              </Typography>
            </Box>
          ) : (
            <Box padding={4} background="neutral100" hasRadius>
              <Typography variant="omega" fontWeight="bold" textColor="neutral800">
                {localStats.count.toLocaleString()} local file{localStats.count === 1 ? '' : 's'} ·{' '}
                {localStats.totalSizeMB.toFixed(1)} MB
              </Typography>
              <Box paddingTop={1}>
                <Typography variant="pi" textColor="neutral600">
                  Stored in <code>public/uploads/</code>. All format variants are included.
                </Typography>
              </Box>
            </Box>
          )
        ) : null}

        <div style={gridRow}>
          <Field.Root name="lmRegion">
            <Field.Label>AWS region<RequiredMark /></Field.Label>
            <Field.Input
              value={lmRegion}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { setLmRegion(e.target.value); invalidateLmConnection(); }}
              placeholder="ap-south-1"
              disabled={lmRunning}
            />
          </Field.Root>
          <Field.Root name="lmBucket">
            <Field.Label>S3 bucket<RequiredMark /></Field.Label>
            <Field.Input
              value={lmBucket}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { setLmBucket(e.target.value); invalidateLmConnection(); }}
              placeholder="my-media-bucket"
              disabled={lmRunning}
            />
          </Field.Root>
        </div>

        <div style={gridRow}>
          <Field.Root name="lmAccessKeyId">
            <Field.Label>Access key ID<RequiredMark /></Field.Label>
            <Field.Input
              value={lmAccessKeyId}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { setLmAccessKeyId(e.target.value); invalidateLmConnection(); }}
              placeholder="AKIAIOSFODNN7EXAMPLE"
              disabled={lmRunning}
              autoComplete="off"
            />
          </Field.Root>
          <Field.Root name="lmSecretAccessKey">
            <Field.Label>Secret access key<RequiredMark /></Field.Label>
            <Field.Input
              type="password"
              value={lmSecretAccessKey}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { setLmSecretAccessKey(e.target.value); invalidateLmConnection(); }}
              placeholder="Your secret access key"
              disabled={lmRunning}
              autoComplete="off"
            />
          </Field.Root>
        </div>

        <Field.Root
          name="lmBaseUrl"
          hint="The public URL prefix for served files — e.g. https://my-bucket.s3.ap-south-1.amazonaws.com or your CDN URL. Database records will be updated to this URL."
        >
          <Field.Label>Base URL (how files will be served)<RequiredMark /></Field.Label>
          <Field.Input
            value={lmBaseUrl}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setLmBaseUrl(e.target.value); invalidateLmConnection(); }}
            placeholder="https://my-bucket.s3.ap-south-1.amazonaws.com"
            disabled={lmRunning}
          />
          <Field.Hint />
        </Field.Root>

        <Field.Root
          name="lmKeyPrefix"
          hint="Optional prefix added before every S3 key. e.g. uploads/ stores files at uploads/filename.jpg. Leave empty for bucket root."
        >
          <Field.Label>Key prefix (optional)</Field.Label>
          <Field.Input
            value={lmKeyPrefix}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setLmKeyPrefix(e.target.value)}
            placeholder="uploads/"
            disabled={lmRunning}
          />
          <Field.Hint />
        </Field.Root>

        <Flex direction="column" alignItems="stretch" gap={3}>
          <Checkbox
            checked={lmPreserveFolders}
            onCheckedChange={(v: boolean | 'indeterminate') => setLmPreserveFolders(v === true)}
            disabled={lmRunning}
          >
            Preserve media library folder structure in S3 keys
          </Checkbox>
          <Checkbox
            checked={lmDeleteLocal}
            onCheckedChange={(v: boolean | 'indeterminate') => setLmDeleteLocal(v === true)}
            disabled={lmRunning}
          >
            Delete local files after successful upload
          </Checkbox>
        </Flex>

        {lmDeleteLocal && (
          <Alert
            title="Local files will be deleted"
            variant="warning"
            closeLabel="Dismiss"
            onClose={() => setLmDeleteLocal(false)}
          >
            Each file is deleted immediately after it is successfully uploaded and the database record is
            updated. Make sure you have a backup before starting.
          </Alert>
        )}

        {lmTestMessage && (
          <Alert
            title={lmConnectionOk ? 'Connection OK' : 'Connection failed'}
            variant={lmConnectionOk ? 'success' : 'danger'}
            closeLabel="Dismiss"
            onClose={() => setLmTestMessage(null)}
          >
            {lmTestMessage}
          </Alert>
        )}

        {(lmRunning || lmDone) && lmInitialTotal > 0 && (
          <Box
            padding={4}
            background="neutral100"
            hasRadius
            borderColor="neutral150"
            borderStyle="solid"
            borderWidth="1px"
          >
            <Flex justifyContent="space-between" alignItems="baseline" wrap="wrap" gap={2}>
              <Typography variant="omega" fontWeight="bold" textColor="neutral800">
                {lmSucceeded.toLocaleString()} / {lmInitialTotal.toLocaleString()} uploaded ({lmProgressPct}%)
              </Typography>
              {lmFailed > 0 && (
                <Typography variant="pi" style={{ color: '#c9553f' }}>
                  {lmFailed} failed
                </Typography>
              )}
            </Flex>
            <Box paddingTop={2} width="100%">
              <ProgressBar value={lmProgressPct} max={100} />
            </Box>
          </Box>
        )}

        <Flex gap={2} alignItems="center" wrap="wrap">
          <Button
            variant="secondary"
            onClick={() => void runLmTestConnection()}
            loading={lmTestBusy}
            disabled={!lmFormReady || lmRunning}
          >
            Test connection
          </Button>
          {lmRunning ? (
            <Button variant="danger" onClick={() => { lmStopRef.current = true; }}>Stop</Button>
          ) : (
            <Button
              onClick={() => void startLmMigration()}
              disabled={!lmConnectionOk || !lmFormReady || lmDone || (localStats?.count ?? 0) === 0}
            >
              {lmDone ? 'Migration complete' : 'Start migration'}
            </Button>
          )}
          {lmDone && (
            <Button
              variant="secondary"
              onClick={() => {
                setLmDone(false);
                setLmSucceeded(0);
                setLmFailed(0);
                setLmLog([]);
                void loadLocalStats();
              }}
            >
              New migration
            </Button>
          )}
        </Flex>

        {(lmLog.length > 0 || lmDone) && (
          <Box background="neutral0" hasRadius borderColor="neutral150" borderStyle="solid" borderWidth="1px">
            <div
              onClick={() => setLmLogsOpen((o) => !o)}
              style={{ cursor: 'pointer', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <Typography variant="omega" fontWeight="bold" textColor="neutral700">
                Execution Logs
                {lmLog.length > 0 && (
                  <span style={{ fontWeight: 'normal', marginLeft: 8 }}>
                    ({lmFailed > 0 ? `${lmFailed} error${lmFailed === 1 ? '' : 's'}, ` : ''}{lmSucceeded} success)
                  </span>
                )}
              </Typography>
              <Typography variant="pi" textColor="neutral500">{lmLogsOpen ? '▲ Collapse' : '▼ Expand'}</Typography>
            </div>
            {lmLogsOpen && (
              <>
                {lmDone && (
                  <Box padding={4} background="success100" borderColor="success200" borderStyle="solid" borderWidth="1px 0 0 0">
                    <Typography variant="omega" textColor="success600">
                      Migration complete. Update your upload provider in <code>config/plugins.ts</code> to use S3 and restart Strapi to finish the switch.
                    </Typography>
                  </Box>
                )}
                {lmLog.length > 0 && (
                  <Box
                    padding={3}
                    background="neutral100"
                    style={{ maxHeight: 240, overflowY: 'auto', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6, borderTop: '1px solid #dcdce4' }}
                  >
                    {lmLog.map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </Box>
                )}
              </>
            )}
          </Box>
        )}
      </Flex>
    </Box>
  );
};

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
  const [copyLogsOpen, setCopyLogsOpen] = useState(false);
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
    setCopyLogsOpen(true);
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
    <Flex direction="column" alignItems="stretch" gap={6}>
      <Tabs.Root defaultValue="local">
        <Tabs.List aria-label="Migration tools">
          <Tabs.Trigger value="local">Local to S3</Tabs.Trigger>
          <Tabs.Trigger value="url">URL Rewrite</Tabs.Trigger>
          <Tabs.Trigger value="copy">S3 Batch Copy</Tabs.Trigger>
        </Tabs.List>

        {/* --- Local to S3 tab --- */}
        <Tabs.Content value="local">
          <Box paddingTop={4}>
            <LocalMigrationCard />
          </Box>
        </Tabs.Content>

        {/* --- URL Rewrite tab --- */}
        <Tabs.Content value="url">
          <Box paddingTop={4}>
            <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
              <Flex direction="column" alignItems="stretch" gap={5}>
                <Box>
                  <Typography variant="delta" tag="h2">URL Rewrite</Typography>
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
                    <Field.Label>Old URL prefix<RequiredMark /></Field.Label>
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
                    <Field.Label>New URL prefix<RequiredMark /></Field.Label>
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
                        Preview is ready. Verify the prefixes before applying.
                      </Typography>
                    </Box>
                  </Box>
                )}

                <Flex gap={2}>
                  <Button variant="secondary" onClick={() => void runPreview()} loading={urlBusy} disabled={!urlFormReady}>
                    Preview matches
                  </Button>
                  <Button onClick={() => void runReplace()} loading={urlBusy} disabled={!urlFormReady}>
                    Apply URL Replace
                  </Button>
                </Flex>

                {log && (
                  <Alert title="Result" variant={logVariant} closeLabel="Dismiss" onClose={() => setLog(null)}>
                    {log}
                  </Alert>
                )}
              </Flex>
            </Box>
          </Box>
        </Tabs.Content>

        {/* --- S3 Batch Copy tab --- */}
        <Tabs.Content value="copy">
          <Box paddingTop={4}>
            <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
              <Flex direction="column" alignItems="stretch" gap={5}>
                <Box>
                  <Typography variant="delta" tag="h2">S3 Batch Copy</Typography>
                  <Box paddingTop={1}>
                    <Typography variant="omega" textColor="neutral600">
                      Copy all objects from a source bucket to a destination bucket. Source credentials are required.
                      Destination access keys are optional — leave both blank to reuse source credentials.
                      Run <strong>Test Connection</strong> first; <strong>Start Copy</strong> is enabled only after a successful test.
                    </Typography>
                  </Box>
                </Box>

                <Divider />

                {/* 2-column Source | Destination layout */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', alignItems: 'start' }}>

                  {/* Source column */}
                  <Box padding={5} background="neutral100" borderColor="neutral150" borderStyle="solid" borderWidth="1px" hasRadius>
                    <Flex direction="column" alignItems="stretch" gap={4}>
                      <Box>
                        <Typography variant="delta" tag="h3">Source</Typography>
                        <Box paddingTop={1}>
                          <Typography variant="pi" textColor="neutral600">All source fields and credentials are required.</Typography>
                        </Box>
                      </Box>
                      <Field.Root name="region" hint="AWS region where the source bucket lives.">
                        <Field.Label>AWS Region<RequiredMark /></Field.Label>
                        <Field.Input
                          value={region}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => { setRegion(e.target.value); invalidateS3Connection(); }}
                          placeholder="ap-south-1"
                          disabled={s3FieldsLocked}
                          required
                        />
                        <Field.Hint />
                      </Field.Root>
                      <Field.Root name="srcBucket" hint="Bucket you are copying from.">
                        <Field.Label>Source Bucket<RequiredMark /></Field.Label>
                        <Field.Input
                          value={srcBucket}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => { setSrcBucket(e.target.value); invalidateS3Connection(); }}
                          placeholder="my-source-bucket"
                          disabled={s3FieldsLocked}
                          required
                        />
                        <Field.Hint />
                      </Field.Root>
                      <Field.Root name="srcPrefix" hint="Only keys starting with this prefix are listed. Leave empty to include the entire bucket.">
                        <Field.Label>Key Prefix</Field.Label>
                        <Field.Input
                          value={srcPrefix}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => { setSrcPrefix(e.target.value); invalidateS3Connection(); }}
                          placeholder="uploads/"
                          disabled={s3FieldsLocked}
                        />
                        <Field.Hint />
                      </Field.Root>
                      <Field.Root name="sourceAccessKeyId" hint="IAM user or key that can list and read objects in the source bucket.">
                        <Field.Label>Access Key ID<RequiredMark /></Field.Label>
                        <Field.Input
                          value={sourceAccessKeyId}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => { setSourceAccessKeyId(e.target.value); invalidateS3Connection(); }}
                          placeholder="AKIAIOSFODNN7EXAMPLE"
                          disabled={s3FieldsLocked}
                          autoComplete="off"
                          required
                        />
                        <Field.Hint />
                      </Field.Root>
                      <Field.Root name="sourceSecretAccessKey" hint="The secret that pairs with the access key ID above.">
                        <Field.Label>Secret Access Key<RequiredMark /></Field.Label>
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
                    </Flex>
                  </Box>

                  {/* Destination column */}
                  <Box padding={5} background="neutral100" borderColor="neutral150" borderStyle="solid" borderWidth="1px" hasRadius>
                    <Flex direction="column" alignItems="stretch" gap={4}>
                      <Box>
                        <Typography variant="delta" tag="h3">Destination</Typography>
                        <Box paddingTop={1}>
                          <Typography variant="pi" textColor="neutral600">Bucket required. Leave credentials blank to reuse source keys.</Typography>
                        </Box>
                      </Box>
                      <Field.Root name="dstBucket" hint="Bucket you are copying into.">
                        <Field.Label>Destination Bucket<RequiredMark /></Field.Label>
                        <Field.Input
                          value={dstBucket}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => { setDstBucket(e.target.value); invalidateS3Connection(); }}
                          placeholder="my-dest-bucket"
                          disabled={s3FieldsLocked}
                          required
                        />
                        <Field.Hint />
                      </Field.Root>
                      <Field.Root name="destRegion" hint="Leave blank to use the same region as the source.">
                        <Field.Label>AWS Region (optional)</Field.Label>
                        <Field.Input
                          value={destRegion}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => { setDestRegion(e.target.value); invalidateS3Connection(); }}
                          placeholder="eu-west-1"
                          disabled={s3FieldsLocked}
                        />
                        <Field.Hint />
                      </Field.Root>
                      <Field.Root name="dstPrefix" hint="A trailing slash is added automatically — e.g. 'backup' copies into backup/filename.jpg.">
                        <Field.Label>Key Prefix (optional)</Field.Label>
                        <Field.Input
                          value={dstPrefix}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => { setDstPrefix(e.target.value); invalidateS3Connection(); }}
                          placeholder="backup/"
                          disabled={s3FieldsLocked}
                        />
                        <Field.Hint />
                      </Field.Root>
                      <Field.Root name="destAccessKeyId" hint="Provide both destination keys, or leave both empty to reuse source keys.">
                        <Field.Label>Access Key ID (optional)</Field.Label>
                        <Field.Input
                          value={destAccessKeyId}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => { setDestAccessKeyId(e.target.value); invalidateS3Connection(); }}
                          placeholder="AKIAIOSFODNN7EXAMPLE"
                          disabled={s3FieldsLocked}
                          autoComplete="off"
                        />
                        <Field.Hint />
                      </Field.Root>
                      <Field.Root name="destSecretAccessKey" hint="The secret that pairs with the destination access key ID.">
                        <Field.Label>Secret Access Key (optional)</Field.Label>
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
                    </Flex>
                  </Box>
                </div>

                {s3TestMessage && (
                  <Alert
                    title={s3ConnectionOk ? 'Connection OK' : 'Connection check'}
                    variant={s3ConnectionOk ? 'success' : 'danger'}
                    closeLabel="Dismiss"
                    onClose={() => setS3TestMessage(null)}
                  >
                    {s3ConnectionOk ? (
                      s3TestSuccessDetail ? (
                        <Typography variant="omega" textColor="neutral600">{s3TestSuccessDetail}</Typography>
                      ) : null
                    ) : (
                      s3TestMessage
                    )}
                  </Alert>
                )}

                {(s3ConnectionOk || s3CopyComplete) && s3SourceObjectCount !== null && (
                  <Box padding={4} background="neutral100" hasRadius borderColor="neutral150" borderStyle="solid" borderWidth="1px">
                    <Typography variant="omega" textColor="neutral800" fontWeight="bold">
                      {s3SourceObjectCount.toLocaleString()} object{s3SourceObjectCount === 1 ? '' : 's'} in the source
                      {srcPrefix.trim() ? ` (prefix "${srcPrefix.trim()}")` : ' (entire bucket)'} ready to copy.
                    </Typography>
                    {s3SourceCountTruncated && (
                      <Box paddingTop={2}>
                        <Typography variant="pi" textColor="warning600">
                          Count hit the server safety limit; the true total may be higher.
                        </Typography>
                      </Box>
                    )}
                    <Divider marginTop={4} marginBottom={4} />
                    <Typography variant="sigma" textColor="neutral700" fontWeight="bold" tag="h4">Copy progress</Typography>
                    <Box paddingTop={2} width="100%">
                      <ProgressBar value={s3CopyProgressPct} max={100} />
                    </Box>
                    <Box paddingTop={2}>
                      <Typography variant="pi" textColor="neutral600">
                        {s3TotalForProgress === 0
                          ? 'No objects to copy under this prefix.'
                          : `${s3CopiedSoFar.toLocaleString()} / ${s3TotalForProgress.toLocaleString()} object${s3TotalForProgress === 1 ? '' : 's'} copied (${s3CopyProgressPct}%${s3SourceCountTruncated ? ', approximate total' : ''})`}
                      </Typography>
                    </Box>
                  </Box>
                )}

                <Flex gap={2} alignItems="center" wrap="wrap">
                  <Button variant="secondary" onClick={() => void runS3TestConnection()} loading={s3TestBusy} disabled={!s3FormReady || urlBusy || s3CopyRunning}>
                    Test Connection
                  </Button>
                  {s3CopyRunning ? (
                    <Button variant="danger" onClick={stopS3Copy}>Stop</Button>
                  ) : (
                    <Button onClick={() => void startS3Copy()} disabled={copyDisabled}>
                      {cursor ? 'Resume Copy' : 'Start Copy'}
                    </Button>
                  )}
                  {s3CopyComplete && (
                    <Button variant="secondary" onClick={() => { setS3CopyComplete(false); setS3CopiedSoFar(0); setCursor(undefined); setS3CopyReport([]); setCopyLog([]); setCopyLogsOpen(false); }}>
                      New Copy
                    </Button>
                  )}
                  {s3CopyComplete && s3CopyReport.length > 0 && (
                    <Button variant="secondary" onClick={downloadCsvReport}>Download Report (CSV)</Button>
                  )}
                  {s3CopyRunning && (
                    <Typography variant="pi" textColor="neutral600">Copying in progress — batches run automatically. Click Stop to pause.</Typography>
                  )}
                </Flex>

                {copyLog.length > 0 && (
                  <Box background="neutral0" hasRadius borderColor="neutral150" borderStyle="solid" borderWidth="1px">
                    <div
                      onClick={() => setCopyLogsOpen((o) => !o)}
                      style={{ cursor: 'pointer', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                    >
                      <Typography variant="omega" fontWeight="bold" textColor="neutral700">
                        Copy Logs ({s3CopyReport.length} copied)
                      </Typography>
                      <Typography variant="pi" textColor="neutral500">{copyLogsOpen ? '▲ Collapse' : '▼ Expand'}</Typography>
                    </div>
                    {copyLogsOpen && (
                      <Box padding={3} background="neutral100" style={{ maxHeight: 240, overflowY: 'auto', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6, borderTop: '1px solid #dcdce4' }}>
                        {copyLog.map((line, i) => (
                          <div key={i}>{line}</div>
                        ))}
                      </Box>
                    )}
                  </Box>
                )}
              </Flex>
            </Box>

            {/* Danger Zone accordion — scoped to S3 Batch Copy since it only affects S3 buckets */}
            <Box marginTop={5} background="neutral0" hasRadius shadow="filterShadow" borderColor="danger200" borderStyle="solid" borderWidth="1px">
              <div
                onClick={() => setDelExpanded((x) => !x)}
                style={{ cursor: 'pointer', padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              >
                <Box>
                  <Typography variant="delta" textColor="danger600">Danger Zone: Delete objects from bucket</Typography>
                  <Box paddingTop={1}>
                    <Typography variant="pi" textColor="neutral600">
                      Permanently remove all objects under a given bucket prefix.{!delExpanded && ' Click to expand.'}
                    </Typography>
                  </Box>
                </Box>
                <Typography variant="pi" textColor="danger600" style={{ flexShrink: 0, marginLeft: 16 }}>
                  {delExpanded ? '▲ Collapse' : '▼ Expand'}
                </Typography>
              </div>

              {delExpanded && (
                <Box padding={6} paddingTop={0}>
                  <Divider marginBottom={5} />
                  <Flex direction="column" alignItems="stretch" gap={4}>
                    <Typography variant="omega" textColor="neutral600">
                      Permanently remove all objects under a given prefix. Use to clean up partially copied data before retrying.
                      Requires <code>s3:ListBucket</code> + <code>s3:DeleteObject</code>. Credentials are cleared after completion.
                    </Typography>

                    <Flex gap={2} wrap="wrap">
                      <Button variant="tertiary" size="S" onClick={prefillDeleteFromDest} disabled={delRunning}>
                        Pre-fill from destination fields
                      </Button>
                      {(delLog.length > 0 || delTotalDeleted > 0) && (
                        <Button variant="ghost" size="S" onClick={resetDelete} disabled={delRunning}>Reset log</Button>
                      )}
                    </Flex>

                    <div style={gridRow}>
                      <Field.Root name="delRegion" hint="AWS region where the target bucket lives.">
                        <Field.Label>AWS Region<RequiredMark /></Field.Label>
                        <Field.Input value={delRegion} onChange={(e: ChangeEvent<HTMLInputElement>) => setDelRegion(e.target.value)} placeholder="ap-south-1" disabled={delRunning} required />
                        <Field.Hint />
                      </Field.Root>
                      <Field.Root name="delBucket" hint="Name of the S3 bucket to delete objects from.">
                        <Field.Label>Bucket<RequiredMark /></Field.Label>
                        <Field.Input value={delBucket} onChange={(e: ChangeEvent<HTMLInputElement>) => setDelBucket(e.target.value)} placeholder="my-media-bucket" disabled={delRunning} required />
                        <Field.Hint />
                      </Field.Root>
                    </div>

                    <Field.Root name="delPrefix" hint="Only objects whose key starts with this prefix are deleted. Leave empty to delete the entire bucket (use with extreme caution).">
                      <Field.Label>Key Prefix (optional)</Field.Label>
                      <Field.Input value={delPrefix} onChange={(e: ChangeEvent<HTMLInputElement>) => setDelPrefix(e.target.value)} placeholder="backup/ or migration-archive/" disabled={delRunning} />
                      <Field.Hint />
                    </Field.Root>

                    <div style={gridRow}>
                      <Field.Root name="delAccessKeyId" hint="IAM identity that has s3:ListBucket + s3:DeleteObject on the target bucket.">
                        <Field.Label>Access Key ID<RequiredMark /></Field.Label>
                        <Field.Input value={delAccessKeyId} onChange={(e: ChangeEvent<HTMLInputElement>) => setDelAccessKeyId(e.target.value)} placeholder="AKIAIOSFODNN7EXAMPLE" disabled={delRunning} autoComplete="off" required />
                        <Field.Hint />
                      </Field.Root>
                      <Field.Root name="delSecretAccessKey" hint="The secret that pairs with the access key ID above.">
                        <Field.Label>Secret Access Key<RequiredMark /></Field.Label>
                        <Field.Input type="password" value={delSecretAccessKey} onChange={(e: ChangeEvent<HTMLInputElement>) => setDelSecretAccessKey(e.target.value)} placeholder="Your secret access key" disabled={delRunning} autoComplete="off" required />
                        <Field.Hint />
                      </Field.Root>
                    </div>

                    {delTotalDeleted > 0 && (
                      <Typography variant="omega" textColor="danger600">
                        {delTotalDeleted.toLocaleString()} object{delTotalDeleted === 1 ? '' : 's'} deleted so far{delComplete ? ' (complete)' : ' (in progress)'}
                      </Typography>
                    )}

                    <Flex gap={2} alignItems="center">
                      {delRunning ? (
                        <Button variant="danger" onClick={stopDelete}>Stop</Button>
                      ) : (
                        <Button variant="danger" onClick={() => void startDelete()} disabled={!delRegion.trim() || !delBucket.trim() || !delAccessKeyId.trim() || !delSecretAccessKey.trim() || delComplete}>
                          {delCursor ? 'Resume Delete' : 'Delete Objects'}
                        </Button>
                      )}
                      {delComplete && <Button variant="secondary" onClick={resetDelete}>Reset</Button>}
                    </Flex>

                    {delLog.length > 0 && (
                      <Box padding={3} background="neutral100" hasRadius style={{ maxHeight: 200, overflowY: 'auto', fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}>
                        {delLog.map((line, i) => <div key={i}>{line}</div>)}
                      </Box>
                    )}
                  </Flex>
                </Box>
              )}
            </Box>
          </Box>
        </Tabs.Content>
      </Tabs.Root>
    </Flex>
  );
};

/* ------------------------------------------------------------------ */
/*  Convert existing images tab                                         */
/* ------------------------------------------------------------------ */

type FileConvStatus = {
  status: 'converting' | 'done' | 'error';
  error?: string;
  originalKB?: number;
  newKB?: number;
};

function formatSize(kb: number): string {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
}

function savingsSummary(savedKB: number, originalKB: number): string {
  if (originalKB <= 0 || savedKB <= 0) return '';
  const pct = Math.round((savedKB / originalKB) * 100);
  return `Saved ${formatSize(savedKB)} · ${pct}% smaller`;
}

const BATCH_SIZE = 10;
const LIST_PAGE_SIZE = 20;
const ID_COLLECT_PAGE_SIZE = 50;
const ID_COLLECT_LIMIT = 5000;

const ConversionPanel = () => {
  const [stats, setStats] = useState<ConversionStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const [files, setFiles] = useState<ConversionFile[]>([]);
  const [filesPage, setFilesPage] = useState(1);
  const [filesPageCount, setFilesPageCount] = useState(1);
  const [filesTotal, setFilesTotal] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [mimeFilter, setMimeFilter] = useState('');

  const [useCustomQuality, setUseCustomQuality] = useState(false);
  const [customQuality, setCustomQuality] = useState(82);
  const [settingsQuality, setSettingsQuality] = useState(82);
  const [losslessForPng, setLosslessForPng] = useState(false);

  const [fileStatuses, setFileStatuses] = useState<Map<number, FileConvStatus>>(new Map());

  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkConverted, setBulkConverted] = useState(0);
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkDone, setBulkDone] = useState(false);
  const [bulkSavedKB, setBulkSavedKB] = useState(0);
  const [bulkOriginalKB, setBulkOriginalKB] = useState(0);
  const bulkStopRef = useRef(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [msg, setMsg] = useState<string | null>(null);
  const [msgVariant, setMsgVariant] = useState<'success' | 'danger' | 'warning'>('success');
  const [msgTitle, setMsgTitle] = useState<string | null>(null);

  const setFileStatus = (id: number, s: FileConvStatus) =>
    setFileStatuses((prev) => new Map([...prev, [id, s]]));

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      setStats(await getConversionStats());
    } catch {
      // silent
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadFiles = useCallback(async (page: number, search?: string, mime?: string) => {
    setFilesLoading(true);
    try {
      const r = await getConversionFiles(page, LIST_PAGE_SIZE, search, mime);
      setFiles(r.files);
      setFilesPageCount(r.pageCount);
      setFilesTotal(r.total);
    } catch {
      // silent
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setFilesPage(1);
      void loadFiles(1, value, mimeFilter);
    }, 400);
  };

  const handleMimeChange = (value: string) => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    setMimeFilter(value);
    setFilesPage(1);
    void loadFiles(1, searchQuery, value);
  };

  const clearFilters = () => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    setSearchQuery('');
    setMimeFilter('');
    setFilesPage(1);
    void loadFiles(1, '', '');
  };

  useEffect(() => {
    void loadStats();
    void loadFiles(1);
    getSettings()
      .then(({ settings }) => setSettingsQuality(settings.webpQuality))
      .catch(() => {});
  }, [loadStats, loadFiles]);

  const effectiveQuality = useCustomQuality ? customQuality : settingsQuality;

  const convertSingle = async (file: ConversionFile) => {
    setFileStatus(file.id, { status: 'converting' });
    try {
      const losslessMimes = losslessForPng ? ['image/png'] : [];
      const r = await postConversionBatch({ fileIds: [file.id], quality: effectiveQuality, losslessMimes });
      if (r.converted > 0) {
        setFileStatus(file.id, { status: 'done', originalKB: file.size, newKB: r.newKB });
        void loadStats();
      } else {
        const err = r.errors[0];
        setFileStatus(file.id, { status: 'error', error: err?.error ?? 'No result' });
      }
    } catch (e) {
      setFileStatus(file.id, { status: 'error', error: e instanceof Error ? e.message : 'Failed' });
    }
  };

  const startBulkConvert = async () => {
    const toConvert = filesTotal;
    if (toConvert === 0) {
      setMsgVariant('success');
      setMsgTitle(null);
      setMsg(searchQuery || mimeFilter ? 'No files match the current filters.' : 'All images are already in WebP format.');
      return;
    }
    const filterDesc = [searchQuery && `name contains "${searchQuery}"`, mimeFilter && `type: ${mimeFilter}`]
      .filter(Boolean).join(', ');
    if (
      !window.confirm(
        `This will convert ${toConvert.toLocaleString()} non-WebP image${toConvert === 1 ? '' : 's'}${filterDesc ? ` (${filterDesc})` : ''} to WebP and replace the original files in storage. Make sure you have a backup. Continue?`
      )
    )
      return;

    bulkStopRef.current = false;
    setBulkRunning(true);
    setBulkConverted(0);
    setBulkDone(false);
    setBulkSavedKB(0);
    setBulkOriginalKB(0);
    setBulkTotal(toConvert);
    setMsg(null);
    setMsgTitle(null);
    setFileStatuses(new Map());

    let localConverted = 0;
    let localFailed = 0;
    let localSavedKB = 0;
    let localOriginalKB = 0;

    try {
      // Collect all convertible IDs (up to ID_COLLECT_LIMIT)
      const allIds: number[] = [];
      let idPage = 1;
      while (allIds.length < ID_COLLECT_LIMIT) {
        const r = await getConversionFiles(idPage, ID_COLLECT_PAGE_SIZE, searchQuery || undefined, mimeFilter || undefined);
        for (const f of r.files) allIds.push(f.id);
        if (idPage >= r.pageCount || r.files.length === 0) break;
        idPage++;
      }
      setBulkTotal(allIds.length);

      const losslessMimes = losslessForPng ? ['image/png'] : [];

      // Convert in batches
      for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
        if (bulkStopRef.current) break;
        const batch = allIds.slice(i, i + BATCH_SIZE);
        const r = await postConversionBatch({ fileIds: batch, quality: effectiveQuality, losslessMimes });
        localConverted += r.converted;
        localFailed += r.failed;
        localSavedKB += r.savedKB;
        localOriginalKB += r.originalKB;
        setBulkConverted(localConverted);
        setBulkSavedKB(localSavedKB);
        setBulkOriginalKB(localOriginalKB);
        for (const id of batch) {
          const err = r.errors.find((e) => e.id === id);
          setFileStatus(id, err ? { status: 'error', error: err.error } : { status: 'done' });
        }
      }

      const savings = savingsSummary(localSavedKB, localOriginalKB);
      const savingsSuffix = savings ? ` ${savings}.` : '';

      if (bulkStopRef.current) {
        setMsgVariant('warning');
        setMsgTitle('Stopped');
        const failedSuffix = localFailed > 0 ? ` ${localFailed} failed.` : '';
        setMsg(`Converted ${localConverted.toLocaleString()} file(s) before stopping.${failedSuffix}${savingsSuffix} Run Convert All again to resume.`);
      } else {
        setBulkDone(true);
        if (localConverted === 0 && localFailed > 0) {
          setMsgVariant('danger');
          setMsgTitle('Conversion failed');
          setMsg(`${localFailed} file${localFailed === 1 ? '' : 's'} failed to convert. Hover the X Error tag on each row to see why.`);
        } else if (localFailed > 0) {
          setMsgVariant('warning');
          setMsgTitle('Completed with errors');
          setMsg(`${localConverted.toLocaleString()} file${localConverted === 1 ? '' : 's'} converted, ${localFailed} failed. Hover the X Error tag on each row to see why.${savingsSuffix}`);
        } else {
          setMsgVariant('success');
          setMsgTitle('Done');
          setMsg(`${localConverted.toLocaleString()} file${localConverted === 1 ? '' : 's'} converted to WebP.${savingsSuffix}`);
        }
      }
      void loadStats();
      void loadFiles(filesPage, searchQuery, mimeFilter);
    } catch (e) {
      setMsgVariant('danger');
      setMsgTitle('Error');
      setMsg(e instanceof Error ? e.message : 'Bulk conversion failed');
    } finally {
      setBulkRunning(false);
    }
  };

  const stopBulk = () => {
    bulkStopRef.current = true;
  };

  const bulkProgressPct =
    bulkTotal > 0 ? Math.min(100, Math.round((bulkConverted / bulkTotal) * 100)) : 0;

  return (
    <Flex direction="column" alignItems="stretch" gap={4}>

      {/* Stats card */}
      <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Box>
            <Typography variant="delta" tag="h2">Convert existing images</Typography>
            <Box paddingTop={1}>
              <Typography variant="omega" textColor="neutral600">
                Scan the media library for non-WebP images and convert them in place. Each file is re-uploaded as WebP,
                the database record is updated, and the old file is removed from storage. Content that references files
                by relation (the standard Strapi media field) will automatically serve the new URL — no content edits needed.
              </Typography>
            </Box>
          </Box>

          <Divider />

          {statsLoading ? (
            <Typography variant="omega" textColor="neutral500">Loading stats…</Typography>
          ) : stats ? (
            <div style={gridRow}>
              <Box padding={4} background="neutral100" hasRadius>
                <Typography variant="sigma" textColor="neutral500">Total media files</Typography>
                <Typography variant="alpha" tag="p">{stats.total.toLocaleString()}</Typography>
              </Box>
              <Box padding={4} background="neutral100" hasRadius>
                <Typography variant="sigma" textColor="neutral500">Already WebP</Typography>
                <Typography variant="alpha" tag="p" style={{ color: '#328048' }}>{stats.alreadyWebP.toLocaleString()}</Typography>
              </Box>
              <Box padding={4} background="neutral100" hasRadius>
                <Typography variant="sigma" textColor="neutral500">Need conversion</Typography>
                <Typography variant="alpha" tag="p" style={{ color: stats.needsConversion > 0 ? '#b34000' : '#328048' }}>
                  {stats.needsConversion.toLocaleString()}
                </Typography>
              </Box>
            </div>
          ) : (
            <Button variant="secondary" size="S" onClick={() => void loadStats()}>Load stats</Button>
          )}
        </Flex>
      </Box>

      {/* Bulk convert card */}
      <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
        <Flex direction="column" alignItems="stretch" gap={5}>
          <Box>
            <Typography variant="delta" tag="h2">Bulk convert</Typography>
          </Box>

          <Divider />

          {/* Quality + lossless options */}
          <Flex direction="column" alignItems="stretch" gap={3}>
            <Checkbox
              checked={useCustomQuality}
              onCheckedChange={(v: boolean | 'indeterminate') => setUseCustomQuality(v === true)}
              disabled={bulkRunning}
            >
              Override quality for this run
            </Checkbox>
            <Checkbox
              checked={losslessForPng}
              onCheckedChange={(v: boolean | 'indeterminate') => setLosslessForPng(v === true)}
              disabled={bulkRunning}
            >
              Use lossless WebP for PNG files (pixel-perfect, larger file size)
            </Checkbox>
          </Flex>

          {useCustomQuality && (
            <Box style={{ maxWidth: 360 }}>
              <Field.Root name="bulkQuality">
                <Field.Label>Quality — {customQuality}</Field.Label>
                <Box paddingTop={2}>
                  <input
                    type="range"
                    min={1}
                    max={100}
                    step={1}
                    value={customQuality}
                    disabled={bulkRunning}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setCustomQuality(Number(e.target.value))}
                    style={{ width: '100%', accentColor: '#4945ff', cursor: 'pointer' }}
                  />
                </Box>
                <Box paddingTop={1}>
                  <Typography variant="pi" textColor="neutral500">
                    Leave override off to use the quality from Upload optimization settings ({settingsQuality}).
                  </Typography>
                </Box>
              </Field.Root>
            </Box>
          )}

          {/* Progress bar (shown during / after bulk run) */}
          {(bulkRunning || bulkDone) && bulkTotal > 0 && (
            <Box padding={4} background="neutral100" hasRadius borderColor="neutral150" borderStyle="solid" borderWidth="1px">
              <Flex justifyContent="space-between" alignItems="baseline" wrap="wrap" gap={2}>
                <Typography variant="omega" fontWeight="bold" textColor="neutral800">
                  {bulkConverted.toLocaleString()} / {bulkTotal.toLocaleString()} converted ({bulkProgressPct}%)
                </Typography>
                {bulkSavedKB > 0 && (
                  <Typography variant="pi" style={{ color: '#328048', fontWeight: 600 }}>
                    {savingsSummary(bulkSavedKB, bulkOriginalKB)}
                  </Typography>
                )}
              </Flex>
              <Box paddingTop={2} width="100%">
                <ProgressBar value={bulkProgressPct} max={100} />
              </Box>
            </Box>
          )}

          {msg && (
            <Alert
              title={msgTitle ?? (msgVariant === 'success' ? 'Done' : msgVariant === 'warning' ? 'Stopped' : 'Error')}
              variant={msgVariant}
              closeLabel="Dismiss"
              onClose={() => { setMsg(null); setMsgTitle(null); }}
            >
              {msg}
            </Alert>
          )}

          <Flex gap={2} alignItems="center" wrap="wrap">
            {bulkRunning ? (
              <Button variant="danger" onClick={stopBulk}>Stop</Button>
            ) : (
              <Button
                onClick={() => void startBulkConvert()}
                disabled={filesTotal === 0 || bulkRunning || filesLoading}
              >
                Convert All ({filesTotal.toLocaleString()})
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => { void loadStats(); void loadFiles(filesPage, searchQuery, mimeFilter); }}
              disabled={bulkRunning || statsLoading}
            >
              Refresh
            </Button>
            {bulkRunning && (
              <Typography variant="pi" textColor="neutral600">
                Converting in batches of {BATCH_SIZE} — click Stop to pause.
              </Typography>
            )}
          </Flex>
        </Flex>
      </Box>

      {/* File list card */}
      <Box background="neutral0" padding={6} hasRadius shadow="filterShadow">
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={2}>
            <Box>
              <Typography variant="delta" tag="h2">Files to convert</Typography>
              {!filesLoading && (
                <Box paddingTop={1}>
                  <Typography variant="pi" textColor="neutral500">
                    {filesTotal > 0
                      ? `${filesTotal.toLocaleString()} non-WebP image${filesTotal === 1 ? '' : 's'}${searchQuery || mimeFilter ? ' (filtered)' : ''} · page ${filesPage} of ${filesPageCount}`
                      : (searchQuery || mimeFilter ? 'No files match the current filters.' : 'No non-WebP images found.')}
                  </Typography>
                </Box>
              )}
            </Box>
            <Flex gap={2}>
              <Button
                size="S"
                variant="ghost"
                disabled={filesPage <= 1 || filesLoading || bulkRunning}
                onClick={() => { const p = filesPage - 1; setFilesPage(p); void loadFiles(p, searchQuery, mimeFilter); }}
              >
                ← Prev
              </Button>
              <Button
                size="S"
                variant="ghost"
                disabled={filesPage >= filesPageCount || filesLoading || bulkRunning}
                onClick={() => { const p = filesPage + 1; setFilesPage(p); void loadFiles(p, searchQuery, mimeFilter); }}
              >
                Next →
              </Button>
            </Flex>
          </Flex>

          {/* Filter row */}
          <Flex gap={3} alignItems="flex-end" wrap="wrap">
            <Box style={{ flex: '1 1 200px', minWidth: 150 }}>
              <Field.Root name="fileSearch">
                <Field.Label>Search by name</Field.Label>
                <Field.Input
                  value={searchQuery}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => handleSearchChange(e.target.value)}
                  placeholder="e.g. photo, banner…"
                  disabled={bulkRunning}
                />
              </Field.Root>
            </Box>
            <Box>
              <Field.Root name="mimeFilter">
                <Field.Label>File type</Field.Label>
                <Box paddingTop={1}>
                  <select
                    value={mimeFilter}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => handleMimeChange(e.target.value)}
                    disabled={bulkRunning}
                    style={{ height: 40, paddingLeft: 12, paddingRight: 12, border: '1px solid #dcdce4', borderRadius: 4, fontSize: 14, background: '#fff', cursor: 'pointer' }}
                  >
                    <option value="">All types</option>
                    <option value="image/jpeg">JPEG</option>
                    <option value="image/png">PNG</option>
                    <option value="image/gif">GIF</option>
                    <option value="image/bmp">BMP</option>
                    <option value="image/tiff">TIFF</option>
                    <option value="image/heic">HEIC</option>
                  </select>
                </Box>
              </Field.Root>
            </Box>
            {(searchQuery || mimeFilter) && (
              <Button size="S" variant="ghost" onClick={clearFilters} disabled={bulkRunning}>
                Clear filters
              </Button>
            )}
          </Flex>

          <Divider />

          {files.length === 0 && filesLoading ? (
            <Typography variant="omega" textColor="neutral500">Loading…</Typography>
          ) : files.length === 0 ? (
            <Box padding={4} background="neutral100" hasRadius>
              <Typography variant="omega" textColor="neutral600">
                {searchQuery || mimeFilter
                  ? 'No files match the current filters.'
                  : 'No non-WebP images found.'}
              </Typography>
            </Box>
          ) : (
            <div style={{ opacity: filesLoading ? 0.45 : 1, transition: 'opacity 0.15s ease', pointerEvents: filesLoading ? 'none' : 'auto' }}>
            <Flex direction="column" alignItems="stretch" gap={2}>
              {files.map((file) => {
                const fileStatus = fileStatuses.get(file.id);
                const isConverting = fileStatus?.status === 'converting';
                const isDone = fileStatus?.status === 'done';
                const isError = fileStatus?.status === 'error';
                const thumbUrl =
                  (file.formats as any)?.thumbnail?.url ?? file.url;

                return (
                  <Box
                    key={file.id}
                    padding={3}
                    background="neutral100"
                    hasRadius
                    borderColor={isDone ? 'success200' : isError ? 'danger200' : 'neutral200'}
                    borderStyle="solid"
                    borderWidth="1px"
                  >
                    <Flex alignItems="center" gap={3}>
                      {/* Thumbnail */}
                      <Box
                        style={{
                          width: 48,
                          height: 48,
                          borderRadius: 6,
                          overflow: 'hidden',
                          background: '#e0e0e0',
                          flexShrink: 0,
                        }}
                      >
                        <img
                          src={thumbUrl}
                          alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      </Box>

                      {/* File info */}
                      <Box flex={1} style={{ minWidth: 0 }}>
                        <Typography
                          variant="omega"
                          fontWeight="bold"
                          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}
                        >
                          {file.name}
                        </Typography>
                        <Typography variant="pi" textColor="neutral500">
                          {file.mime} &middot; {file.size.toFixed(1)} KB
                        </Typography>
                      </Box>

                      {/* Status */}
                      {isDone && (
                        <Flex direction="column" alignItems="flex-end" gap={0} style={{ whiteSpace: 'nowrap' }}>
                          <Typography variant="pi" style={{ color: '#328048', fontWeight: 600 }}>
                            ✓ Converted
                          </Typography>
                          {fileStatus?.originalKB != null && fileStatus?.newKB != null && (
                            <Typography variant="pi" textColor="neutral500">
                              {formatSize(fileStatus.originalKB)} → {formatSize(fileStatus.newKB)}
                              {fileStatus.originalKB > 0
                                ? ` (−${Math.round(((fileStatus.originalKB - fileStatus.newKB) / fileStatus.originalKB) * 100)}%)`
                                : ''}
                            </Typography>
                          )}
                        </Flex>
                      )}
                      {isError && (
                        <Typography
                          variant="pi"
                          style={{ color: '#c9553f', whiteSpace: 'nowrap' }}
                          title={fileStatus?.error}
                        >
                          ✗ Error
                        </Typography>
                      )}

                      {/* Action button */}
                      {!isDone && (
                        <Button
                          size="S"
                          variant={isError ? 'ghost' : 'secondary'}
                          onClick={() => void convertSingle(file)}
                          disabled={isConverting || bulkRunning}
                          loading={isConverting}
                        >
                          {isError ? 'Retry' : 'Convert'}
                        </Button>
                      )}
                    </Flex>
                  </Box>
                );
              })}
            </Flex>
            </div>
          )}
        </Flex>
      </Box>
    </Flex>
  );
};

/* ------------------------------------------------------------------ */
/*  Page shell                                                          */
/* ------------------------------------------------------------------ */

type TabKey = 'optimization' | 'migration' | 'conversion';

const HomePage = () => {
  const [tab, setTab] = useState<TabKey>('optimization');

  return (
    <Layouts.Root>
      <Layouts.Header
        title="Media WebP & Migration"
        subtitle="Configure WebP encoding for uploads and run operator-controlled migration helpers."
      />
      <Layouts.Content>
        <Tabs.Root variant="simple" value={tab} onValueChange={(v: string) => setTab(v as TabKey)}>
          <Tabs.List aria-label="Plugin sections">
            <Tabs.Trigger value="optimization">Upload optimization</Tabs.Trigger>
            <Tabs.Trigger value="conversion">Convert existing</Tabs.Trigger>
            <Tabs.Trigger value="migration">Migration</Tabs.Trigger>
          </Tabs.List>
          <Box paddingTop={6}>
            <Tabs.Content value="optimization">
              <UploadOptimizationPanel />
            </Tabs.Content>
            <Tabs.Content value="conversion">
              <ConversionPanel />
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
