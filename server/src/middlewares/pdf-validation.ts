import { open, stat } from 'fs/promises';
import type { UploadFile } from './upload-transform-helpers';

/**
 * Magic-byte validation for PDF uploads.
 *
 * A declared PDF must actually start with the `%PDF-` signature and end with the
 * `%%EOF` trailer; a file that is *not* declared as a PDF but whose bytes are one
 * is rejected as a type mismatch. No parsing of PDF internals is performed.
 */

/** `%PDF-` — the PDF file signature (ISO 32000-1 §7.5.2). */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
/** `%%EOF` — the end-of-file marker that closes a well-formed PDF. */
const PDF_EOF_MARKER = Buffer.from([0x25, 0x25, 0x45, 0x4f, 0x46]);

/**
 * The spec puts the signature at byte 0, but files produced by sloppy tooling carry
 * leading junk that every real reader tolerates, so accept it anywhere in the first 1KB.
 */
const MAX_HEADER_SEARCH_BYTES = 1024;
/** The trailer sits at the very end, possibly followed by whitespace or a few stray bytes. */
const TRAILER_SEARCH_BYTES = 2048;

/** Header version field, e.g. the `1.7` in `%PDF-1.7`. PDF 2.0 exists; nothing above it does. */
const PDF_VERSION_PATTERN = /^[12]\.[0-9]$/;

const PDF_MIME_TYPES = [
  'application/pdf',
  'application/x-pdf',
  'application/acrobat',
  'application/vnd.pdf',
  'text/pdf',
  'text/x-pdf',
];

export type PdfUploadCheck =
  /** Neither declared nor detected as a PDF — the caller should carry on with its other handlers. */
  | { outcome: 'not-pdf' }
  /** Declared as a PDF and the bytes agree. */
  | { outcome: 'valid' }
  /** `diagnostic` is for the server log only — never surfaced to the uploader. */
  | { outcome: 'invalid'; errorMessage: string; diagnostic?: string };

/** Leading bytes as hex + printable ASCII, so a rejection can be diagnosed from the log. */
function describeLeadingBytes(head: Buffer): string {
  const slice = head.subarray(0, 8);
  const hex = slice.toString('hex').replace(/(..)/g, '$1 ').trim();
  const ascii = slice.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
  return `first bytes: ${hex || '(none)'} ("${ascii}")`;
}

/** A PDF is claimed when either the client-sent mime type or the filename says so. */
export function isPdfFile(file: UploadFile): boolean {
  const mime = (file.mimetype || '').toLowerCase().trim();
  if (PDF_MIME_TYPES.includes(mime)) return true;
  return (file.originalFilename || '').toLowerCase().endsWith('.pdf');
}

/** First `length` bytes, without pulling a large upload into memory. */
async function readHead(file: UploadFile, length: number): Promise<Buffer> {
  if (file.buffer) return file.buffer.subarray(0, length);
  const handle = await open(file.filepath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Last `length` bytes (or the whole file when it is shorter). */
async function readTail(file: UploadFile, length: number): Promise<Buffer> {
  if (file.buffer) return file.buffer.subarray(Math.max(0, file.buffer.length - length));
  const handle = await open(file.filepath, 'r');
  try {
    const { size } = await handle.stat();
    const readLength = Math.min(length, size);
    if (readLength <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buf, 0, readLength, size - readLength);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function resolveFileSize(file: UploadFile): Promise<number> {
  if (typeof file.size === 'number' && file.size >= 0) return file.size;
  if (file.buffer) return file.buffer.length;
  return (await stat(file.filepath)).size;
}

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
}

/**
 * Classify an upload against the PDF magic bytes.
 *
 * Both directions are checked: a file claiming to be a PDF must prove it, and a file
 * claiming to be something else must not secretly be one.
 */
export async function inspectPdfUpload(file: UploadFile, maxSizeBytes: number): Promise<PdfUploadCheck> {
  let head: Buffer;
  try {
    head = await readHead(file, MAX_HEADER_SEARCH_BYTES);
  } catch {
    return { outcome: 'invalid', errorMessage: 'Unable to read the uploaded file for validation.' };
  }

  const headerOffset = head.indexOf(PDF_MAGIC);
  const declaredAsPdf = isPdfFile(file);

  if (!declaredAsPdf) {
    // Offset 0 only — searching the whole window would flag images that merely happen
    // to contain the byte sequence in their metadata.
    if (headerOffset === 0) {
      return {
        outcome: 'invalid',
        errorMessage: `File content is a PDF but it was uploaded as "${file.mimetype || 'unknown type'}". Upload it with a .pdf extension instead.`,
      };
    }
    return { outcome: 'not-pdf' };
  }

  try {
    const size = await resolveFileSize(file);
    if (size === 0) {
      return { outcome: 'invalid', errorMessage: 'PDF file is empty.' };
    }
    if (size > maxSizeBytes) {
      return {
        outcome: 'invalid',
        errorMessage: `PDF file is too large. Maximum is ${formatMb(maxSizeBytes)}MB.`,
      };
    }

    if (headerOffset === -1) {
      return {
        outcome: 'invalid',
        errorMessage: 'File is not a valid PDF — the %PDF- signature is missing.',
        diagnostic: `no %PDF- signature in the first ${MAX_HEADER_SEARCH_BYTES} bytes; ${describeLeadingBytes(head)}`,
      };
    }

    const versionStart = headerOffset + PDF_MAGIC.length;
    const version = head.subarray(versionStart, versionStart + 3).toString('latin1');
    if (!PDF_VERSION_PATTERN.test(version)) {
      return {
        outcome: 'invalid',
        errorMessage: 'File is not a valid PDF — the version in the header is not recognised.',
        diagnostic: `header version "${version.replace(/[^\x20-\x7e]/g, '.')}" is not a known PDF version`,
      };
    }

    const tail = await readTail(file, TRAILER_SEARCH_BYTES);
    if (tail.indexOf(PDF_EOF_MARKER) === -1) {
      return {
        outcome: 'invalid',
        errorMessage: 'PDF appears to be truncated or corrupt — the %%EOF trailer is missing.',
      };
    }

    return { outcome: 'valid' };
  } catch {
    return { outcome: 'invalid', errorMessage: 'Unable to validate PDF.' };
  }
}
