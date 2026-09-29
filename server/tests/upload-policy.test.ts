import { afterAll, describe, expect, it } from 'vitest';
import { checkUploadFilename } from '../src/middlewares/filename-safety';
import { applyFileTypePolicy, DEFAULT_ALLOWED_EXTENSIONS, normaliseAllowedExtensions } from '../src/middlewares/file-type-policy';
import { isSvgFile, validateSvgFile } from '../src/middlewares/svg-validation';
import { toClientSafeMessage } from '../src/middlewares/upload-rejection';
import * as fx from './fixtures';

const files = fx.createFileFactory();
afterAll(() => files.cleanup());

const SVG_LIMIT = 5 * 1024 * 1024;

type Verdict = { verdict: 'ALLOWED' | 'REJECTED'; stage: string; reason: string };

/**
 * Mirrors the real order in `enforceUploadPolicy` then `transformSingleUpload`: filename, then type
 * policy, then the SVG scanner. Tests assert the stage as well as the outcome, because a payload
 * being stopped by the wrong gate is how the SVG prolog regression hid for a release.
 */
async function runGate(name: string, mimetype: string, bytes: Buffer): Promise<Verdict> {
  const nameCheck = checkUploadFilename(name);
  if (nameCheck.outcome === 'invalid') {
    return { verdict: 'REJECTED', stage: 'filename', reason: nameCheck.errorMessage };
  }
  const file = files.make(nameCheck.safeName, mimetype, bytes);

  const typeCheck = await applyFileTypePolicy(file, file.originalFilename, DEFAULT_ALLOWED_EXTENSIONS, {
    blockMultipleExtensions: true,
  });
  if (typeCheck.outcome === 'rejected') {
    return { verdict: 'REJECTED', stage: 'type-policy', reason: typeCheck.errorMessage };
  }

  if (isSvgFile(file)) {
    const svgCheck = await validateSvgFile(file, SVG_LIMIT);
    if (svgCheck.outcome === 'invalid') {
      return { verdict: 'REJECTED', stage: 'svg-scan', reason: svgCheck.errorMessage };
    }
  }
  return { verdict: 'ALLOWED', stage: '-', reason: '' };
}

describe('penetration test payloads (finding 5.2)', () => {
  it('rejects the null-byte filename bypass', async () => {
    const r = await runGate(fx.filenames.nullByteBypass, 'image/png', fx.svg.script);
    expect(r.verdict).toBe('REJECTED');
    expect(r.stage).toBe('filename');
  });

  it('rejects a double extension', async () => {
    const r = await runGate(fx.filenames.doubleExtension, 'image/png', fx.svg.script);
    expect(r.verdict).toBe('REJECTED');
    expect(r.reason).toMatch(/more than one file extension/i);
  });

  it('rejects an executable by extension', async () => {
    const r = await runGate('virus.exe', 'application/octet-stream', fx.WINDOWS_EXE);
    expect(r.verdict).toBe('REJECTED');
    expect(r.stage).toBe('type-policy');
  });

  it('rejects an executable renamed as an image', async () => {
    const r = await runGate('virus.png', 'image/png', fx.WINDOWS_EXE);
    expect(r.verdict).toBe('REJECTED');
    expect(r.reason).toMatch(/Windows executable/i);
  });

  it('rejects a scriptable SVG, at the SVG scanner', async () => {
    const r = await runGate('virus.svg', 'image/svg+xml', fx.svg.script);
    expect(r.verdict).toBe('REJECTED');
    expect(r.stage).toBe('svg-scan');
  });
});

describe('content that contradicts its extension', () => {
  it.each([
    ['PHP webshell as .png', 'shell.png', 'image/png', () => fx.PHP_WEBSHELL, /embedded PHP/i],
    ['PNG/PHP polyglot', 'polyglot.png', 'image/png', () => fx.PNG_PHP_POLYGLOT, /embedded PHP/i],
    ['ELF binary as .jpg', 'x.jpg', 'image/jpeg', () => fx.LINUX_ELF, /Linux executable/i],
    ['HTML as .png', 'page.png', 'image/png', () => fx.HTML_DOC, /HTML document/i],
    ['OLE container as .doc', 'notes.doc', 'application/msword', () => fx.OLE_CONTAINER, /not allowed/i],
    ['PNG bytes as .jpg', 'image.jpg', 'image/jpeg', () => fx.PNG, /does not match/i],
    ['ZIP as .zip', 'bundle.zip', 'application/zip', () => fx.ZIP, /not allowed/i],
  ])('rejects %s', async (_label, name, mime, make, expected) => {
    const r = await runGate(name, mime, make());
    expect(r.verdict).toBe('REJECTED');
    expect(r.reason).toMatch(expected);
  });
});

describe('filename safety', () => {
  it.each([
    ['path traversal', fx.filenames.traversal, /path separator/i],
    ['bidi override', fx.filenames.bidiOverride, /zero-width or text-direction/i],
    ['leading dot', fx.filenames.hiddenFile, /leading dot/i],
    ['no extension', fx.filenames.noExtension, /must include a file extension/i],
  ])('rejects %s', (_label, name, expected) => {
    const check = checkUploadFilename(name);
    expect(check.outcome).toBe('invalid');
    if (check.outcome === 'invalid') expect(check.errorMessage).toMatch(expected);
  });

  it.each(['report.v1.2.pdf', 'photo.2024.01.png', '100% cotton.png', fx.filenames.devanagari])(
    'accepts %s',
    (name) => {
      expect(checkUploadFilename(name).outcome).toBe('ok');
    }
  );
});

describe('SVG uploads', () => {
  /**
   * The regression that shipped: `file-type` reports `application/xml` for a literal `<?xml` at
   * byte 0, and the svg rule had an empty detectedMimes list, so every designer-exported SVG was
   * refused as a content mismatch. Detection only fires at byte 0, which is why the BOM and comment
   * variants behaved differently and made the bug look intermittent.
   */
  it.each([
    ['no prolog', () => fx.svg.clean],
    ['XML prolog', () => fx.svg.withProlog],
    ['prolog without encoding', () => fx.svg.withPrologNoEncoding],
    ['BOM then prolog', () => fx.svg.withBomAndProlog],
    ['prolog then DOCTYPE', () => fx.svg.withDoctype],
    ['generator comment first', () => fx.svg.withGeneratorComment],
  ])('accepts a clean SVG: %s', async (_label, make) => {
    const r = await runGate('logo.svg', 'image/svg+xml', make());
    expect(r.verdict).toBe('ALLOWED');
  });

  it('accepts a prolog-bearing SVG sent as octet-stream', async () => {
    const r = await runGate('logo.svg', 'application/octet-stream', fx.svg.withProlog);
    expect(r.verdict).toBe('ALLOWED');
  });

  /** All of these must be stopped by the scanner, never by an accidental type mismatch. */
  it.each([
    ['script element', () => fx.svg.scriptWithProlog, /script element/i],
    ['inline event handler', () => fx.svg.eventHandler, /event handler/i],
    ['DTD entity (XXE)', () => fx.svg.entityXxe, /entity declaration/i],
    ['javascript: URL', () => fx.svg.javascriptUrl, /javascript: URL/i],
    ['embedded content', () => fx.svg.foreignObject, /embedded-content/i],
    ['external use reference', () => fx.svg.externalUse, /use element referencing/i],
    ['SMIL animation', () => fx.svg.smilSet, /SMIL animation/i],
    ['XML stylesheet', () => fx.svg.xmlStylesheet, /stylesheet processing/i],
  ])('rejects a prolog-bearing SVG with a %s, at the scanner', async (_label, make, expected) => {
    const r = await runGate('x.svg', 'image/svg+xml', make());
    expect(r.verdict).toBe('REJECTED');
    expect(r.stage).toBe('svg-scan');
    expect(r.reason).toMatch(expected);
  });

  it('rejects XML that is not an SVG', async () => {
    const r = await runGate('x.svg', 'image/svg+xml', fx.svg.notAnSvg);
    expect(r.verdict).toBe('REJECTED');
    expect(r.reason).toMatch(/no svg element/i);
  });

  it.each([
    ['PNG', () => fx.PNG],
    ['executable', () => fx.WINDOWS_EXE],
    ['PDF', () => fx.PDF_CLEAN],
  ])('rejects a %s renamed .svg', async (_label, make) => {
    const r = await runGate('x.svg', 'image/svg+xml', make());
    expect(r.verdict).toBe('REJECTED');
  });
});

describe('legitimate uploads still pass', () => {
  it.each([
    ['photo.png', 'image/png', () => fx.PNG],
    ['photo.jpeg', 'image/jpeg', () => fx.JPEG],
    ['photo.jpg', 'image/jpeg', () => fx.JPEG],
    ['photo.webp', 'image/webp', () => fx.WEBP],
    ['brochure.pdf', 'application/pdf', () => fx.PDF_CLEAN],
    ['logo.svg', 'image/svg+xml', () => fx.svg.clean],
    ['data.csv', 'text/csv', () => fx.CSV],
    ['report.v1.2.pdf', 'application/pdf', () => fx.PDF_CLEAN],
    ['doc.pdf', 'application/octet-stream', () => fx.PDF_CLEAN],
  ])('accepts %s', async (name, mime, make) => {
    const r = await runGate(name, mime, make());
    expect(r.verdict).toBe('ALLOWED');
  });
});

describe('rejection messages', () => {
  /**
   * The admin panel renders `error.message` through ICU, where `<…>` is a tag and `{…}` a
   * placeholder. A reason naming a `<script>` element once threw UNCLOSED_TAG and took the upload
   * card down with it.
   */
  it('never contains ICU-significant characters', async () => {
    const reasons = await Promise.all([
      runGate(fx.filenames.nullByteBypass, 'image/png', fx.svg.script),
      runGate('virus.exe', 'application/octet-stream', fx.WINDOWS_EXE),
      runGate('x.svg', 'image/svg+xml', fx.svg.scriptWithProlog),
      runGate('image.jpg', 'image/jpeg', fx.PNG),
      runGate('x.svg', 'image/svg+xml', fx.svg.notAnSvg),
    ]);
    for (const { reason } of reasons) {
      expect(reason).not.toMatch(/[<>{}]/);
      expect(toClientSafeMessage(reason)).toBe(reason);
    }
  });

  it('does not enumerate the allow-list or leak the detected type', async () => {
    const notAllowed = await runGate('report.sql', 'text/plain', fx.CSV);
    expect(notAllowed.reason).not.toMatch(/Permitted types/i);
    expect(notAllowed.reason).not.toMatch(/\.(png|jpg|pdf|docx)\b/);

    const mismatch = await runGate('image.jpg', 'image/jpeg', fx.PNG);
    expect(mismatch.reason).not.toMatch(/image\/png/);
  });

  it('strips ICU-significant characters from anything that slips through', () => {
    expect(toClientSafeMessage('a <script> element')).toBe('a script element');
    expect(toClientSafeMessage('uses {placeholder} syntax')).toBe('uses placeholder syntax');
  });
});

describe('normaliseAllowedExtensions', () => {
  /**
   * Strapi merges plugin config with lodash `defaultsDeep`, which merges arrays *by index*. The
   * plugin's own default is therefore empty — listing the real defaults there meant an operator who
   * narrowed the policy to two entries silently got everything from index 2 onwards back.
   */
  it('honours a narrowed list exactly', () => {
    expect(normaliseAllowedExtensions(['pdf', 'png'])).toEqual(['pdf', 'png']);
    expect(normaliseAllowedExtensions(['pdf'])).toEqual(['pdf']);
  });

  it('falls back to the recommended set when empty or invalid', () => {
    const recommended = [...DEFAULT_ALLOWED_EXTENSIONS].sort();
    expect(normaliseAllowedExtensions([])).toEqual(recommended);
    expect(normaliseAllowedExtensions(undefined)).toEqual([...DEFAULT_ALLOWED_EXTENSIONS]);
    expect(normaliseAllowedExtensions('pdf')).toEqual([...DEFAULT_ALLOWED_EXTENSIONS]);
  });

  it('normalises dots, case and duplicates', () => {
    expect(normaliseAllowedExtensions(['.PDF', 'pdf', 'PNG'])).toEqual(['pdf', 'png']);
  });

  it('drops anything it cannot content-verify', () => {
    expect(normaliseAllowedExtensions(['pdf', 'exe', 'php'])).toEqual(['pdf']);
  });
});
