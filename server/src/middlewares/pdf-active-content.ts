import { setImmediate as yieldToEventLoop } from 'timers/promises';
import { open } from 'fs/promises';
import zlib from 'zlib';
import type { UploadFile } from './upload-file';

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
 * ## Why this streams
 *
 * The scan is a single forward pass, so it never needed random access — but an earlier version
 * took the whole file as a `Buffer`, which put a hard ceiling on the size it would look at. Past
 * that ceiling the outcome was `inconclusive`, and an inconclusive scan *stores* the file. A site
 * that raised its upload limit for large brochures therefore got exactly the wrong trade: the
 * bigger the PDF, the less it was checked.
 *
 * The traversal is now a state machine over fixed-size chunks. Decision 1 above is what makes that
 * cheap: the bulk of any large PDF is non-object stream bodies — images, fonts, page content — and
 * those are deliberately not scanned, so they are discarded as they pass rather than accumulated.
 * Peak memory is bounded by the caps below no matter how large the file is, and there is no size at
 * which the scan declines to run.
 *
 * ## Why the budgets are about decompression, not stream count
 *
 * Skipping a stream body is a `Buffer.indexOf` over bytes already in hand, so the number of streams
 * is not the expensive axis — inflating them is. Budgets therefore cap decompression work. Capping
 * stream *count* would quietly reintroduce the original flaw, because a large PDF has thousands of
 * streams and would trip the cap on size alone.
 *
 * Two shape choices keep the pass linear rather than quadratic:
 *
 * - Searches advance a `cursor` instead of re-scanning `pending` from the start. A PDF can hold
 *   ~30k tiny streams per megabyte; re-searching each time would be O(bytes²) and is a hang, not a
 *   slowdown. The original whole-file version had the same trap and solved it the same way.
 * - Consumed bytes are dropped by compaction on a threshold, so the buffer does not grow with the
 *   file and compaction cost is amortised.
 */

/** Bounds on decompression work — a small PDF can inflate to gigabytes (zip bomb). */
const MAX_OBJECT_STREAMS_INFLATED = 250;
const MAX_INFLATED_BYTES_PER_STREAM = 4 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 32 * 1024 * 1024;

/**
 * Compressed size of a single object stream we are willing to hold.
 *
 * Needed because the inflate path tries zlib first and falls back to raw deflate, and a retry
 * requires the input again. Object streams hold object definitions rather than page content, so
 * they are small in practice; one over this size is reported as undecompressable, which surfaces
 * as `inconclusive` rather than a silent pass.
 */
const MAX_OBJSTM_INPUT_BYTES = 4 * 1024 * 1024;

/** Read granularity. Only ever one of these is live at a time. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Cap on a single object-definition region held for matching. Regions are normally a few KB; a
 * PDF with no stream boundaries at all could otherwise grow this without limit.
 */
const MAX_PENDING_OBJECT_BYTES = 8 * 1024 * 1024;

/** Drop consumed bytes once this much has accumulated behind the region start. */
const COMPACT_THRESHOLD_BYTES = 256 * 1024;

/** How far back from a `stream` keyword to look for the object's dictionary. */
const DICT_LOOKBACK = 4096;

/** Bytes kept behind the region start so the `endstream` prefix test always has context. */
const LOOKBACK_MARGIN = 3;

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
  /** Encrypted or partly undecompressable — a clean result would not be meaningful. */
  | { outcome: 'inconclusive'; diagnostic: string };

function blocked(rule: ActiveContentRule, where: string): PdfActiveContentScan {
  return {
    outcome: 'blocked',
    errorMessage: `PDF rejected: it contains ${rule.reason}. This can run code when the document is opened.`,
    diagnostic: `matched ${rule.pattern} in ${where}`,
  };
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

/**
 * Sequential chunks of the upload.
 *
 * The read buffer is reused between iterations, so a consumer that keeps bytes must copy them.
 * The scanner concatenates into `pending`, which copies.
 */
async function* readChunks(file: UploadFile): AsyncGenerator<Buffer> {
  if (file.buffer) {
    for (let offset = 0; offset < file.buffer.length; offset += CHUNK_BYTES) {
      yield file.buffer.subarray(offset, Math.min(offset + CHUNK_BYTES, file.buffer.length));
    }
    return;
  }

  const handle = await open(file.filepath, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, CHUNK_BYTES, null);
      if (bytesRead <= 0) return;
      yield buf.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/** Inflate a Flate stream, refusing to allocate more than the per-stream cap. */
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
 * Find the next real `stream` keyword at or after `from`.
 *
 * Occurrences that are the tail of `endstream` are skipped: matching them would anchor the body at
 * the wrong place and swallow the object definitions that follow — which is how a CR-only
 * `stream\r` line ending previously hid a JavaScript action from the scan.
 */
function indexOfStreamKeyword(buf: Buffer, from: number): number {
  let pos = from;
  for (;;) {
    const at = buf.indexOf(STREAM_KEYWORD, pos, 'latin1');
    if (at === -1) return -1;
    if (at >= LOOKBACK_MARGIN && buf.toString('latin1', at - LOOKBACK_MARGIN, at) === 'end') {
      pos = at + STREAM_KEYWORD.length;
      continue;
    }
    return at;
  }
}

type ScanState = {
  mode: 'objects' | 'stream';
  /** Buffered bytes not yet released. */
  pending: Buffer;
  /** Start of the current object-definition region, or of the unconsumed stream body. */
  regionStart: number;
  /** Search position; never behind `regionStart`. */
  cursor: number;
  /** Set by `scanObjectRegion`: the dictionary just read declares `/ObjStm`. */
  lastRegionWasObjStm: boolean;
  /** The stream being skipped is an /ObjStm, so its body must be inflated and scanned. */
  inObjStm: boolean;
  objStmInput: Buffer[];
  objStmInputBytes: number;
  objStmOverflowed: boolean;
  objStmInflated: number;
  encrypted: boolean;
  undecompressed: number;
  totalInflated: number;
};

/**
 * Scan a PDF for executable active content.
 *
 * Reads the file in chunks; peak memory is bounded by the caps above regardless of file size, so
 * there is no size at which this declines to look.
 */
export async function scanPdfActiveContent(file: UploadFile): Promise<PdfActiveContentScan> {
  const state: ScanState = {
    mode: 'objects',
    pending: Buffer.alloc(0),
    regionStart: 0,
    cursor: 0,
    lastRegionWasObjStm: false,
    inObjStm: false,
    objStmInput: [],
    objStmInputBytes: 0,
    objStmOverflowed: false,
    objStmInflated: 0,
    encrypted: false,
    undecompressed: 0,
    totalInflated: 0,
  };

  try {
    for await (const chunk of readChunks(file)) {
      state.pending =
        state.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([state.pending, chunk]);

      const hit = await advance(state, false);
      if (hit) return hit;

      compact(state);
      // Keep the request loop responsive on large files.
      await yieldToEventLoop();
    }

    const hit = await advance(state, true);
    if (hit) return hit;

    // `/Encrypt` means strings and streams are ciphertext, so a clean result proves nothing.
    if (state.encrypted) {
      return {
        outcome: 'inconclusive',
        diagnostic: 'PDF is encrypted — active-content scanning could not inspect its objects',
      };
    }
    if (state.undecompressed > 0) {
      return {
        outcome: 'inconclusive',
        diagnostic: `${state.undecompressed} object stream(s) could not be decompressed or exceeded the scan budget`,
      };
    }

    return { outcome: 'clean' };
  } catch {
    return { outcome: 'inconclusive', diagnostic: 'active-content scan failed to parse the file' };
  }
}

/** Release bytes behind the region start once enough have built up. */
function compact(state: ScanState) {
  const dropTo = state.regionStart - LOOKBACK_MARGIN;
  if (dropTo < COMPACT_THRESHOLD_BYTES) return;
  state.pending = Buffer.from(state.pending.subarray(dropTo));
  state.regionStart -= dropTo;
  state.cursor -= dropTo;
}

/**
 * Consume as much of `pending` as possible, alternating between object-definition regions
 * (scanned) and stream bodies (skipped, except object streams).
 *
 * `atEof` releases the retained tails that exist only so a keyword split across a chunk boundary
 * can still be found.
 */
async function advance(state: ScanState, atEof: boolean): Promise<PdfActiveContentScan | null> {
  for (;;) {
    if (state.mode === 'objects') {
      const keywordAt = indexOfStreamKeyword(state.pending, state.cursor);

      if (keywordAt === -1) {
        // Resume just far enough back that a keyword split across chunks is still found.
        state.cursor = Math.max(state.regionStart, state.pending.length - (STREAM_KEYWORD.length - 1));

        const regionLength = state.pending.length - state.regionStart;
        if (atEof || regionLength > MAX_PENDING_OBJECT_BYTES) {
          const hit = scanObjectRegion(state, state.pending.length);
          if (hit) return hit;

          if (atEof) {
            state.regionStart = state.pending.length;
            state.cursor = state.pending.length;
          } else {
            // Keep a lookback window: the rules span tens of bytes, so a DICT_LOOKBACK overlap
            // cannot hide a match, and the window doubles as dictionary context for `/ObjStm`.
            state.regionStart = Math.max(0, state.pending.length - DICT_LOOKBACK);
            state.cursor = Math.max(state.regionStart, state.cursor);
          }
        }
        return null;
      }

      // The line ending after `stream` decides where the body starts, so wait for both bytes.
      if (!atEof && state.pending.length < keywordAt + STREAM_KEYWORD.length + 2) {
        state.cursor = keywordAt;
        return null;
      }

      const hit = scanObjectRegion(state, keywordAt);
      if (hit) return hit;

      let bodyStart = keywordAt + STREAM_KEYWORD.length;
      if (state.pending[bodyStart] === CR) bodyStart++;
      if (state.pending[bodyStart] === LF) bodyStart++;

      state.inObjStm = state.lastRegionWasObjStm;
      state.objStmInput = [];
      state.objStmInputBytes = 0;
      state.objStmOverflowed = false;
      state.mode = 'stream';
      state.regionStart = bodyStart;
      state.cursor = bodyStart;
      continue;
    }

    // --- stream mode: skip the body, capturing it only when it is an object stream ---
    const endAt = state.pending.indexOf(END_STREAM_KEYWORD, state.cursor, 'latin1');

    if (endAt === -1) {
      // Everything but a possible split keyword can be released.
      const consumableEnd = atEof
        ? state.pending.length
        : Math.max(state.regionStart, state.pending.length - (END_STREAM_KEYWORD.length - 1));

      if (consumableEnd > state.regionStart) {
        if (state.inObjStm) {
          collectObjStm(state, state.pending.subarray(state.regionStart, consumableEnd));
        }
        state.regionStart = consumableEnd;
      }
      state.cursor = state.regionStart;

      if (atEof) {
        // Unterminated stream. Inflate what was captured rather than discarding it.
        const hit = await flushObjStm(state);
        if (hit) return hit;
        state.mode = 'objects';
      }
      return null;
    }

    if (state.inObjStm) {
      collectObjStm(state, state.pending.subarray(state.regionStart, endAt));
    }
    const hit = await flushObjStm(state);
    if (hit) return hit;

    state.mode = 'objects';
    state.regionStart = endAt + END_STREAM_KEYWORD.length;
    state.cursor = state.regionStart;
  }
}

/**
 * Match the object-definition region `[regionStart, end)`, note `/Encrypt`, and record whether its
 * dictionary declares `/ObjStm` so the stream that follows is inflated.
 */
function scanObjectRegion(state: ScanState, end: number): PdfActiveContentScan | null {
  if (end <= state.regionStart) {
    state.lastRegionWasObjStm = false;
    return null;
  }

  const text = state.pending.toString('latin1', state.regionStart, end);
  const rule = matchRule(text);
  if (rule) return blocked(rule, 'an object definition');
  if (!state.encrypted && /\/Encrypt\b/.test(text)) state.encrypted = true;

  state.lastRegionWasObjStm = /\/ObjStm\b/.test(
    text.length > DICT_LOOKBACK ? text.slice(-DICT_LOOKBACK) : text
  );
  return null;
}

/** Accumulate compressed object-stream bytes, up to the input cap. */
function collectObjStm(state: ScanState, bytes: Buffer) {
  if (state.objStmOverflowed || bytes.length === 0) return;
  if (state.objStmInputBytes + bytes.length > MAX_OBJSTM_INPUT_BYTES) {
    state.objStmOverflowed = true;
    state.objStmInput = [];
    state.objStmInputBytes = 0;
    return;
  }
  state.objStmInput.push(Buffer.from(bytes));
  state.objStmInputBytes += bytes.length;
}

/** Inflate and scan the object stream just finished, then reset its buffers. */
async function flushObjStm(state: ScanState): Promise<PdfActiveContentScan | null> {
  if (!state.inObjStm) return null;

  const overflowed = state.objStmOverflowed;
  const input = state.objStmInputBytes > 0 ? Buffer.concat(state.objStmInput) : Buffer.alloc(0);

  state.inObjStm = false;
  state.objStmInput = [];
  state.objStmInputBytes = 0;
  state.objStmOverflowed = false;

  const budgetSpent =
    state.objStmInflated >= MAX_OBJECT_STREAMS_INFLATED ||
    state.totalInflated >= MAX_TOTAL_INFLATED_BYTES;

  if (overflowed || budgetSpent) {
    state.undecompressed++;
    return null;
  }
  if (input.length === 0) return null;

  state.objStmInflated++;
  const inflated = await tryInflate(input);
  if (!inflated) {
    state.undecompressed++;
    return null;
  }

  state.totalInflated += inflated.length;
  const rule = matchRule(inflated.toString('latin1'));
  return rule ? blocked(rule, 'a compressed object stream') : null;
}
