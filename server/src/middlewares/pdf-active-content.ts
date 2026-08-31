import { setImmediate as yieldToEventLoop } from 'timers/promises';
import zlib from 'zlib';

/**
 * Detection of executable active content inside a structurally valid PDF.
 *
 * This is content analysis, not signature checking: a file can pass every magic-byte test and
 * still carry `/OpenAction → /S /JavaScript`, which runs when the document is opened.
 *
 * Three decisions shape what is matched:
 *
 * 1. **Only object definitions are scanned, never stream bodies.** An action dictionary can only
 *    appear in an object definition; page-drawing commands cannot contain one. Scanning rendered
 *    text as well would reject any document that merely *discusses* `/JavaScript`.
 * 2. **Rules match the construct, not the keyword.** `/S /JavaScript` is unambiguous; a bare
 *    `/OpenAction` is not, and is deliberately allowed (it usually just sets the initial zoom).
 * 3. **Names are decoded before matching.** PDF permits `#xx` hex escapes inside names, so
 *    `/S /J#61vaScript` is the same action to a viewer and must be the same to the scanner.
 *
 * And three shape how it runs, because this sits on the request path:
 *
 * - Stream boundaries are found with `Buffer.indexOf` in a single linear pass. An earlier
 *   lazy-regex version was quadratic — 2.4 MB of `obj` tokens blocked the event loop for ~16 s.
 * - Only the object-definition gaps are converted to text, one at a time. The whole file is never
 *   held as a string, so peak memory tracks the largest gap rather than the file.
 * - Decompression is async and the loop yields between segments, so a large PDF cannot stall
 *   other requests.
 */

/** Bounds on decompression work — a small PDF can inflate to gigabytes (zip bomb). */
const MAX_STREAMS_INSPECTED = 250;
const MAX_INFLATED_BYTES_PER_STREAM = 4 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 32 * 1024 * 1024;

/**
 * Above this the file is not scanned at all. `maxPdfSizeMb` permits up to 500 MB; a bounded
 * refusal beats spending the request budget on a file that large.
 */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** How far back from a `stream` keyword to look for the object's dictionary. */
const DICT_LOOKBACK = 4096;

const STREAM_KEYWORD = 'stream';
const END_STREAM_KEYWORD = 'endstream';
const CR = 0x0d;
const LF = 0x0a;

type ActiveContentRule = { pattern: RegExp; reason: string };

const ACTIVE_CONTENT_RULES: ActiveContentRule[] = [
  {
    // The JavaScript action subtype. `/S` also introduces /GoTo, /URI, /Transparency and
    // others, so pairing it with /JavaScript is what makes this unambiguous.
    pattern: /\/S\s*\/JavaScript\b/,
    reason: 'a JavaScript action (/S /JavaScript)',
  },
  {
    // Document-level scripts hang off a name tree: /Names << /JavaScript [ … ] >>
    pattern: /\/JavaScript\s*\[/,
    reason: 'a document-level JavaScript name tree',
  },
  {
    // The payload itself, as a literal string, hex string, or indirect reference.
    pattern: /\/JS\s*(?:[(<]|\d+\s+\d+\s+R\b)/,
    reason: 'an embedded JavaScript payload (/JS)',
  },
  {
    // Runs an external program. No legitimate use in a web-published document.
    pattern: /\/Launch\b/,
    reason: 'a /Launch action, which starts an external program',
  },
];

export type PdfActiveContentScan =
  | { outcome: 'clean' }
  | { outcome: 'blocked'; errorMessage: string; diagnostic: string }
  /** Encrypted, oversized, or partly undecompressable — a clean result would not be meaningful. */
  | { outcome: 'inconclusive'; diagnostic: string };

type StreamRegion = { bodyStart: number; bodyEnd: number };

function blocked(rule: ActiveContentRule, where: string): PdfActiveContentScan {
  return {
    outcome: 'blocked',
    errorMessage: `PDF rejected: it contains ${rule.reason}. This can run code when the document is opened.`,
    diagnostic: `matched ${rule.pattern} in ${where}`,
  };
}

/**
 * Locate every stream body by position, in one linear pass over the bytes.
 *
 * Occurrences of `stream` that are the tail of `endstream` are skipped: matching them would
 * anchor the body at the wrong place and swallow the object definitions that follow — which is
 * how a CR-only `stream\r` line ending previously hid a JavaScript action from the scan.
 * All three line endings after the keyword (`\r\n`, `\n`, `\r`) are accepted.
 */
function findStreamRegions(buf: Buffer): { regions: StreamRegion[]; truncated: boolean } {
  const regions: StreamRegion[] = [];
  let pos = 0;

  while (regions.length < MAX_STREAMS_INSPECTED) {
    const keyword = buf.indexOf(STREAM_KEYWORD, pos, 'latin1');
    if (keyword === -1) return { regions, truncated: false };

    if (keyword >= 3 && buf.toString('latin1', keyword - 3, keyword) === 'end') {
      pos = keyword + STREAM_KEYWORD.length;
      continue;
    }

    let bodyStart = keyword + STREAM_KEYWORD.length;
    if (buf[bodyStart] === CR) bodyStart++;
    if (buf[bodyStart] === LF) bodyStart++;

    const bodyEnd = buf.indexOf(END_STREAM_KEYWORD, bodyStart, 'latin1');
    if (bodyEnd === -1) {
      // Unterminated stream: treat the remainder as body rather than scanning binary as text.
      regions.push({ bodyStart, bodyEnd: buf.length });
      return { regions, truncated: false };
    }

    regions.push({ bodyStart, bodyEnd });
    pos = bodyEnd + END_STREAM_KEYWORD.length;
  }

  return { regions, truncated: buf.indexOf(STREAM_KEYWORD, pos, 'latin1') !== -1 };
}

/**
 * Resolve `#xx` escapes inside PDF name tokens only, so `/J#61vaScript` matches the JavaScript
 * rule. Scoped to names — decoding the whole file would invent matches out of ordinary text.
 */
function decodePdfNames(text: string): string {
  if (!text.includes('#')) return text;
  return text.replace(/\/[^\s/<>[\](){}%]+/g, (name) =>
    name.replace(/#([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  );
}

/** Test one chunk of object-definition text, raw and with names decoded. */
function matchRule(chunk: string): ActiveContentRule | null {
  const decoded = decodePdfNames(chunk);
  for (const rule of ACTIVE_CONTENT_RULES) {
    if (rule.pattern.test(chunk) || (decoded !== chunk && rule.pattern.test(decoded))) {
      return rule;
    }
  }
  return null;
}

/** Inflate a Flate stream off the event loop, refusing to allocate more than the per-stream cap. */
function tryInflate(bytes: Buffer): Promise<Buffer | null> {
  const options = { maxOutputLength: MAX_INFLATED_BYTES_PER_STREAM };
  return new Promise((resolve) => {
    zlib.inflate(bytes, options, (err, out) => {
      if (!err) return resolve(out);
      // Some producers omit the zlib header.
      zlib.inflateRaw(bytes, options, (rawErr, rawOut) => resolve(rawErr ? null : rawOut));
    });
  });
}

/**
 * Scan an already-validated PDF for executable active content.
 * `buffer` must be the whole file; callers gate this behind the size limit.
 */
export async function scanPdfActiveContent(buffer: Buffer): Promise<PdfActiveContentScan> {
  if (buffer.length > MAX_SCAN_BYTES) {
    return {
      outcome: 'inconclusive',
      diagnostic: `file is ${Math.round(buffer.length / (1024 * 1024))}MB, above the ${MAX_SCAN_BYTES / (1024 * 1024)}MB active-content scan limit`,
    };
  }

  try {
    const { regions, truncated } = findStreamRegions(buffer);

    let encrypted = false;
    let undecompressed = 0;
    let totalInflated = 0;

    // Walk the gaps between stream bodies — the object definitions — converting one at a time.
    let cursor = 0;
    for (let i = 0; i <= regions.length; i++) {
      const segmentEnd = i < regions.length ? regions[i].bodyStart : buffer.length;

      if (segmentEnd > cursor) {
        const segment = buffer.toString('latin1', cursor, segmentEnd);
        const hit = matchRule(segment);
        if (hit) return blocked(hit, 'an object definition');
        if (!encrypted && /\/Encrypt\b/.test(segment)) encrypted = true;

        // Only object streams hold object definitions; other streams are skipped by design.
        if (i < regions.length && /\/ObjStm\b/.test(segment.slice(-DICT_LOOKBACK))) {
          if (totalInflated >= MAX_TOTAL_INFLATED_BYTES) {
            undecompressed++;
          } else {
            const inflated = await tryInflate(buffer.subarray(regions[i].bodyStart, regions[i].bodyEnd));
            if (!inflated) {
              undecompressed++;
            } else {
              totalInflated += inflated.length;
              const objStmHit = matchRule(inflated.toString('latin1'));
              if (objStmHit) return blocked(objStmHit, 'a compressed object stream');
            }
          }
        }
      }

      if (i < regions.length) cursor = regions[i].bodyEnd;
      // Keep the request loop responsive on files with many objects.
      await yieldToEventLoop();
    }

    // `/Encrypt` means strings and streams are ciphertext, so a clean result proves nothing.
    if (encrypted) {
      return {
        outcome: 'inconclusive',
        diagnostic: 'PDF is encrypted — active-content scanning could not inspect its objects',
      };
    }
    if (undecompressed > 0 || truncated) {
      return {
        outcome: 'inconclusive',
        diagnostic: truncated
          ? `more than ${MAX_STREAMS_INSPECTED} streams — the remainder was not scanned`
          : `${undecompressed} object stream(s) could not be decompressed or exceeded the scan budget`,
      };
    }

    return { outcome: 'clean' };
  } catch {
    return { outcome: 'inconclusive', diagnostic: 'active-content scan failed to parse the file' };
  }
}
