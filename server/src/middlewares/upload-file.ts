import { open, readFile, stat } from 'fs/promises';

/**
 * The multipart file shape Strapi's body parser hands to the upload middleware, plus the byte
 * readers the validators share.
 *
 * Reads are deliberately partial. Type sniffing needs a few kilobytes, and a signature check
 * needs the head and tail — pulling a 500 MB upload into memory to look at its first eight bytes
 * is the kind of thing that only shows up under load.
 */
export interface UploadFile {
  originalFilename: string;
  filepath: string;
  mimetype: string;
  size: number;
  /** Present only when the host is configured to buffer uploads in memory. */
  buffer?: Buffer;
}

/** Enough for `file-type` to identify every format this plugin cares about. */
export const TYPE_SNIFF_BYTES = 8192;

/** First `length` bytes of the upload. */
export async function readHeadBytes(file: UploadFile, length: number): Promise<Buffer> {
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

/** Last `length` bytes of the upload, or the whole file when it is shorter. */
export async function readTailBytes(file: UploadFile, length: number): Promise<Buffer> {
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

/** Whole file. Only for callers that genuinely need every byte, and only behind a size limit. */
export async function readWholeUpload(file: UploadFile): Promise<Buffer> {
  return file.buffer ?? (await readFile(file.filepath));
}

/** Trust the parser's size when it looks sane, otherwise ask the filesystem. */
export async function resolveUploadSize(file: UploadFile): Promise<number> {
  if (typeof file.size === 'number' && file.size >= 0) return file.size;
  if (file.buffer) return file.buffer.length;
  return (await stat(file.filepath)).size;
}
