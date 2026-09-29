import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UploadFile } from '../src/middlewares/upload-file';

/**
 * Sample payloads, built byte-for-byte rather than committed as binaries so the reason each one
 * exists stays readable. Signatures are only as long as the detectors need.
 */

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  Buffer.alloc(64),
]);

export const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF'),
  Buffer.alloc(64),
]);

export const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '),
  Buffer.alloc(64),
]);

/** MZ header padded past the sniff window, as a real PE would be. */
export const WINDOWS_EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(126, 0x90), Buffer.from('PE')]);
export const LINUX_ELF = Buffer.concat([Buffer.from([0x7f]), Buffer.from('ELF'), Buffer.alloc(64)]);
/** The container behind .doc/.xls/.ppt and .msi, which is why those extensions are not offered. */
export const OLE_CONTAINER = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(512),
]);
export const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);

/** Split so this file cannot itself be flagged by a scanner reading the repo. */
const PHP_OPEN = '<' + '?php';
export const PHP_WEBSHELL = Buffer.from(`${PHP_OPEN} system($_GET[1]); ?` + '>\n');
/** A valid PNG with a webshell appended — the classic polyglot. */
export const PNG_PHP_POLYGLOT = Buffer.concat([PNG, Buffer.from('\n' + PHP_OPEN + ' system($_GET[1]); ?' + '>\n')]);

const SCRIPT_OPEN = '<' + 'script' + '>';
const SCRIPT_CLOSE = '<' + '/script' + '>';
export const HTML_DOC = Buffer.from(`<!DOCTYPE html><html><body>${SCRIPT_OPEN}alert(1)${SCRIPT_CLOSE}</body></html>`);

export const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n';
const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">';
const SVG_CLOSE = '</svg>';

export const svg = {
  clean: Buffer.from(SVG_OPEN + '<path d="M0 0h24v24H0z"/>' + SVG_CLOSE),
  /** Illustrator, Inkscape and Sketch all emit the prolog; icon sets and SVGO do not. */
  withProlog: Buffer.from(XML_PROLOG + SVG_OPEN + '<path d="M0 0h24v24H0z"/>' + SVG_CLOSE),
  withPrologNoEncoding: Buffer.from('<?xml version="1.0"?>' + SVG_OPEN + SVG_CLOSE),
  withBomAndProlog: Buffer.from('\ufeff' + XML_PROLOG + SVG_OPEN + SVG_CLOSE),
  withDoctype: Buffer.from(
    XML_PROLOG + '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "">' + SVG_OPEN + SVG_CLOSE
  ),
  withGeneratorComment: Buffer.from('<!-- Generator: Adobe Illustrator 27.0 -->\n' + SVG_OPEN + SVG_CLOSE),
  script: Buffer.from(SVG_OPEN + SCRIPT_OPEN + 'alert(1)' + SCRIPT_CLOSE + SVG_CLOSE),
  scriptWithProlog: Buffer.from(XML_PROLOG + SVG_OPEN + SCRIPT_OPEN + 'alert(1)' + SCRIPT_CLOSE + SVG_CLOSE),
  eventHandler: Buffer.from(XML_PROLOG + SVG_OPEN + '<rect onload="alert(1)"/>' + SVG_CLOSE),
  entityXxe: Buffer.from(
    '<?xml version="1.0"?><!DOCTYPE s [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + SVG_OPEN + SVG_CLOSE
  ),
  javascriptUrl: Buffer.from(XML_PROLOG + SVG_OPEN + '<a href="javascript:alert(1)"><rect/></a>' + SVG_CLOSE),
  foreignObject: Buffer.from(XML_PROLOG + SVG_OPEN + '<foreignObject><b>x</b></foreignObject>' + SVG_CLOSE),
  externalUse: Buffer.from(XML_PROLOG + SVG_OPEN + '<use href="http://evil.test/x.svg#a"/>' + SVG_CLOSE),
  smilSet: Buffer.from(
    XML_PROLOG + SVG_OPEN + '<set attributeName="href" to="javascript:alert(1)"/>' + SVG_CLOSE
  ),
  xmlStylesheet: Buffer.from('<?xml version="1.0"?><?xml-stylesheet href="x.xsl"?>' + SVG_OPEN + SVG_CLOSE),
  /** Valid XML, but not an SVG — must not ride in on the .svg extension. */
  notAnSvg: Buffer.from('<?xml version="1.0"?><rows><r>1</r></rows>'),
};

export const CSV = Buffer.from('name,qty\nwidget,3\n');
export const PDF_CLEAN = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n%%EOF\n');
export const PDF_JAVASCRIPT = Buffer.from(
  '%PDF-1.7\n2 0 obj\n<< /Type /Action /S /JavaScript /JS (app.alert(1)) >>\nendobj\ntrailer\n%%EOF\n'
);

/** Filenames from the penetration test, kept as constants so the escapes stay visible. */
export const filenames = {
  /** Three literal characters. Multipart names are never URL-decoded, so no null byte reaches us. */
  nullByteBypass: 'virus.svg' + '%' + '00.png',
  doubleExtension: 'virus.svg.png',
  /** Renders to a reader as "invoice.exe...jpg". */
  bidiOverride: 'invoice' + String.fromCharCode(0x202e) + 'gpj.exe',
  traversal: '../../evil.png',
  hiddenFile: '.htaccess',
  noExtension: 'payload',
  devanagari: String.fromCharCode(0x92c, 0x94d, 0x930, 0x94b, 0x936, 0x930) + '.pdf',
};

/** Writes payloads to a throwaway directory and hands back the shape the middleware expects. */
export function createFileFactory() {
  const dir = mkdtempSync(join(tmpdir(), 'webp-plugin-test-'));
  let seq = 0;
  return {
    make(originalFilename: string, mimetype: string, bytes: Buffer): UploadFile {
      const filepath = join(dir, `f${seq++}.bin`);
      writeFileSync(filepath, bytes);
      return { originalFilename, filepath, mimetype, size: bytes.length };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
