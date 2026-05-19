import type { Core } from '@strapi/strapi';
import sharp from 'sharp';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FILE_MODEL_UID } from '../constants';

const CONVERTIBLE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/x-tiff',
  'image/heic',
  'image/heif',
  'image/x-heic',
]);

async function downloadBuffer(url: string, publicDir: string): Promise<Buffer> {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching file`);
    return Buffer.from(await resp.arrayBuffer());
  }
  const rel = url.startsWith('/') ? url.slice(1) : url;
  return fs.promises.readFile(path.join(publicDir, rel));
}

async function toWebPBuffer(buffer: Buffer, quality: number, lossless = false): Promise<Buffer> {
  const pipeline = sharp(buffer, { failOn: 'error' }).rotate();
  return lossless ? pipeline.webp({ lossless: true }).toBuffer() : pipeline.webp({ quality }).toBuffer();
}

function swapToWebpName(name: string): string {
  return name.replace(/\.[^.]+$/, '') + '.webp';
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  function getPublicDir(): string {
    const dirs = (strapi as any).dirs as { static?: { public?: string } } | undefined;
    return dirs?.static?.public ?? path.join(process.cwd(), 'public');
  }

  function getProvider(): { upload: (f: any) => Promise<void>; delete: (f: any) => Promise<void> } {
    return (strapi.plugin('upload') as any)?.provider;
  }

  const db = () => strapi.db.query(FILE_MODEL_UID) as any;

  return {
    async getStats() {
      const [totalRes, webpRes, needRes] = await Promise.all([
        db().findPage({ page: 1, pageSize: 1, select: ['id'] }),
        db().findPage({ page: 1, pageSize: 1, select: ['id'], where: { mime: 'image/webp' } }),
        db().findPage({ page: 1, pageSize: 1, select: ['id'], where: { mime: { $in: [...CONVERTIBLE_MIMES] } } }),
      ]);
      return {
        total: totalRes.pagination.total as number,
        alreadyWebP: webpRes.pagination.total as number,
        needsConversion: needRes.pagination.total as number,
      };
    },

    async listConvertibleFiles(page: number, pageSize: number, search?: string, mimeFilter?: string) {
      const where: Record<string, unknown> = mimeFilter && CONVERTIBLE_MIMES.has(mimeFilter)
        ? { mime: mimeFilter }
        : { mime: { $in: [...CONVERTIBLE_MIMES] } };
      if (search?.trim()) where.name = { $containsi: search.trim() };

      const result = await db().findPage({
        select: ['id', 'name', 'url', 'mime', 'size', 'ext', 'hash', 'formats'],
        where,
        orderBy: { id: 'asc' },
        page,
        pageSize,
      });

      return {
        files: result.results as unknown[],
        total: result.pagination.total as number,
        page: result.pagination.page as number,
        pageSize: result.pagination.pageSize as number,
        pageCount: result.pagination.pageCount as number,
      };
    },

    async convertBatch(fileIds: number[], quality: number, losslessMimes: string[] = []) {
      const provider = getProvider();
      const publicDir = getPublicDir();
      const losslessSet = new Set(losslessMimes);

      const records: Array<{
        id: number;
        name: string;
        url: string;
        mime: string;
        size: number;
        ext: string;
        hash: string;
        formats?: Record<string, any> | null;
      }> = await db().findMany({
        select: ['id', 'name', 'url', 'mime', 'size', 'ext', 'hash', 'formats'],
        where: { id: { $in: fileIds } },
      });

      let converted = 0;
      let failed = 0;
      const errors: { id: number; name: string; error: string }[] = [];
      let totalOriginalKB = 0;
      let totalNewKB = 0;

      for (const record of records) {
        if (!CONVERTIBLE_MIMES.has(record.mime)) continue;

        try {
          // Download and convert main file
          const origBuf = await downloadBuffer(record.url, publicDir);
          const isLossless = losslessSet.has(record.mime);
          const webpBuf = await toWebPBuffer(origBuf, quality, isLossless);

          const newSizeKB = Math.round((webpBuf.length / 1024) * 100) / 100;

          const newMainFile: any = {
            name: swapToWebpName(record.name),
            hash: record.hash,
            ext: '.webp',
            mime: 'image/webp',
            size: newSizeKB,
            buffer: webpBuf,
          };
          await provider.upload(newMainFile);
          const newUrl = newMainFile.url as string;

          // Convert format variants (thumbnail, small, medium, large, etc.)
          const newFormats: Record<string, any> = {};
          if (record.formats && typeof record.formats === 'object') {
            for (const [fmtKey, fmtVal] of Object.entries(record.formats)) {
              if (!fmtVal || typeof fmtVal !== 'object') {
                newFormats[fmtKey] = fmtVal;
                continue;
              }
              const fmt = fmtVal as any;
              try {
                const fmtBuf = await downloadBuffer(fmt.url, publicDir);
                const fmtWebp = await toWebPBuffer(fmtBuf, quality, isLossless);
                const newFmtFile: any = {
                  name: swapToWebpName(fmt.name),
                  hash: fmt.hash,
                  ext: '.webp',
                  mime: 'image/webp',
                  size: Math.round((fmtWebp.length / 1024) * 100) / 100,
                  buffer: fmtWebp,
                };
                await provider.upload(newFmtFile);
                newFormats[fmtKey] = {
                  ...fmt,
                  name: newFmtFile.name,
                  ext: '.webp',
                  mime: 'image/webp',
                  size: newFmtFile.size,
                  url: newFmtFile.url,
                  path: newFmtFile.path ?? null,
                };
                // Delete old format file after new one is live
                try { await provider.delete(fmt); } catch {}
              } catch {
                // If a format variant fails, keep the old entry — don't abort the whole file
                newFormats[fmtKey] = fmt;
              }
            }
          }

          // Update DB before deleting old file (so the record always points at a valid file)
          await strapi.db.query(FILE_MODEL_UID).update({
            where: { id: record.id },
            data: {
              name: swapToWebpName(record.name),
              ext: '.webp',
              mime: 'image/webp',
              size: Math.round((webpBuf.length / 1024) * 100) / 100,
              url: newUrl,
              formats: Object.keys(newFormats).length > 0 ? newFormats : null,
            },
          });

          // Delete old main file after DB is updated
          try {
            await provider.delete({ url: record.url, hash: record.hash, ext: record.ext, name: record.name });
          } catch {}

          totalOriginalKB += record.size;
          totalNewKB += newSizeKB;
          converted++;
        } catch (err) {
          failed++;
          errors.push({
            id: record.id,
            name: record.name,
            error: err instanceof Error ? err.message : 'Conversion failed',
          });
        }
      }

      return {
        converted,
        failed,
        errors,
        originalKB: totalOriginalKB,
        newKB: totalNewKB,
        savedKB: totalOriginalKB - totalNewKB,
      };
    },
  };
};
