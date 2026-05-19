import { errors } from '@strapi/utils';
import FileType from 'file-type';
import { readFile, stat, writeFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import type { Core } from '@strapi/strapi';

const { ApplicationError } = errors;

export interface UploadFile {
  originalFilename: string;
  filepath: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  stream?: unknown;
}

const DANGEROUS_SVG_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/i,
  /javascript:/i,
  /vbscript:/i,
  /onload\s*=/i,
  /onclick\s*=/i,
  /onmouseover\s*=/i,
  /onerror\s*=/i,
  /onmouseout\s*=/i,
  /onkeydown\s*=/i,
  /onkeyup\s*=/i,
  /onkeypress\s*=/i,
  /onfocus\s*=/i,
  /onblur\s*=/i,
  /onchange\s*=/i,
  /onsubmit\s*=/i,
  /onreset\s*=/i,
  /onselect\s*=/i,
  /onunload\s*=/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /<link\b/i,
  /<meta\b/i,
  /xlink:href\s*=\s*["']javascript:/i,
  /href\s*=\s*["']javascript:/i,
  /data:text\/html/i,
  /data:image\/svg\+xml.*base64.*script/i,
];

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

const SUSPICIOUS_ELEMENT_PATTERNS = [
  /<script\b/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /<foreignObject\b/i,
  /<animation\b/i,
  /<set\b/i,
  /<animateTransform\b/i,
];

const MAX_SVG_FILE_SIZE = 5 * 1024 * 1024;

async function validateSVGSecurity(filePath: string, fileSize?: number) {
  try {
    if (fileSize && fileSize > MAX_SVG_FILE_SIZE) {
      return { isValid: false, errorMessage: `SVG file is too large. Maximum is ${MAX_SVG_FILE_SIZE / (1024 * 1024)}MB.` };
    }
    if (!fileSize) {
      const stats = await stat(filePath);
      if (stats.size > MAX_SVG_FILE_SIZE) {
        return { isValid: false, errorMessage: `SVG file is too large. Maximum is ${MAX_SVG_FILE_SIZE / (1024 * 1024)}MB.` };
      }
    }
    const svgContent = await readFile(filePath, 'utf-8');
    for (const pattern of DANGEROUS_SVG_PATTERNS) {
      if (pattern.test(svgContent)) {
        return { isValid: false, errorMessage: 'SVG contains potentially unsafe content.' };
      }
    }
    for (const pattern of SUSPICIOUS_ELEMENT_PATTERNS) {
      if (pattern.test(svgContent)) {
        return { isValid: false, errorMessage: 'SVG contains disallowed elements.' };
      }
    }
    return { isValid: true };
  } catch {
    return { isValid: false, errorMessage: 'Unable to validate SVG.' };
  }
}

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

export function isSVGFile(file: UploadFile) {
  return SVG_MIME_TYPES.includes(file.mimetype) || file.originalFilename.toLowerCase().endsWith('.svg');
}

export async function assertBufferIsWebP(file: UploadFile) {
  const buffer = file.buffer ?? (await readFile(file.filepath));
  const detected = await FileType.fromBuffer(buffer);
  if (detected?.mime !== 'image/webp') {
    throw new ApplicationError('File does not appear to be a valid WebP image.');
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
    throw new ApplicationError('Could not process this image as WebP.');
  }
}

export async function processUploadFiles(ctx: any, strapi: Core.Strapi) {
  const { webpConversionEnabled, webpQuality } = await strapi
    .plugin('strapi-media-webp-convertor')
    .service('settings')
    .get();

  if (!webpConversionEnabled) return;

  const files = ctx.request.files?.files;
  if (!files) return;
  const filesToProcess = Array.isArray(files) ? files : [files];

  for (let fileIndex = 0; fileIndex < filesToProcess.length; fileIndex++) {
    const file = filesToProcess[fileIndex] as UploadFile;
    try {
      if (!file?.filepath || !file?.originalFilename) {
        throw new ApplicationError('Invalid file upload.');
      }
      const isImage = await isImageFile(file);
      const isSvg = isSVGFile(file);
      if (isSvg) {
        const validationResult = await validateSVGSecurity(file.filepath, file.size);
        if (!validationResult.isValid) {
          throw new ApplicationError(validationResult.errorMessage || 'SVG validation failed');
        }
      } else if (isImage) {
        if (isWebPFile(file)) {
          await assertBufferIsWebP(file);
        } else {
          await convertRasterUploadToWebP(strapi, file, webpQuality);
        }
        syncFileInfoNameWithMultipartFile(strapi, ctx, fileIndex, file);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      strapi.log.error(
        `[strapi-media-webp-convertor] File "${file?.originalFilename || 'unknown'}": ${msg}`
      );
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(msg || 'Upload processing failed');
    }
  }
}
