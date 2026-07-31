import zlib from 'zlib';

/**
 * Detection of executable active content inside a structurally valid PDF.
 *
 * This is content analysis, not signature checking: a file can pass every magic-byte test and
 * still carry `/OpenAction → /S /JavaScript`, which runs when the document is opened.
 *
 * Three decisions shape the implementation:
 *
 * 1. **Only object definitions are scanned, never stream bodies.** An action dictionary can only
 *    appear in an object definition; page-drawing commands cannot contain one. Scanning rendered
 *    text as well would reject any document that merely *discusses* `/JavaScript`.
 * 2. **Rules match the construct, not the keyword.** `/S /JavaScript` is unambiguous; a bare
 *    `/OpenAction` is not, and is deliberately allowed (it usually just sets the initial zoom).
 * 3. **Names are decoded before matching.** PDF permits `#xx` hex escapes inside names, so
 *    `/S /J#61vaScript` is the same action to a viewer and must be the same to the scanner.
 *
 * Everything walks the file linearly with `indexOf`. An earlier lazy-regex version was
 * quadratic: a 2.4 MB file of repeated `obj` tokens with no stream keyword blocked the event
 * loop for ~16 seconds, and the budgets below never engaged because they only counted
 * decompressed streams.
 */

/** Bounds on decompression work — a small PDF can inflate to gigabytes (zip bomb). */
const MAX_STREAMS_INSPECTED = 250;
const MAX_INFLATED_BYTES_PER_STREAM = 4 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 32 * 1024 * 1024;

/**
 * Above this the file is not scanned at all. `maxPdfSizeMb` permits up to 500 MB, and scanning
 * holds latin1 copies of what it inspects; a bounded refusal beats a multi-gigabyte allocation.
 */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** How far back from a `stream` keyword to look for the object's dictionary. */
const DICT_LOOKBACK = 4096;

const STREAM_KEYWORD = 'stream';
const END_STREAM_KEYWORD = 'endstream';

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

/**
 * Locate every stream body by position, in one linear pass.
 *
 * Occurrences of `stream` that are the tail of `endstream` are skipped: matching them would
 * anchor the body at the wrong place and swallow the object definitions that follow — which is
 * how a CR-only `stream\r` line ending previously hid a JavaScript action from the scan.
 * All three line endings after the keyword (`\r\n`, `\n`, `\r`) are accepted.
 */
function findStreamRegions(text: string): { regions: StreamRegion[]; truncated: boolean } {
  const regions: StreamRegion[] = [];
  let pos = 0;

  while (regions.length < MAX_STREAMS_INSPECTED) {
    const keyword = text.indexOf(STREAM_KEYWORD, pos);
    if (keyword === -1) return { regions, truncated: false };

    if (keyword >= 3 && text.startsWith('end', keyword - 3)) {
      pos = keyword + STREAM_KEYWORD.length;
      continue;
    }

    let bodyStart = keyword + STREAM_KEYWORD.length;
    if (text[bodyStart] === '\r') bodyStart++;
    if (text[bodyStart] === '\n') bodyStart++;

    const bodyEnd = text.indexOf(END_STREAM_KEYWORD, bodyStart);
    if (bodyEnd === -1) {
      // Unterminated stream: treat the remainder as body rather than scanning binary as text.
      regions.push({ bodyStart, bodyEnd: text.length });
      return { regions, truncated: false };
    }

    regions.push({ bodyStart, bodyEnd });
    pos = bodyEnd + END_STREAM_KEYWORD.length;
  }

  return { regions, truncated: text.indexOf(STREAM_KEYWORD, pos) !== -1 };
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

/** Inflate a Flate stream, refusing to allocate more than the per-stream cap. */
function tryInflate(bytes: Buffer): Buffer | null {
  const options = { maxOutputLength: MAX_INFLATED_BYTES_PER_STREAM };
  try {
    return zlib.inflateSync(bytes, options);
  } catch {
    // Some producers omit the zlib header.
    try {
      return zlib.inflateRawSync(bytes, options);
    } catch {
      return null;
    }
  }
}

/**
 * Scan an already-validated PDF for executable active content.
 * `buffer` must be the whole file; callers gate this behind the size limit.
 */
export function scanPdfActiveContent(buffer: Buffer): PdfActiveContentScan {
  if (buffer.length > MAX_SCAN_BYTES) {
    return {
      outcome: 'inconclusive',
      diagnostic: `file is ${Math.round(buffer.length / (1024 * 1024))}MB, above the ${MAX_SCAN_BYTES / (1024 * 1024)}MB active-content scan limit`,
    };
  }

  try {
    // latin1 maps bytes 1:1, so string offsets stay aligned with the buffer.
    const text = buffer.toString('latin1');
    const { regions, truncated } = findStreamRegions(text);

    let encrypted = false;
    let undecompressed = 0;
    let totalInflated = 0;

    // Walk the gaps between stream bodies — the object definitions — one at a time, so peak
    // memory tracks the largest segment rather than the whole file.
    let cursor = 0;
    for (let i = 0; i <= regions.length; i++) {
      const segmentEnd = i < regions.length ? regions[i].bodyStart : text.length;
      if (segmentEnd > cursor) {
        const segment = text.slice(cursor, segmentEnd);
        const hit = matchRule(segment);
        if (hit) {
          return {
            outcome: 'blocked',
            errorMessage: `PDF rejected: it contains ${hit.reason}. This can run code when the document is opened.`,
            diagnostic: `matched ${hit.pattern} in an object definition`,
          };
        }
        if (!encrypted && /\/Encrypt\b/.test(segment)) encrypted = true;

        // Only object streams hold object definitions; other streams are skipped by design.
        if (i < regions.length && /\/ObjStm\b/.test(segment.slice(-DICT_LOOKBACK))) {
          if (totalInflated >= MAX_TOTAL_INFLATED_BYTES) {
            undecompressed++;
          } else {
            const inflated = tryInflate(buffer.subarray(regions[i].bodyStart, regions[i].bodyEnd));
            if (!inflated) {
              undecompressed++;
            } else {
              totalInflated += inflated.length;
              const objStmHit = matchRule(inflated.toString('latin1'));
              if (objStmHit) {
                return {
                  outcome: 'blocked',
                  errorMessage: `PDF rejected: it contains ${objStmHit.reason}. This can run code when the document is opened.`,
                  diagnostic: `matched ${objStmHit.pattern} inside a compressed object stream`,
                };
              }
            }
          }
        }
      }
      if (i < regions.length) cursor = regions[i].bodyEnd;
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
