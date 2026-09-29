import { afterAll, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { scanPdfActiveContent } from '../src/middlewares/pdf-active-content';
import { inspectPdfUpload } from '../src/middlewares/pdf-validation';
import { createFileFactory } from './fixtures';

/**
 * The scanner reads the file in 1MB chunks rather than buffering it, which introduces failure modes
 * a whole-file walk could not have: a pattern straddling a chunk boundary, a keyword split across
 * two reads, and an object stream spanning several chunks. Those are the cases here.
 */

/** Must match CHUNK_BYTES in pdf-active-content.ts for the boundary cases to mean anything. */
const CHUNK = 1024 * 1024;

const files = createFileFactory();
afterAll(() => files.cleanup());

const HEADER = '%PDF-1.7\n';
const TRAILER = 'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
const CLEAN_OBJ = '2 0 obj\n<< /Type /Page /MediaBox [0 0 612 792] >>\nendobj\n';
const JS_ACTION = '3 0 obj\n<< /Type /Action /S /JavaScript /JS (app.alert(1)) >>\nendobj\n';
const LAUNCH_ACTION = '3 0 obj\n<< /Type /Action /S /Launch /F (calc.exe) >>\nendobj\n';
/** `#61` is `a`, so a viewer reads this as /JavaScript. */
const HEX_ESCAPED_JS = '3 0 obj\n<< /Type /Action /S /J#61vaScript /JS (x) >>\nendobj\n';
/** Page content that merely mentions the keyword — a security whitepaper, say. */
const PROSE_ABOUT_JS = '4 0 obj\n<< /Length 44 >>\nstream\nBT (This guide covers /JavaScript) Tj ET\nendstream\nendobj\n';

/** A skippable, non-object stream of `bytes` length — where the bulk of a real PDF lives. */
function fillerStream(bytes: number): string {
  return `5 0 obj\n<< /Length ${bytes} >>\nstream\n${'A'.repeat(bytes)}\nendstream\nendobj\n`;
}

/** A Flate-compressed /ObjStm whose inflated payload carries the action. */
function objectStreamWithJs(): Buffer {
  const inner = '6 0 obj\n<< /Type /Action /S /JavaScript /JS (app.alert(1)) >>\nendobj\n';
  const deflated = deflateSync(Buffer.from(inner, 'latin1'));
  return Buffer.concat([
    Buffer.from(`7 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /Length ${deflated.length} >>\nstream\n`, 'latin1'),
    deflated,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
}

function pdf(...parts: Array<string | Buffer>) {
  const buf = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
  return files.make('doc.pdf', 'application/pdf', buf);
}

describe('PDF structural validation', () => {
  it('accepts a well-formed PDF', async () => {
    expect((await inspectPdfUpload(pdf(HEADER, CLEAN_OBJ, TRAILER))).outcome).toBe('valid');
  });

  it('accepts a PDF sent as octet-stream', async () => {
    const file = files.make('doc.pdf', 'application/octet-stream', Buffer.from(HEADER + CLEAN_OBJ + TRAILER));
    expect((await inspectPdfUpload(file)).outcome).toBe('valid');
  });

  it('rejects a truncated PDF with no trailer', async () => {
    const r = await inspectPdfUpload(pdf(HEADER, CLEAN_OBJ));
    expect(r.outcome).toBe('invalid');
  });

  it('rejects a file claiming .pdf that is not one', async () => {
    const r = await inspectPdfUpload(files.make('doc.pdf', 'application/pdf', Buffer.from('not a pdf at all')));
    expect(r.outcome).toBe('invalid');
  });

  it('applies no size limit of its own', async () => {
    const big = await inspectPdfUpload(pdf(HEADER, CLEAN_OBJ, fillerStream(3 * CHUNK), TRAILER));
    expect(big.outcome).toBe('valid');
  });
});

describe('PDF active content', () => {
  it.each([
    ['a JavaScript action', JS_ACTION],
    ['a /Launch action', LAUNCH_ACTION],
    ['a hex-escaped JavaScript action', HEX_ESCAPED_JS],
  ])('blocks %s', async (_label, obj) => {
    const r = await scanPdfActiveContent(pdf(HEADER, obj, TRAILER));
    expect(r.outcome).toBe('blocked');
  });

  it('blocks a JavaScript action hidden in a compressed object stream', async () => {
    const r = await scanPdfActiveContent(pdf(HEADER, CLEAN_OBJ, objectStreamWithJs(), TRAILER));
    expect(r.outcome).toBe('blocked');
    if (r.outcome === 'blocked') expect(r.diagnostic).toMatch(/compressed object stream/);
  });

  it('leaves a clean PDF alone', async () => {
    expect((await scanPdfActiveContent(pdf(HEADER, CLEAN_OBJ, TRAILER))).outcome).toBe('clean');
  });

  it('does not flag page content that merely discusses /JavaScript', async () => {
    const r = await scanPdfActiveContent(pdf(HEADER, CLEAN_OBJ, PROSE_ABOUT_JS, TRAILER));
    expect(r.outcome).toBe('clean');
  });

  it('reports encrypted PDFs as inconclusive rather than clean', async () => {
    const r = await scanPdfActiveContent(
      pdf(HEADER, CLEAN_OBJ, '8 0 obj\n<< /Encrypt 9 0 R >>\nendobj\n', TRAILER)
    );
    expect(r.outcome).toBe('inconclusive');
  });

  /**
   * The payload is positioned so it straddles the 1MB read boundary. A carry-over bug would let it
   * through silently, which is the worst possible failure for this check.
   */
  it.each([0, 1, 5, 12, 30])('blocks a JavaScript action %i bytes before a chunk boundary', async (offset) => {
    const fixed = HEADER.length + CLEAN_OBJ.length;
    const overhead = '5 0 obj\n<< /Length  >>\nstream\n\nendstream\nendobj\n'.length + 7;
    const fillerBody = CHUNK - offset - fixed - overhead;
    expect(fillerBody).toBeGreaterThan(0);
    const r = await scanPdfActiveContent(pdf(HEADER, CLEAN_OBJ, fillerStream(fillerBody), JS_ACTION, TRAILER));
    expect(r.outcome).toBe('blocked');
  });

  it('blocks a JavaScript action after a stream body spanning several chunks', async () => {
    const r = await scanPdfActiveContent(
      pdf(HEADER, CLEAN_OBJ, fillerStream(3 * CHUNK + 137), JS_ACTION, TRAILER)
    );
    expect(r.outcome).toBe('blocked');
  });

  /**
   * The previous implementation buffered the whole file and gave up above 64MB — and giving up meant
   * *storing* the file. Size must never again be a reason the check stops applying.
   */
  it('scans a PDF larger than the old 64MB ceiling', async () => {
    const r = await scanPdfActiveContent(pdf(HEADER, CLEAN_OBJ, fillerStream(70 * CHUNK), JS_ACTION, TRAILER));
    expect(r.outcome).toBe('blocked');
  });

  it('keeps a large clean PDF clean', async () => {
    const r = await scanPdfActiveContent(pdf(HEADER, CLEAN_OBJ, fillerStream(70 * CHUNK), TRAILER));
    expect(r.outcome).toBe('clean');
  });

  /**
   * ~30k tiny streams fit in a megabyte. Re-scanning the buffer from the start on each one is
   * O(bytes squared) — a hang rather than a slowdown — which is why the pass advances a cursor.
   */
  it('stays linear across tens of thousands of streams', async () => {
    const parts: string[] = [HEADER, CLEAN_OBJ];
    for (let i = 0; i < 40_000; i++) parts.push(fillerStream(4));
    parts.push(JS_ACTION, TRAILER);

    const started = Date.now();
    const r = await scanPdfActiveContent(pdf(...parts));
    const elapsed = Date.now() - started;

    expect(r.outcome).toBe('blocked');
    expect(elapsed).toBeLessThan(10_000);
  });
});
