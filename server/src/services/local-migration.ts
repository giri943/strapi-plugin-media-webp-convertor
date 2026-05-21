import type { Core } from '@strapi/strapi';
import { DeleteObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { FILE_MODEL_UID } from '../constants';

const LOCAL_URL_PREFIX = '/uploads/';
const FOLDER_MODEL_UID = 'plugin::upload.folder';

/** Build a map of folderPath (e.g. "/1/3") → human-readable path (e.g. "blog/images"). */
async function buildFolderMap(strapi: Core.Strapi): Promise<Map<string, string>> {
  const folders = (await strapi.db.query(FOLDER_MODEL_UID).findMany({
    select: ['name', 'path'],
  })) as { name: string; path: string }[];

  const pathToName = new Map<string, string>();
  for (const f of folders) {
    if (f.path && f.name) pathToName.set(f.path, f.name);
  }

  const pathToReadable = new Map<string, string>();
  for (const f of folders) {
    if (!f.path) continue;
    const segments = f.path.split('/').filter(Boolean);
    const names: string[] = [];
    let current = '';
    for (const seg of segments) {
      current += `/${seg}`;
      const name = pathToName.get(current);
      if (name) names.push(name);
    }
    pathToReadable.set(f.path, names.join('/'));
  }

  return pathToReadable;
}

function s3Client(region: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

function buildS3Key(filename: string, keyPrefix: string, folderReadable: string): string {
  const parts = [keyPrefix, folderReadable, filename].filter(Boolean);
  return parts.join('/');
}

function buildUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${key}`;
}

/** Resolve a filename under public/uploads, refusing paths that escape the uploads root. */
function safeUploadPath(publicDir: string, filename: string): string | null {
  const uploadsRoot = path.resolve(publicDir, 'uploads');
  const candidate = path.resolve(uploadsRoot, filename);
  if (candidate !== uploadsRoot && !candidate.startsWith(uploadsRoot + path.sep)) return null;
  return candidate;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export type LocalMigrationConfig = {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  baseUrl: string;
  keyPrefix: string;
  preserveFolders: boolean;
  deleteLocal: boolean;
};

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getStats() {
    const count = await strapi.db.query(FILE_MODEL_UID).count({
      where: { url: { $startsWith: LOCAL_URL_PREFIX } },
    });

    const files = (await strapi.db.query(FILE_MODEL_UID).findMany({
      where: { url: { $startsWith: LOCAL_URL_PREFIX } },
      select: ['size'],
    })) as { size: number }[];

    const totalSizeMB = files.reduce((acc, f) => acc + (f.size || 0), 0) / 1024;

    return { count, totalSizeMB: Math.round(totalSizeMB * 100) / 100 };
  },

  async testConnection(config: Pick<LocalMigrationConfig, 'region' | 'bucket' | 'accessKeyId' | 'secretAccessKey'>) {
    const client = s3Client(config.region, config.accessKeyId, config.secretAccessKey);
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    } catch (e: any) {
      if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
        throw new Error(`Bucket "${config.bucket}" not found or not accessible.`);
      }
      if (e?.$metadata?.httpStatusCode === 403) {
        throw new Error(`Access denied to bucket "${config.bucket}". Check IAM permissions (s3:ListBucket required).`);
      }
      throw new Error(e instanceof Error ? e.message : 'S3 connection failed');
    }

    // Verify write access with a tiny probe object then immediately delete it
    const probeKey = `.webp-convertor-probe-${Date.now()}`;
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: probeKey,
          Body: Buffer.from('probe'),
          ContentType: 'text/plain',
        })
      );
    } catch {
      throw new Error(
        `Can list bucket "${config.bucket}" but cannot write objects. Check IAM permissions (s3:PutObject required).`
      );
    }
    // Clean up the probe — fire and forget, a leftover probe is harmless but untidy
    client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: probeKey })).catch(() => {});

    return { ok: true, message: 'Connection OK — bucket is reachable and writable.' };
  },

  async migrateBatch(
    offset: number,
    batchSize: number,
    config: LocalMigrationConfig
  ) {
    const { region, bucket, accessKeyId, secretAccessKey, baseUrl, keyPrefix, preserveFolders, deleteLocal } = config;

    const client = s3Client(region, accessKeyId, secretAccessKey);
    const publicDir = path.join(process.cwd(), 'public');

    const folderMap = preserveFolders ? await buildFolderMap(strapi) : new Map<string, string>();

    const files = (await strapi.db.query(FILE_MODEL_UID).findMany({
      where: { url: { $startsWith: LOCAL_URL_PREFIX } },
      select: ['id', 'url', 'mime', 'formats', 'folderPath'],
      limit: batchSize,
      offset,
    })) as { id: number; url: string; mime: string; formats: Record<string, any> | null; folderPath: string | null }[];

    const results: { id: number; ok: boolean; newUrl?: string; error?: string }[] = [];

    for (const file of files) {
      try {
        const folderReadable = preserveFolders && file.folderPath ? (folderMap.get(file.folderPath) ?? '') : '';

        const mainFilename = file.url.replace(LOCAL_URL_PREFIX, '');
        const mainLocalPath = safeUploadPath(publicDir, mainFilename);
        if (!mainLocalPath) {
          results.push({ id: file.id, ok: false, error: `Refusing unsafe file path: ${mainFilename}` });
          continue;
        }

        if (!(await fileExists(mainLocalPath))) {
          results.push({ id: file.id, ok: false, error: `File not found on disk: ${mainFilename}` });
          continue;
        }

        // Upload main file
        const mainKey = buildS3Key(mainFilename, keyPrefix, folderReadable);
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: mainKey,
            Body: await fs.promises.readFile(mainLocalPath),
            ContentType: file.mime,
          })
        );

        // Upload format variants
        const newFormats: Record<string, any> = {};
        if (file.formats && typeof file.formats === 'object') {
          for (const [formatName, fmt] of Object.entries(file.formats)) {
            const fmtFilename = typeof fmt?.url === 'string' ? fmt.url.replace(LOCAL_URL_PREFIX, '') : null;
            if (!fmtFilename) {
              newFormats[formatName] = fmt;
              continue;
            }
            const fmtLocalPath = safeUploadPath(publicDir, fmtFilename);
            if (fmtLocalPath && (await fileExists(fmtLocalPath))) {
              const fmtKey = buildS3Key(fmtFilename, keyPrefix, folderReadable);
              await client.send(
                new PutObjectCommand({
                  Bucket: bucket,
                  Key: fmtKey,
                  Body: await fs.promises.readFile(fmtLocalPath),
                  ContentType: fmt.mime || file.mime,
                })
              );
              newFormats[formatName] = { ...fmt, url: buildUrl(baseUrl, fmtKey) };
            } else {
              newFormats[formatName] = fmt;
            }
          }
        }

        const newMainUrl = buildUrl(baseUrl, mainKey);

        // Update DB before deleting local files
        await strapi.db.query(FILE_MODEL_UID).update({
          where: { id: file.id },
          data: {
            url: newMainUrl,
            ...(Object.keys(newFormats).length > 0 ? { formats: newFormats } : {}),
          },
        });

        // Delete local files only after DB is updated
        if (deleteLocal) {
          await fs.promises.rm(mainLocalPath, { force: true });
          if (file.formats) {
            for (const fmt of Object.values(file.formats)) {
              const fmtFilename = typeof fmt?.url === 'string' ? fmt.url.replace(LOCAL_URL_PREFIX, '') : null;
              if (fmtFilename) {
                const fmtLocalPath = safeUploadPath(publicDir, fmtFilename);
                if (fmtLocalPath && (await fileExists(fmtLocalPath))) {
                  await fs.promises.rm(fmtLocalPath, { force: true });
                }
              }
            }
          }
        }

        results.push({ id: file.id, ok: true, newUrl: newMainUrl });
      } catch (err) {
        results.push({ id: file.id, ok: false, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    const remaining = await strapi.db.query(FILE_MODEL_UID).count({
      where: { url: { $startsWith: LOCAL_URL_PREFIX } },
    });

    return {
      results,
      processed: files.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      remaining,
      done: remaining === 0,
    };
  },
});
