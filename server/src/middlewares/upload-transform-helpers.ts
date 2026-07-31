import FileType from 'file-type';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import type { Core } from '@strapi/strapi';
import { scanPdfActiveContent } from './pdf-active-content';
import { inspectPdfUpload, isPdfFile } from './pdf-validation';
import { hasSvgSignature, isSvgFile, validateSvgFile } from './svg-validation';
import { UploadRejectedError } from './upload-rejection';

export interface UploadFile {
  originalFilename: string;
  filepath: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  stream?: unknown;
}

const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/heif-sequence',
];

const HEIC_HEIF_EXTENSIONS = /\.(heic|heif)$/i;
const SVG_MIME_TYPES = ['image/svg+xml', 'application/svg+xml'];

function isHeicHeifExtension(filename: string) {
  return HEIC_HEIF_EXTENSIONS.test(filename);
}

export async function isImageFile(file: UploadFile): Promise<boolean> {
  if (SVG_MIME_TYPES.includes(file.mimetype) || IMAGE_MIME_TYPES.includes(file.mimetype)) {
    return true;
  }
  if (isHeicHeifExtension(file.originalFilename)) {
    return true;
  }
  try {
    let buffer: Buffer;
    if (file.buffer) buffer = file.buffer;
    else if (file.filepath) buffer = await readFile(file.filepath);
    else return false;
    const detected = await FileType.fromBuffer(buffer);
    if (!detected?.mime) return false;
    if (SVG_MIME_TYPES.includes(detected.mime) || IMAGE_MIME_TYPES.includes(detected.mime)) return true;
    if (detected.mime === 'image/heif' || detected.mime === 'image/heic') return true;
    return false;
  } catch {
    return false;
  }
}

export function isWebPFile(file: UploadFile) {
  return file.mimetype === 'image/webp' || file.originalFilename.toLowerCase().endsWith('.webp');
}

export async function assertBufferIsWebP(file: UploadFile) {
  const buffer = file.buffer ?? (await readFile(file.filepath));
  const detected = await FileType.fromBuffer(buffer);
  if (detected?.mime !== 'image/webp') {
    throw new UploadRejectedError('File does not appear to be a valid WebP image.');
  }
}

export function filenameWithWebpExtension(originalFilename: string) {
  const parsed = path.parse(originalFilename);
  const base = parsed.name || 'image';
  return `${base}.webp`;
}

function applyWebpNameToFileInfoObject(obj: Record<string, unknown>, file: UploadFile) {
  if (obj && typeof obj === 'object') {
    obj.name = file.originalFilename;
  }
}

export function syncFileInfoNameWithMultipartFile(
  strapi: Core.Strapi,
  ctx: { request?: { body?: unknown } },
  fileIndex: number,
  file: UploadFile
) {
  const body = ctx.request?.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return;

  const roots: Record<string, unknown>[] = [body];
  const rawData = body.data;
  if (typeof rawData === 'string') {
    try {
      const parsed = JSON.parse(rawData) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') roots.push(parsed);
    } catch {
      /* ignore */
    }
  } else if (rawData && typeof rawData === 'object') {
    roots.push(rawData as Record<string, unknown>);
  }

  for (const root of roots) {
    if (!root.fileInfo) continue;
    try {
      const fi = root.fileInfo;
      if (typeof fi === 'string') {
        const parsed: unknown = JSON.parse(fi);
        if (Array.isArray(parsed)) {
          if (parsed[fileIndex]) applyWebpNameToFileInfoObject(parsed[fileIndex] as Record<string, unknown>, file);
          root.fileInfo = parsed.map((item) => JSON.stringify(item));
        } else {
          applyWebpNameToFileInfoObject(parsed as Record<string, unknown>, file);
          root.fileInfo = JSON.stringify(parsed);
        }
      } else if (Array.isArray(fi)) {
        for (let i = 0; i < fi.length; i++) {
          const item = fi[i];
          const obj =
            typeof item === 'string' ? (JSON.parse(item) as Record<string, unknown>) : (item as Record<string, unknown>);
          if (i === fileIndex) applyWebpNameToFileInfoObject(obj, file);
          fi[i] = typeof item === 'string' ? JSON.stringify(obj) : obj;
        }
      } else if (typeof fi === 'object' && fi !== null) {
        applyWebpNameToFileInfoObject(fi as Record<string, unknown>, file);
      }
      if (root !== body && body.data !== undefined) {
        const bd = body.data;
        if (typeof bd === 'string') {
          body.data = JSON.stringify(root);
        }
      }
    } catch (e) {
      strapi.log.warn('[strapi-media-webp-convertor] fileInfo sync skipped', e);
    }
  }
}


export function isStrapiMultipartUpload(ctx: { request?: { method?: string; files?: { files?: unknown } }; path?: string }) {
  if (ctx.request?.method !== 'POST' || !ctx.request?.files?.files) return false;
  const p = (ctx.path || '').replace(/\/+$/, '') || ctx.path || '';
  return p === '/upload' || p === '/api/upload' || p.endsWith('/upload') || p.includes('/plugins/upload');
}

export async function convertRasterUploadToWebP(strapi: Core.Strapi, file: UploadFile, webpQuality: number) {
  const input = await readFile(file.filepath);
  try {
    const webpBuffer = await sharp(input, { failOn: 'error' }).rotate().webp({ quality: webpQuality }).toBuffer();
    await writeFile(file.filepath, webpBuffer);
    file.mimetype = 'image/webp';
    file.size = webpBuffer.length;
    file.originalFilename = filenameWithWebpExtension(file.originalFilename);
    if (file.buffer !== undefined) file.buffer = webpBuffer;
  } catch (err) {
    strapi.log.error('[strapi-media-webp-convertor] Sharp WebP conversion failed:', err);
    throw new UploadRejectedError('Could not process this image as WebP.');
  }
}

export async function processUploadFiles(ctx: any, strapi: Core.Strapi) {
  const {
    webpConversionEnabled,
    webpQuality,
    pdfValidationEnabled,
    maxPdfSizeMb,
    blockPdfActiveContent,
  } = await strapi.plugin('strapi-media-webp-convertor').service('settings').get();

  const files = ctx.request.files?.files;
  if (!files) return;
  const filesToProcess = Array.isArray(files) ? files : [files];

  for (let fileIndex = 0; fileIndex < filesToProcess.length; fileIndex++) {
    const file = filesToProcess[fileIndex] as UploadFile;
    try {
      if (!file?.filepath || !file?.originalFilename) {
        throw new UploadRejectedError('Invalid file upload.');
      }

      if (pdfValidationEnabled) {
        const pdfCheck = await inspectPdfUpload(file, maxPdfSizeMb * 1024 * 1024);
        if (pdfCheck.outcome === 'invalid') {
          if (pdfCheck.diagnostic) {
            strapi.log.warn(
              `[strapi-media-webp-convertor] "${file.originalFilename}" rejected — ${pdfCheck.diagnostic}`
            );
          }
          throw new UploadRejectedError(pdfCheck.errorMessage);
        }
        if (pdfCheck.outcome === 'valid') {
          // Only reached once the size limit has passed, so reading the whole file is bounded.
          if (blockPdfActiveContent) {
            const scan = scanPdfActiveContent(file.buffer ?? (await readFile(file.filepath)));
            if (scan.outcome === 'blocked') {
              strapi.log.warn(
                `[strapi-media-webp-convertor] "${file.originalFilename}" active content — ${scan.diagnostic}`
              );
              throw new UploadRejectedError(scan.errorMessage);
            }
            if (scan.outcome === 'inconclusive') {
              strapi.log.warn(
                `[strapi-media-webp-convertor] "${file.originalFilename}" stored, but the active-content scan was incomplete — ${scan.diagnostic}`
              );
            }
          }
          // Bytes are confirmed, so a `.pdf` sent as octet-stream can be safely normalised.
          file.mimetype = 'application/pdf';
          continue;
        }
      } else if (isPdfFile(file)) {
        continue;
      }

      // Content security scanning is never gated on `webpConversionEnabled` — pausing the
      // convertor must not quietly re-open the door to scriptable uploads. Sniffing the bytes
      // as well as the declared type catches an SVG renamed to slip past the extension check.
      if (isSvgFile(file) || (await hasSvgSignature(file))) {
        const svgCheck = await validateSvgFile(file);
        if (svgCheck.outcome === 'invalid') {
          throw new UploadRejectedError(svgCheck.errorMessage);
        }
        continue;
      }

      if (!webpConversionEnabled) continue;

      if (await isImageFile(file)) {
        if (isWebPFile(file)) {
          await assertBufferIsWebP(file);
        } else {
          await convertRasterUploadToWebP(strapi, file, webpQuality);
        }
        syncFileInfoNameWithMultipartFile(strapi, ctx, fileIndex, file);
      }
    } catch (error) {
      const name = file?.originalFilename || 'unknown';

      // A refusal is expected behaviour: log it as such and let the middleware return 400 with
      // the reason. Anything else is a fault on our side — it keeps its stack, is logged at
      // error level, and propagates so the middleware answers 500 with a generic message rather
      // than handing the uploader a raw internal error (which can carry temp-file paths).
      if (error instanceof UploadRejectedError) {
        strapi.log.warn(`[strapi-media-webp-convertor] Upload refused — "${name}": ${error.message}`);
        throw error;
      }
      strapi.log.error(`[strapi-media-webp-convertor] Unexpected error processing "${name}"`, error);
      throw error;
    }
  }
}
