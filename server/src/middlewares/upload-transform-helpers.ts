import FileType from 'file-type';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from '../constants';
import { applyFileTypePolicy } from './file-type-policy';
import { checkUploadFilename, randomisedFilename } from './filename-safety';
import { scanPdfActiveContent } from './pdf-active-content';
import { inspectPdfUpload, isPdfFile } from './pdf-validation';
import { SVG_MIME_TYPES, hasSvgSignature, isSvgFile, validateSvgFile } from './svg-validation';
import {
  TYPE_SNIFF_BYTES,
  readHeadBytes,
  type UploadFile,
} from './upload-file';
import { UploadRejectedError } from './upload-rejection';

export type { UploadFile };

const LOG_PREFIX = `[${PLUGIN_NAME}]`;

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

function isHeicHeifExtension(filename: string) {
  return HEIC_HEIF_EXTENSIONS.test(filename);
}

/**
 * Sniff the declared type from the leading bytes. Only a few kilobytes are needed, so this must
 * never read the whole upload — a large non-image would otherwise be loaded into memory in full
 * just to discover it is not an image.
 */
async function detectMimeFromBytes(file: UploadFile): Promise<string | undefined> {
  if (!file.buffer && !file.filepath) return undefined;
  const head = await readHeadBytes(file, TYPE_SNIFF_BYTES);
  const detected = await FileType.fromBuffer(head);
  return detected?.mime;
}

export async function isImageFile(file: UploadFile): Promise<boolean> {
  if (SVG_MIME_TYPES.includes(file.mimetype) || IMAGE_MIME_TYPES.includes(file.mimetype)) {
    return true;
  }
  if (isHeicHeifExtension(file.originalFilename)) {
    return true;
  }
  try {
    const mime = await detectMimeFromBytes(file);
    if (!mime) return false;
    // An SVG that slipped past the earlier checks lands here so sharp can rasterise it, which
    // discards any embedded script along with the XML.
    if (SVG_MIME_TYPES.includes(mime) || IMAGE_MIME_TYPES.includes(mime)) return true;
    return mime === 'image/heif' || mime === 'image/heic';
  } catch {
    return false;
  }
}

export function isWebPFile(file: UploadFile) {
  return file.mimetype === 'image/webp' || file.originalFilename.toLowerCase().endsWith('.webp');
}

export async function assertBufferIsWebP(file: UploadFile) {
  if ((await detectMimeFromBytes(file)) !== 'image/webp') {
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
      strapi.log.warn(`${LOG_PREFIX} fileInfo sync skipped`, e);
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
    strapi.log.error(`${LOG_PREFIX} Sharp WebP conversion failed:`, err);
    throw new UploadRejectedError('Could not process this image as WebP.');
  }
}

type UploadSettings = {
  webpConversionEnabled: boolean;
  webpQuality: number;
  pdfValidationEnabled: boolean;
  maxSvgSizeMb: number;
  blockPdfActiveContent: boolean;
  fileTypePolicyEnabled: boolean;
  allowedFileExtensions: string[];
  blockMultipleExtensions: boolean;
  randomizeStoredFilenames: boolean;
};

/**
 * Default-deny gate: the filename must be safe and the bytes must be a type we permit.
 *
 * Runs before every other handler and independently of `webpConversionEnabled`, so pausing the
 * convertor cannot reopen the door. The validated name is written back onto the file, which matters
 * because Strapi core derives the extension from the name with `path.extname()` — validating one
 * string and letting core parse a different one is how filename tricks survive.
 */
async function enforceUploadPolicy(
  ctx: any,
  strapi: Core.Strapi,
  file: UploadFile,
  fileIndex: number,
  settings: UploadSettings
) {
  const nameCheck = checkUploadFilename(file.originalFilename);
  if (nameCheck.outcome === 'invalid') {
    if (nameCheck.diagnostic) {
      strapi.log.warn(`${LOG_PREFIX} filename rejected — ${nameCheck.diagnostic}`);
    }
    throw new UploadRejectedError(nameCheck.errorMessage);
  }

  if (nameCheck.safeName !== file.originalFilename) {
    file.originalFilename = nameCheck.safeName;
    syncFileInfoNameWithMultipartFile(strapi, ctx, fileIndex, file);
  }

  const typeCheck = await applyFileTypePolicy(
    file,
    file.originalFilename,
    settings.allowedFileExtensions,
    { blockMultipleExtensions: settings.blockMultipleExtensions }
  );
  if (typeCheck.outcome === 'rejected') {
    if (typeCheck.diagnostic) {
      strapi.log.warn(
        `${LOG_PREFIX} "${file.originalFilename}" rejected — ${typeCheck.diagnostic}`
      );
    }
    throw new UploadRejectedError(typeCheck.errorMessage);
  }
}

/**
 * Validation and normalisation for a single upload: PDF checks, SVG scanning, WebP conversion.
 * Returns early once a file has been fully handled by one of those paths.
 */
async function transformSingleUpload(
  ctx: any,
  strapi: Core.Strapi,
  file: UploadFile,
  fileIndex: number,
  settings: UploadSettings
) {
  const {
    webpConversionEnabled,
    webpQuality,
    pdfValidationEnabled,
    maxSvgSizeMb,
    blockPdfActiveContent,
  } = settings;

  if (pdfValidationEnabled) {
    const pdfCheck = await inspectPdfUpload(file);
    if (pdfCheck.outcome === 'invalid') {
      if (pdfCheck.diagnostic) {
        strapi.log.warn(`${LOG_PREFIX} "${file.originalFilename}" rejected — ${pdfCheck.diagnostic}`);
      }
      throw new UploadRejectedError(pdfCheck.errorMessage);
    }
    if (pdfCheck.outcome === 'valid') {
      // Streams the file, so this runs at any size the host accepts — no PDF is stored unscanned.
      if (blockPdfActiveContent) {
        const scan = await scanPdfActiveContent(file);
        if (scan.outcome === 'blocked') {
          strapi.log.warn(
            `${LOG_PREFIX} "${file.originalFilename}" active content — ${scan.diagnostic}`
          );
          throw new UploadRejectedError(scan.errorMessage);
        }
        if (scan.outcome === 'inconclusive') {
          strapi.log.warn(
            `${LOG_PREFIX} "${file.originalFilename}" stored, but the active-content scan was incomplete — ${scan.diagnostic}`
          );
        }
      }
      // Bytes are confirmed, so a `.pdf` sent as octet-stream can be safely normalised.
      file.mimetype = 'application/pdf';
      return;
    }
  } else if (isPdfFile(file)) {
    return;
  }

  // Content security scanning is never gated on `webpConversionEnabled` — pausing the
  // convertor must not quietly re-open the door to scriptable uploads. Sniffing the bytes
  // as well as the declared type catches an SVG renamed to slip past the extension check.
  if (isSvgFile(file) || (await hasSvgSignature(file))) {
    const svgCheck = await validateSvgFile(file, maxSvgSizeMb * 1024 * 1024);
    if (svgCheck.outcome === 'invalid') {
      throw new UploadRejectedError(svgCheck.errorMessage);
    }
    return;
  }

  if (!webpConversionEnabled) return;

  if (await isImageFile(file)) {
    if (isWebPFile(file)) {
      await assertBufferIsWebP(file);
    } else {
      await convertRasterUploadToWebP(strapi, file, webpQuality);
    }
    syncFileInfoNameWithMultipartFile(strapi, ctx, fileIndex, file);
  }
}

export async function processUploadFiles(ctx: any, strapi: Core.Strapi) {
  const settings = (await strapi
    .plugin(PLUGIN_NAME)
    .service('settings')
    .get()) as UploadSettings;

  const files = ctx.request.files?.files;
  if (!files) return;
  const filesToProcess = Array.isArray(files) ? files : [files];

  for (let fileIndex = 0; fileIndex < filesToProcess.length; fileIndex++) {
    const file = filesToProcess[fileIndex] as UploadFile;
    try {
      if (!file?.filepath || !file?.originalFilename) {
        throw new UploadRejectedError('Invalid file upload.');
      }

      if (settings.fileTypePolicyEnabled) {
        await enforceUploadPolicy(ctx, strapi, file, fileIndex, settings);
      }

      await transformSingleUpload(ctx, strapi, file, fileIndex, settings);

      // Last, so the extension is the final one — a JPEG that became a WebP is renamed as a WebP.
      if (settings.randomizeStoredFilenames) {
        file.originalFilename = randomisedFilename(file.originalFilename);
        syncFileInfoNameWithMultipartFile(strapi, ctx, fileIndex, file);
      }
    } catch (error) {
      const name = file?.originalFilename || 'unknown';

      // A refusal is expected behaviour: log it as such and let the middleware return 400 with
      // the reason. Anything else is a fault on our side — it keeps its stack, is logged at
      // error level, and propagates so the middleware answers 500 with a generic message rather
      // than handing the uploader a raw internal error (which can carry temp-file paths).
      if (error instanceof UploadRejectedError) {
        strapi.log.warn(`${LOG_PREFIX} Upload refused — "${name}": ${error.message}`);
        throw error;
      }
      strapi.log.error(`${LOG_PREFIX} Unexpected error processing "${name}"`, error);
      throw error;
    }
  }
}
