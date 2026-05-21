import type { Core } from '@strapi/strapi';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { FILE_MODEL_UID } from '../constants';

/** S3 CopyObject expects the source key segments URI-encoded (bucket name as-is). */
function encodeS3CopySource(bucket: string, key: string): string {
  const encodedKey = key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${bucket}/${encodedKey}`;
}

/**
 * Ensures a key prefix has a trailing slash so it joins cleanly with relative keys.
 * "pre-final" → "pre-final/"  |  "upload/" → "upload/"  |  "" → ""
 */
function normalizePrefix(p: string): string {
  const t = (p ?? '').trim().replace(/^\/+/, '');
  if (!t) return '';
  return t.endsWith('/') ? t : `${t}/`;
}

/** Trim and strip a single leading slash (S3 keys are relative, no leading "/"). */
function trimS3KeyPart(p: string): string {
  return p.trim().replace(/^\/+/, '');
}

/**
 * Object key relative to the list prefix. Ensures `upload` does not match `uploads/…`
 * (only strips when the next character is "/" or the key equals the prefix).
 */
function relativeKeyFromSource(objectKey: string, sourcePrefix: string): string {
  const key = trimS3KeyPart(objectKey);
  const raw = trimS3KeyPart(sourcePrefix);
  if (!raw) return key;
  if (key === raw) return '';
  const withSlash = raw.endsWith('/') ? raw : `${raw}/`;
  if (key.startsWith(withSlash)) return key.slice(withSlash.length);
  return key;
}

/**
 * Join destination folder prefix and relative key with exactly one "/" between them.
 * Strips both leading AND trailing slashes from the prefix so that normalizePrefix output
 * (e.g. "backup/") does not produce a double-slash ("backup//file.webp").
 */
function joinDestObjectKey(destPrefix: string, relativeKey: string): string {
  const dp = destPrefix.trim().replace(/^\/+|\/+$/g, '');
  const rk = trimS3KeyPart(relativeKey);
  if (!dp) return rk;
  if (!rk) return `${dp}/`;
  return `${dp}/${rk}`;
}

export type ExplicitS3Creds = {
  accessKeyId: string;
  secretAccessKey: string;
};

function requireSourceCreds(input: S3ClientsContext): ExplicitS3Creds {
  const a = input.sourceAccessKeyId?.trim();
  const s = input.sourceSecretAccessKey?.trim();
  if (!a || !s) {
    throw new Error('Source access key ID and secret access key are required.');
  }
  return { accessKeyId: a, secretAccessKey: s };
}

/** Omit both to reuse source credentials for CopyObject; never use the host default chain alone. */
function pickOptionalDestCreds(input: S3ClientsContext): ExplicitS3Creds | undefined {
  const a = input.destAccessKeyId?.trim();
  const s = input.destSecretAccessKey?.trim();
  if (!a && !s) return undefined;
  if (!a || !s) {
    throw new Error(
      'Destination credentials: provide both access key ID and secret access key, or omit both to sign CopyObject with the source credentials.'
    );
  }
  return { accessKeyId: a, secretAccessKey: s };
}

function s3ClientForRegion(region: string, credentials: ExplicitS3Creds): S3Client {
  return new S3Client({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });
}

/**
 * AWS SDK v3 cannot always sign PutObject when the body is a readable stream whose first
 * chunk is smaller than 8192 bytes ("Only the last chunk is allowed…"). Buffering the
 * GetObject payload avoids that (fine for typical Strapi media; cross-account path only).
 */
async function s3GetObjectBodyToBuffer(body: unknown): Promise<Buffer> {
  if (body == null) {
    throw new Error('S3 GetObject returned an empty body.');
  }
  const maybeSdk = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof maybeSdk.transformToByteArray === 'function') {
    const bytes = await maybeSdk.transformToByteArray();
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const stream = body as AsyncIterable<Buffer | Uint8Array | string>;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export type S3ClientsContext = {
  /** Region of the source bucket (used for ListObjectsV2 on source). */
  region: string;
  sourceBucket: string;
  sourcePrefix: string;
  destBucket: string;
  destPrefix: string;
  /** Region of the destination bucket for CopyObject. If omitted, defaults to `region`. */
  destRegion?: string;
  sourceAccessKeyId?: string;
  sourceSecretAccessKey?: string;
  destAccessKeyId?: string;
  destSecretAccessKey?: string;
};

type S3ClientsPair = {
  /** Source-region client with source credentials (list + GetObject). */
  listClient: S3Client;
  /** Destination-region client (PutObject / CopyObject). Uses dest creds when provided. */
  copyClient: S3Client;
  /** True when the caller supplied separate destination keys, meaning CopyObject won't work
   *  cross-account and we must fall back to GetObject→PutObject (stream-through). */
  separateDestCreds: boolean;
};

function buildS3Clients(input: S3ClientsContext): S3ClientsPair {
  const sourceCreds = requireSourceCreds(input);
  const destCreds = pickOptionalDestCreds(input);

  const sourceRegion = input.region.trim();
  const destRegion = (input.destRegion?.trim() || sourceRegion).trim() || sourceRegion;

  const listClient = s3ClientForRegion(sourceRegion, sourceCreds);

  let copyClient: S3Client;
  if (destCreds) {
    copyClient = s3ClientForRegion(destRegion, destCreds);
  } else if (destRegion === sourceRegion) {
    copyClient = listClient;
  } else {
    copyClient = s3ClientForRegion(destRegion, sourceCreds);
  }

  return { listClient, copyClient, separateDestCreds: !!destCreds };
}

/** S3 ListObjectsV2 max keys per page. */
const S3_LIST_PAGE_SIZE = 1000;
/** Safety cap on list pages when counting (100k pages ≈ 100M objects max). */
const S3_COUNT_MAX_PAGES = 100_000;

/**
 * Paginates through all objects under bucket + prefix (same semantics as batch copy listing).
 */
async function countSourceObjectsWithPrefix(
  client: S3Client,
  bucket: string,
  prefix: string
): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  let continuationToken: string | undefined;
  let pages = 0;

  while (pages < S3_COUNT_MAX_PAGES) {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || '',
        ContinuationToken: continuationToken,
        MaxKeys: S3_LIST_PAGE_SIZE,
      })
    );
    count += (out.Contents ?? []).length;
    pages += 1;
    if (!out.IsTruncated) {
      return { count, truncated: false };
    }
    continuationToken = out.NextContinuationToken;
    if (!continuationToken) {
      return { count, truncated: false };
    }
  }

  return { count, truncated: true };
}

export type CopyBatchInput = S3ClientsContext & {
  continuationToken?: string;
  maxKeys?: number;
};

function replaceUrlInString(url: string | null | undefined, oldP: string, newP: string): string | null | undefined {
  if (url == null) return url;
  if (!url.includes(oldP)) return url;
  return url.split(oldP).join(newP);
}

function deepReplaceUrlsInFormats(formats: unknown, oldP: string, newP: string): unknown {
  if (!formats || typeof formats !== 'object') return formats;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(formats as Record<string, unknown>)) {
    if (v && typeof v === 'object' && 'url' in (v as object)) {
      const f = { ...(v as Record<string, unknown>) };
      f.url = replaceUrlInString(f.url as string, oldP, newP);
      if (typeof f.previewUrl === 'string') {
        f.previewUrl = replaceUrlInString(f.previewUrl, oldP, newP);
      }
      out[k] = f;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function runPreviewUrlReplace(strapi: Core.Strapi, oldPrefix: string, newPrefix: string) {
  if (!oldPrefix?.trim() || !newPrefix?.trim()) {
    throw new Error('oldPrefix and newPrefix are required');
  }
  const pageSize = 100;
  let page = 1;
  let matchCount = 0;
  const samples: string[] = [];

  for (;;) {
    const { results: batch } = await strapi.db.query(FILE_MODEL_UID).findPage({
      select: ['id', 'url', 'formats'],
      page,
      pageSize,
    });
    if (!batch.length) break;
    for (const row of batch) {
      const u = (row as { url?: string }).url || '';
      const formats = (row as { formats?: unknown }).formats;
      let hit = u.includes(oldPrefix);
      if (!hit && formats && typeof formats === 'object') {
        hit = JSON.stringify(formats).includes(oldPrefix);
      }
      if (hit) {
        matchCount++;
        if (samples.length < 5 && u) samples.push(u);
      }
    }
    if (batch.length < pageSize) break;
    page += 1;
  }

  return { matchCount, samples, oldPrefix, newPrefix };
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Count files whose main url or any format url contains oldPrefix (simple scan, batched).
   */
  async previewUrlReplace(oldPrefix: string, newPrefix: string) {
    return runPreviewUrlReplace(strapi, oldPrefix, newPrefix);
  },

  /**
   * Replace oldPrefix with newPrefix on url + formats for all matching rows (batched updates).
   */
  async applyUrlReplace(oldPrefix: string, newPrefix: string) {
    const preview = await runPreviewUrlReplace(strapi, oldPrefix, newPrefix);
    const pageSize = 50;
    let page = 1;
    let updated = 0;

    for (;;) {
      const { results: batch } = await strapi.db.query(FILE_MODEL_UID).findPage({
        page,
        pageSize,
      });
      if (!batch.length) break;

      for (const row of batch) {
        const rec = row as { id: number | string; url?: string; formats?: unknown };
        const u = rec.url || '';
        const formats = rec.formats;
        const needs =
          u.includes(oldPrefix) || (formats && typeof formats === 'object' && JSON.stringify(formats).includes(oldPrefix));
        if (!needs) continue;

        const nextUrl = replaceUrlInString(u, oldPrefix, newPrefix) || u;
        const nextFormats = deepReplaceUrlsInFormats(formats, oldPrefix, newPrefix);

        await strapi.db.query(FILE_MODEL_UID).update({
          where: { id: rec.id },
          data: {
            url: nextUrl,
            formats: nextFormats,
          },
        });
        updated++;
      }
      if (batch.length < pageSize) break;
      page += 1;
    }

    return { updated, previewMatchCount: preview.matchCount };
  },

  /**
   * Comprehensive connection test that verifies every permission needed for a successful copy.
   *
   * When separate destination credentials are provided the batch uses GetObject→PutObject
   * (stream-through) because CopyObject is a single-identity call and neither the source
   * nor destination identity alone can read AND write across accounts.
   *
   * Steps verified:
   *  1. s3:ListBucket on source      (listClient / source creds)
   *  2. s3:GetObject  on source      (listClient / source creds)
   *  3. s3:ListBucket on destination  (copyClient / dest or source creds)
   *  4. s3:PutObject  on destination  (copyClient) — trial transfer of the first object
   *
   * When the same credentials are used for both sides, step 4 uses CopyObject (efficient).
   * When separate destination credentials are used, step 4 streams through the server
   * (GetObject with source creds → PutObject with dest creds).
   */
  async testS3Connection(input: S3ClientsContext): Promise<{
    ok: boolean;
    message: string;
    sourceObjectCount?: number;
    sourceObjectCountTruncated?: boolean;
  }> {
    const steps: string[] = [];
    try {
      const { listClient, copyClient, separateDestCreds } = buildS3Clients(input);

      const normSrcPrefix = normalizePrefix(input.sourcePrefix || '');
      const normDestPrefix = normalizePrefix(input.destPrefix || '');

      // Step 1 — list source (source creds)
      const sourceList = await listClient.send(
        new ListObjectsV2Command({
          Bucket: input.sourceBucket,
          Prefix: normSrcPrefix,
          MaxKeys: 5,
        })
      );
      steps.push('Source: list OK');

      const firstKey = (sourceList.Contents ?? []).find((o) => o.Key)?.Key;

      if (firstKey) {
        // Step 2 — verify source creds can read objects (HeadObject via listClient)
        try {
          await listClient.send(
            new HeadObjectCommand({
              Bucket: input.sourceBucket,
              Key: firstKey,
            })
          );
          steps.push('Source: read OK');
        } catch (e) {
          const detail = e instanceof Error ? ` Underlying error: ${e.message}` : '';
          return {
            ok: false,
            message:
              'Source credentials can list the bucket but cannot read objects (HeadObject failed). ' +
              `Ensure the source IAM identity has s3:GetObject.${detail}`,
          };
        }

        // Step 3 — list destination (dest creds or source creds)
        try {
          await copyClient.send(
            new ListObjectsV2Command({
              Bucket: input.destBucket,
              Prefix: normDestPrefix,
              MaxKeys: 1,
            })
          );
          steps.push('Destination: list OK');
        } catch (e) {
          const detail = e instanceof Error ? ` Underlying error: ${e.message}` : '';
          return {
            ok: false,
            message:
              'Cannot list the destination bucket. Ensure the destination IAM identity has s3:ListBucket on the destination bucket, ' +
              `the bucket name is correct, and the destination region matches where the bucket actually lives.${detail}`,
          };
        }

        // Step 4 — trial transfer of the first object
        // Use normalised prefixes so "pre-final" + "upload/a.webp" → "pre-final/upload/a.webp"
        const rel = relativeKeyFromSource(firstKey, normSrcPrefix);
        const destKey = joinDestObjectKey(normDestPrefix, rel);

        try {
          if (separateDestCreds) {
            // Cross-account: GetObject then PutObject (buffer body — SDK cannot sign tiny stream chunks)
            const getResp = await listClient.send(
              new GetObjectCommand({ Bucket: input.sourceBucket, Key: firstKey })
            );
            const buf = await s3GetObjectBodyToBuffer(getResp.Body);
            await copyClient.send(
              new PutObjectCommand({
                Bucket: input.destBucket,
                Key: destKey,
                Body: buf,
                ContentType: getResp.ContentType,
                ContentLength: buf.length,
              })
            );
            steps.push('Destination: write OK (trial get+put of first object)');
          } else {
            // Same-identity: efficient server-side copy
            await copyClient.send(
              new CopyObjectCommand({
                Bucket: input.destBucket,
                Key: destKey,
                CopySource: encodeS3CopySource(input.sourceBucket, firstKey),
              })
            );
            steps.push('Destination: write OK (trial copy of first object)');
          }
        } catch (writeErr) {
          const detail = writeErr instanceof Error ? writeErr.message : '';
          return {
            ok: false,
            message:
              `Cannot write to the destination bucket (${separateDestCreds ? 'PutObject' : 'CopyObject'} failed). ` +
              `Ensure the IAM identity has s3:PutObject on the destination. ${detail}`,
          };
        }
      } else {
        await copyClient.send(
          new ListObjectsV2Command({
            Bucket: input.destBucket,
            Prefix: normDestPrefix,
            MaxKeys: 1,
          })
        );
        steps.push('Destination: list OK');
        steps.push('No objects found under source prefix — read/write check skipped');
      }

      // Count all source objects for the progress bar
      const { count, truncated } = await countSourceObjectsWithPrefix(
        listClient,
        input.sourceBucket,
        normSrcPrefix
      );

      return {
        ok: true,
        message: `All checks passed (${steps.join('; ')}). Ready to copy.`,
        sourceObjectCount: count,
        sourceObjectCountTruncated: truncated,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'S3 connection test failed';
      const context = steps.length > 0 ? ` Passed: ${steps.join('; ')}.` : '';
      return { ok: false, message: `${msg}${context}` };
    }
  },

  async copyS3Batch(input: CopyBatchInput) {
    const maxKeys = Math.min(500, Math.max(1, input.maxKeys ?? 100));
    const { listClient, copyClient, separateDestCreds } = buildS3Clients(input);
    const normSrcPrefix = normalizePrefix(input.sourcePrefix || '');
    const normDestPrefix = normalizePrefix(input.destPrefix || '');

    const list = await listClient.send(
      new ListObjectsV2Command({
        Bucket: input.sourceBucket,
        Prefix: normSrcPrefix,
        ContinuationToken: input.continuationToken,
        MaxKeys: maxKeys,
      })
    );

    const contents = list.Contents ?? [];
    const copied: string[] = [];

    for (const obj of contents) {
      if (!obj.Key) continue;
      const rel = relativeKeyFromSource(obj.Key, normSrcPrefix);
      const destKey = joinDestObjectKey(normDestPrefix, rel);

      if (separateDestCreds) {
        // Cross-account: download with source creds, upload with dest creds (buffer for SDK signing)
        const getResp = await listClient.send(
          new GetObjectCommand({ Bucket: input.sourceBucket, Key: obj.Key })
        );
        const buf = await s3GetObjectBodyToBuffer(getResp.Body);
        await copyClient.send(
          new PutObjectCommand({
            Bucket: input.destBucket,
            Key: destKey,
            Body: buf,
            ContentType: getResp.ContentType,
            ContentLength: buf.length,
          })
        );
      } else {
        // Same identity: efficient server-side copy
        await copyClient.send(
          new CopyObjectCommand({
            Bucket: input.destBucket,
            Key: destKey,
            CopySource: encodeS3CopySource(input.sourceBucket, obj.Key),
          })
        );
      }
      copied.push(obj.Key);
    }

    const out: ListObjectsV2CommandOutput['NextContinuationToken'] = list.NextContinuationToken;
    const done = !list.IsTruncated;

    return {
      copiedKeys: copied,
      nextContinuationToken: out,
      done,
      listed: contents.length,
    };
  },

  /**
   * Delete a batch of objects under a given bucket + prefix.
   * Caller loops until `done = true` passing back `nextContinuationToken` each time.
   * Requires s3:ListBucket + s3:DeleteObject on the target bucket.
   */
  async deleteS3BatchByPrefix(input: {
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    continuationToken?: string;
    maxKeys?: number;
  }) {
    const maxKeys = Math.min(1000, Math.max(1, input.maxKeys ?? 200));
    const normPrefix = normalizePrefix(input.prefix || '');
    const client = s3ClientForRegion(input.region.trim(), {
      accessKeyId: input.accessKeyId.trim(),
      secretAccessKey: input.secretAccessKey.trim(),
    });

    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: normPrefix,
        ContinuationToken: input.continuationToken,
        MaxKeys: maxKeys,
      })
    );

    const contents = list.Contents ?? [];
    let deleted = 0;

    if (contents.length > 0) {
      const toDelete = contents.filter((o) => o.Key).map((o) => ({ Key: o.Key! }));
      const delResult = await client.send(
        new DeleteObjectsCommand({
          Bucket: input.bucket,
          Delete: { Objects: toDelete, Quiet: true },
        })
      );
      if (delResult.Errors?.length) {
        const sample = delResult.Errors.slice(0, 3).map((e) => `${e.Key}: ${e.Message}`).join('; ');
        throw new Error(`Batch delete partially failed. Errors: ${sample}`);
      }
      deleted = toDelete.length;
    }

    return {
      deleted,
      nextContinuationToken: list.IsTruncated ? list.NextContinuationToken : undefined,
      done: !list.IsTruncated,
      listed: contents.length,
    };
  },
});
