/**
 * Text decoding for SVG scanning.
 *
 * A scanner that assumes UTF-8 is trivially bypassed: the same `<script>` payload saved as
 * UTF-16 decodes to `<\0s\0v\0g\0…`, matches no pattern, and is stored — while the browser
 * honours the byte-order mark and executes it. Decoding the way the browser does is what makes
 * the pattern rules meaningful.
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

/** Bytes examined when guessing a BOM-less encoding. */
const ENCODING_SNIFF_BYTES = 512;

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

/** UTF-16BE → UTF-16LE. `swap16` needs an even length, so an odd trailing byte is dropped. */
function decodeUtf16BE(buf: Buffer): string {
  const even = buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1);
  return Buffer.from(even).swap16().toString('utf16le');
}

/**
 * Guess UTF-16 without a BOM by where the NUL padding lands: ASCII text encoded UTF-16LE is
 * `A \0 B \0`, UTF-16BE is `\0 A \0 B`.
 */
function sniffBomlessUtf16(buf: Buffer): 'utf16le' | 'utf16be' | null {
  const limit = Math.min(buf.length, ENCODING_SNIFF_BYTES);
  if (limit < 4) return null;
  let nullsAtOdd = 0;
  let nullsAtEven = 0;
  for (let i = 0; i < limit; i++) {
    if (buf[i] !== 0x00) continue;
    if (i % 2 === 0) nullsAtEven++;
    else nullsAtOdd++;
  }
  const threshold = limit / 8;
  if (nullsAtOdd > threshold && nullsAtOdd > nullsAtEven * 4) return 'utf16le';
  if (nullsAtEven > threshold && nullsAtEven > nullsAtOdd * 4) return 'utf16be';
  return null;
}

export type DecodedSvgText = { text: string; encoding: string };

/**
 * Decode SVG bytes to text the way a browser would. Returns the decoded text plus the encoding
 * used, so a caller can refuse content it was unable to interpret.
 */
export function decodeSvgText(raw: Buffer): DecodedSvgText {
  if (startsWith(raw, UTF8_BOM)) {
    return { text: raw.subarray(UTF8_BOM.length).toString('utf-8'), encoding: 'utf-8 (BOM)' };
  }
  if (startsWith(raw, UTF16LE_BOM)) {
    return { text: raw.subarray(UTF16LE_BOM.length).toString('utf16le'), encoding: 'utf-16le (BOM)' };
  }
  if (startsWith(raw, UTF16BE_BOM)) {
    return { text: decodeUtf16BE(raw.subarray(UTF16BE_BOM.length)), encoding: 'utf-16be (BOM)' };
  }

  const sniffed = sniffBomlessUtf16(raw);
  if (sniffed === 'utf16le') return { text: raw.toString('utf16le'), encoding: 'utf-16le (sniffed)' };
  if (sniffed === 'utf16be') return { text: decodeUtf16BE(raw), encoding: 'utf-16be (sniffed)' };

  return { text: raw.toString('utf-8'), encoding: 'utf-8' };
}

/** Matches an `<svg>` open tag, optionally namespace-prefixed. */
const SVG_ELEMENT = /^<\s*(?:[a-z0-9-]+:)?svg[\s>/]/i;

/**
 * True when `<svg>` is the document's **root element**, skipping any XML declaration, doctype
 * and comments that legitimately precede it.
 *
 * Deliberately stricter than "contains `<svg` somewhere": an HTML page or Markdown note with an
 * inline SVG example is not an SVG document, and running the SVG rules over it produces
 * confusing rejections of perfectly ordinary uploads.
 */
export function startsWithSvgElement(text: string): boolean {
  const s = text.replace(/^﻿/, '');
  let i = 0;
  // Bounded so a malformed prologue cannot spin.
  for (let step = 0; step < 50; step++) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length || s[i] !== '<') return false;

    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i);
      if (end === -1) return false;
      i = end + 3;
      continue;
    }
    if (/^<!doctype/i.test(s.slice(i, i + 9))) {
      // The internal subset `[ … ]` may itself contain '>'.
      let j = i + 9;
      let depth = 0;
      while (j < s.length) {
        const c = s[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      if (j >= s.length) return false;
      i = j + 1;
      continue;
    }
    return SVG_ELEMENT.test(s.slice(i, i + 48));
  }
  return false;
}
