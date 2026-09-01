import FileType from 'file-type';
import { extensionSegments } from './filename-safety';
import { TYPE_SNIFF_BYTES, readHeadBytes, type UploadFile } from './upload-file';

/**
 * Default-deny type policy for uploads.
 *
 * Three independent gates, because each one alone is bypassable:
 *
 *  1. **Extension allow-list.** Anything not explicitly permitted is refused. Without this an
 *     `.exe` is simply stored — nothing in Strapi core stops it unless the host has configured
 *     `plugin::upload.security`, which is inert by default.
 *  2. **Interior-extension check.** `virus.svg.png` presents a `.png` to the web server while
 *     leaving a second, meaningful extension in the middle of the name.
 *  3. **Extension ↔ content agreement.** The bytes must be the format the extension claims. This
 *     is the gate that catches a text payload wearing an image extension: core's own MIME
 *     validation allows `shell.php.png` sent as `image/png`, because `file-type` cannot detect
 *     PHP source and core then falls back to trusting the extension.
 *
 * On top of those, executable and script signatures are refused outright whatever the name says,
 * so a polyglot cannot ride in on an allowed extension.
 */

export type FileGroup = 'image' | 'document' | 'video' | 'audio';

type ExtensionRule = {
  group: FileGroup;
  /**
   * Mime types `file-type` may legitimately report for this format. Verified against
   * `file-type@16.5.4`'s own tables rather than guessed — `.wav` reports `audio/vnd.wave`,
   * not `audio/wav`, and getting that wrong would refuse every valid upload.
   */
  detectedMimes: string[];
  /**
   * Text formats have no binary signature, so `file-type` returns nothing for them. Detection
   * returning *anything* for one of these is therefore a mismatch: a renamed PE, PDF or JPEG is
   * caught by the empty `detectedMimes` list without needing a rule of its own.
   */
  textBased?: boolean;
};

/** Office and OpenDocument files are zip containers; detection may stop at the outer archive. */
const ZIP_CONTAINER = 'application/zip';

/**
 * The formats this plugin is prepared to vouch for. An extension may only be enabled if it has an
 * entry here, so the allow-list can never be widened to something with no content check behind it.
 */
export const EXTENSION_RULES: Record<string, ExtensionRule> = {
  // ---- Images -------------------------------------------------------------
  jpg: { group: 'image', detectedMimes: ['image/jpeg'] },
  jpeg: { group: 'image', detectedMimes: ['image/jpeg'] },
  png: { group: 'image', detectedMimes: ['image/png', 'image/apng'] },
  gif: { group: 'image', detectedMimes: ['image/gif'] },
  webp: { group: 'image', detectedMimes: ['image/webp'] },
  avif: { group: 'image', detectedMimes: ['image/avif'] },
  // Accepted because the convertor rasterises them to WebP, so they never persist as-is.
  bmp: { group: 'image', detectedMimes: ['image/bmp'] },
  tif: { group: 'image', detectedMimes: ['image/tiff'] },
  tiff: { group: 'image', detectedMimes: ['image/tiff'] },
  heic: {
    group: 'image',
    detectedMimes: ['image/heic', 'image/heic-sequence', 'image/heif', 'image/heif-sequence'],
  },
  heif: {
    group: 'image',
    detectedMimes: ['image/heic', 'image/heic-sequence', 'image/heif', 'image/heif-sequence'],
  },
  /**
   * SVG is XML, so it has no binary signature — but `file-type` *does* recognise a literal `<?xml`
   * at byte 0 and reports `application/xml`. Illustrator, Inkscape and Sketch all emit that prolog,
   * so leaving this list empty rejected every designer-exported SVG while icon-set and SVGO output
   * (which omit the prolog) passed. `textBased` stays for the prolog-less case; both paths now reach
   * `validateSvgFile`, which is where SVG safety actually belongs.
   */
  svg: { group: 'image', detectedMimes: ['application/xml'], textBased: true },

  // ---- Documents ----------------------------------------------------------
  pdf: { group: 'document', detectedMimes: ['application/pdf'] },
  docx: {
    group: 'document',
    detectedMimes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ZIP_CONTAINER,
    ],
  },
  xlsx: {
    group: 'document',
    detectedMimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP_CONTAINER],
  },
  pptx: {
    group: 'document',
    detectedMimes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ZIP_CONTAINER,
    ],
  },
  odt: { group: 'document', detectedMimes: ['application/vnd.oasis.opendocument.text', ZIP_CONTAINER] },
  ods: {
    group: 'document',
    detectedMimes: ['application/vnd.oasis.opendocument.spreadsheet', ZIP_CONTAINER],
  },
  odp: {
    group: 'document',
    detectedMimes: ['application/vnd.oasis.opendocument.presentation', ZIP_CONTAINER],
  },
  rtf: { group: 'document', detectedMimes: ['application/rtf'] },
  csv: { group: 'document', detectedMimes: [], textBased: true },
  txt: { group: 'document', detectedMimes: [], textBased: true },

  // ---- Video --------------------------------------------------------------
  mp4: { group: 'video', detectedMimes: ['video/mp4', 'video/x-m4v'] },
  m4v: { group: 'video', detectedMimes: ['video/x-m4v', 'video/mp4'] },
  // WebM and Matroska share the EBML container header.
  webm: { group: 'video', detectedMimes: ['video/webm', 'video/x-matroska'] },
  ogv: { group: 'video', detectedMimes: ['video/ogg'] },
  mov: { group: 'video', detectedMimes: ['video/quicktime'] },

  // ---- Audio --------------------------------------------------------------
  mp3: { group: 'audio', detectedMimes: ['audio/mpeg'] },
  wav: { group: 'audio', detectedMimes: ['audio/vnd.wave'] },
  ogg: { group: 'audio', detectedMimes: ['audio/ogg', 'audio/opus', 'video/ogg'] },
  oga: { group: 'audio', detectedMimes: ['audio/ogg', 'audio/opus'] },
  m4a: { group: 'audio', detectedMimes: ['audio/x-m4a', 'audio/mp4'] },
  aac: { group: 'audio', detectedMimes: ['audio/aac'] },
  flac: { group: 'audio', detectedMimes: ['audio/x-flac'] },
};

/** Everything with an entry above, i.e. every extension that may be switched on. */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_RULES).sort();

const GROUP_LABELS: { group: FileGroup; label: string }[] = [
  { group: 'image', label: 'Images' },
  { group: 'document', label: 'Documents' },
  { group: 'video', label: 'Video' },
  { group: 'audio', label: 'Audio' },
];

/** Grouped for the admin panel, so the form never keeps its own copy of the list. */
export const SUPPORTED_EXTENSION_GROUPS: { group: FileGroup; label: string; extensions: string[] }[] =
  GROUP_LABELS.map(({ group, label }) => ({
    group,
    label,
    extensions: SUPPORTED_EXTENSIONS.filter((ext) => EXTENSION_RULES[ext].group === group),
  }));

/**
 * Enabled by default: the formats a public website actually publishes.
 *
 * Legacy `.doc` / `.xls` / `.ppt` are deliberately absent. They are OLE containers that can carry
 * VBA macros, and the same container is what `.msi` uses — it is on the signature denylist below,
 * so allowing the extensions would contradict it. Macro-enabled `.docm` / `.xlsm` / `.pptm` are
 * absent for the same reason. Save as `.docx` / `.xlsx` / `.pptx`, or enable them knowingly.
 */
export const DEFAULT_ALLOWED_EXTENSIONS: string[] = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'svg',
  'pdf', 'docx', 'xlsx', 'pptx', 'csv',
  'mp4', 'webm', 'mov',
  'mp3', 'wav', 'ogg', 'm4a',
];

/**
 * Extensions that make an *interior* segment meaningful — `report.php.pdf` is not a filename with
 * a stray word in it. Kept broad on purpose: an entry here only ever causes a rejection, and only
 * when it sits before the real extension.
 */
const RISKY_INTERIOR_EXTENSIONS = new Set([
  // Native executables and installers
  'exe', 'dll', 'so', 'dylib', 'msi', 'msp', 'msix', 'appx', 'com', 'scr', 'pif', 'cpl', 'ocx',
  'sys', 'drv', 'efi', 'elf', 'bin', 'run', 'apk', 'dex', 'deb', 'rpm', 'pkg', 'dmg', 'iso', 'img',
  // Shell and scripting
  'bat', 'cmd', 'ps1', 'psm1', 'psc1', 'sh', 'bash', 'zsh', 'csh', 'ksh', 'vbs', 'vbe', 'vb',
  'js', 'mjs', 'cjs', 'jse', 'wsf', 'wsh', 'wsc', 'sct', 'hta', 'lnk', 'reg', 'inf', 'url',
  'py', 'pyc', 'pyw', 'pl', 'rb', 'lua', 'tcl', 'awk', 'r', 'groovy',
  // Server-side handlers
  'php', 'php3', 'php4', 'php5', 'php7', 'phps', 'phtml', 'pht', 'phar',
  'asp', 'aspx', 'ashx', 'asmx', 'ascx', 'cer',
  'jsp', 'jspx', 'jspf', 'jhtml', 'cgi', 'fcgi', 'pcgi', 'jar', 'war', 'ear', 'class',
  'htaccess', 'htpasswd',
  // Browser-executed markup
  'htm', 'html', 'xhtml', 'shtml', 'xml', 'xsl', 'xslt', 'svg', 'svgz', 'swf', 'mht', 'mhtml',
  // Macro-enabled Office
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'sldm',
  // Archives — hide a second payload and are never the effective extension we want
  'zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'tar', 'cab', 'z',
  // Every format we ourselves recognise, so `photo.jpg.png` is caught too
  ...SUPPORTED_EXTENSIONS,
]);

/**
 * Byte signatures refused regardless of filename or declared type.
 *
 * `application/zip` is deliberately not here: it is the real container of every `.docx` and
 * `.odt`. Archives are controlled by the extension allow-list instead.
 */
const EXECUTABLE_SIGNATURES: { hex: string; reason: string }[] = [
  { hex: '4d5a', reason: 'a Windows executable' },
  { hex: '7f454c46', reason: 'a Linux executable' },
  { hex: 'feedface', reason: 'a macOS executable' },
  { hex: 'feedfacf', reason: 'a macOS executable' },
  { hex: 'cefaedfe', reason: 'a macOS executable' },
  { hex: 'cffaedfe', reason: 'a macOS executable' },
  { hex: 'cafebabe', reason: 'a Java class or macOS universal binary' },
  { hex: 'd0cf11e0a1b11ae1', reason: 'a legacy OLE container, which can carry macros' },
  { hex: '4d534346', reason: 'a Windows cabinet archive' },
  { hex: '6465780a', reason: 'an Android executable' },
  { hex: '0061736d', reason: 'a WebAssembly module' },
  // `4C 00 00 00` header followed by the start of the shell-link GUID.
  { hex: '4c000000011402', reason: 'a Windows shortcut' },
  { hex: '213c617263683e', reason: 'a static library archive' },
];

/**
 * Script markers. Prefix rules only fire at the very start of the file; `<?php` is searched for
 * anywhere in the sniff window, because appending it to a valid image is the standard webshell
 * trick and the byte sequence does not occur in real image data.
 */
const SCRIPT_PREFIXES: { prefix: string; reason: string }[] = [
  { prefix: '#!', reason: 'a shell script' },
  { prefix: '<%', reason: 'an ASP or JSP scriptlet' },
  { prefix: '<script', reason: 'an inline script' },
  { prefix: '<html', reason: 'an HTML document' },
  { prefix: '<!doctype html', reason: 'an HTML document' },
];

/** `<?xml` must not match here, so the PHP open tag is matched in its specific forms only. */
const EMBEDDED_SCRIPT_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /<\?php\b/i, reason: 'embedded PHP code' },
  { pattern: /<\?=/, reason: 'embedded PHP code' },
];

export type FileTypeDecision =
  | { outcome: 'allowed' }
  /** `diagnostic` is for the server log only — never surfaced to the uploader. */
  | { outcome: 'rejected'; errorMessage: string; diagnostic?: string };

/**
 * Reduce a caller-supplied extension list to something safe to enforce.
 *
 * Entries with no `EXTENSION_RULES` entry are dropped rather than trusted, so an operator cannot
 * enable `exe` by typing it into the settings. An empty result falls back to the defaults — a
 * configuration mistake should not silently block every upload in the media library.
 */
export function normaliseAllowedExtensions(input: unknown): string[] {
  if (!Array.isArray(input)) return [...DEFAULT_ALLOWED_EXTENSIONS];
  const cleaned = input
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase().replace(/^\.+/, ''))
    .filter((v) => Object.prototype.hasOwnProperty.call(EXTENSION_RULES, v));
  const unique = [...new Set(cleaned)].sort();
  // Sorted on both paths so the value the API and admin panel report is order-stable.
  return unique.length > 0 ? unique : [...DEFAULT_ALLOWED_EXTENSIONS].sort();
}

function startsWithSignature(head: Buffer, hex: string): boolean {
  const sig = Buffer.from(hex, 'hex');
  return head.length >= sig.length && head.subarray(0, sig.length).equals(sig);
}

/**
 * Apply the type policy to one upload.
 *
 * `filename` is the already-validated name from `checkUploadFilename` — the extension is parsed
 * from the same string core will parse, so the two cannot disagree.
 */
export async function applyFileTypePolicy(
  file: UploadFile,
  filename: string,
  allowedExtensions: string[],
  options: { blockMultipleExtensions: boolean }
): Promise<FileTypeDecision> {
  const segments = extensionSegments(filename);
  if (segments.length === 0) {
    return { outcome: 'rejected', errorMessage: 'Filename must include a file extension.' };
  }

  const ext = segments[segments.length - 1];
  const allowed = new Set(allowedExtensions);

  if (!allowed.has(ext)) {
    // The permitted set is deliberately not enumerated here. Reflecting the whole allow-list to an
    // unauthenticated caller hands them a map of what to probe; the list belongs in the admin panel,
    // which is authenticated and permission-gated. The log line below carries it for operators.
    return {
      outcome: 'rejected',
      errorMessage: `Files of type ".${ext}" are not allowed. Only approved image, document, audio and video formats can be uploaded.`,
      diagnostic: `".${ext}" is not in the allow-list [${allowedExtensions.join(', ')}]`,
    };
  }

  // Gate 2 — a second meaningful extension before the effective one.
  if (options.blockMultipleExtensions) {
    const interior = segments.slice(0, -1);
    for (const segment of interior) {
      // `virus.svg%00.png` reads as `svg%00` here. Stripping percent escapes means the segment is
      // recognised as `svg` even if filename validation were switched off.
      const candidates = [segment, segment.replace(/%[0-9a-f]{2}/gi, '')];
      const hit = candidates.find((c) => c.length > 0 && RISKY_INTERIOR_EXTENSIONS.has(c));
      if (hit) {
        return {
          outcome: 'rejected',
          errorMessage: `Filename rejected: it carries more than one file extension (".${hit}" before ".${ext}").`,
          diagnostic: `interior extension ".${hit}" in "${filename}"`,
        };
      }
    }
  }

  const rule = EXTENSION_RULES[ext];

  let head: Buffer;
  try {
    head = await readHeadBytes(file, TYPE_SNIFF_BYTES);
  } catch {
    return { outcome: 'rejected', errorMessage: 'Unable to read the uploaded file for validation.' };
  }

  if (head.length === 0) {
    return { outcome: 'rejected', errorMessage: 'The uploaded file is empty.' };
  }

  // Gate 3a — executable and script content, whatever the extension claims.
  for (const signature of EXECUTABLE_SIGNATURES) {
    if (startsWithSignature(head, signature.hex)) {
      return {
        outcome: 'rejected',
        errorMessage: `File rejected: its content is ${signature.reason}.`,
        diagnostic: `signature ${signature.hex} matched for "${filename}"`,
      };
    }
  }

  const headText = head.toString('latin1');
  const trimmedLower = headText.replace(/^[\s\ufeff]+/, '').toLowerCase();
  for (const { prefix, reason } of SCRIPT_PREFIXES) {
    if (trimmedLower.startsWith(prefix)) {
      return {
        outcome: 'rejected',
        errorMessage: `File rejected: its content is ${reason}.`,
        diagnostic: `content starts with "${prefix}" for "${filename}"`,
      };
    }
  }
  for (const { pattern, reason } of EMBEDDED_SCRIPT_PATTERNS) {
    if (pattern.test(headText)) {
      return {
        outcome: 'rejected',
        errorMessage: `File rejected: it contains ${reason}.`,
        diagnostic: `${pattern} matched in the first ${head.length} bytes of "${filename}"`,
      };
    }
  }

  // Gate 3b — the bytes must be the format the extension claims.
  let detected: string | undefined;
  try {
    detected = (await FileType.fromBuffer(head))?.mime;
  } catch {
    detected = undefined;
  }

  if (detected) {
    if (!rule.detectedMimes.includes(detected)) {
      // What was detected stays in the log. Telling the uploader turns the endpoint into a type
      // oracle they can use to fingerprint the check without ever landing a file.
      return {
        outcome: 'rejected',
        errorMessage: `File content does not match its ".${ext}" extension.`,
        diagnostic: `detected "${detected}", expected one of [${rule.detectedMimes.join(', ') || 'none'}]`,
      };
    }
    return { outcome: 'allowed' };
  }

  // Nothing detected. Fine for a text format, which has no signature to find; for anything else
  // it means the bytes are not the claimed format, so the extension cannot be taken on trust.
  if (!rule.textBased) {
    return {
      outcome: 'rejected',
      errorMessage: `File content could not be verified as a valid ".${ext}" file.`,
      diagnostic: `no signature detected for "${filename}" (declared "${file.mimetype || 'unknown'}")`,
    };
  }

  return { outcome: 'allowed' };
}
