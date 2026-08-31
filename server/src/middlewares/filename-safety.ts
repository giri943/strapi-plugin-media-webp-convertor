/**
 * Filename normalisation and rejection rules for uploads.
 *
 * A filename is attacker-controlled text that ends up in a URL, on a filesystem, and in the admin
 * panel. Strapi core already refuses raw control bytes and the Windows-reserved characters, but it
 * decides the extension with `path.extname()` on the name *as sent* — so a name that only looks
 * truncated to a human, such as `virus.svg%00.png`, is read as a `.png` and sails through. The
 * percent sequence is literal text: multipart filenames are never URL-decoded, which is exactly
 * why the trick works and why matching the literal form is the fix.
 *
 * Everything here rejects rather than repairs. Silently rewriting a hostile name produces a second
 * name nobody validated, and that is where the next bypass comes from. The one exception is
 * Unicode NFC normalisation plus trimming the outer whitespace, which is what the rest of the
 * stack assumes anyway.
 */

import { randomBytes } from 'crypto';

/** Leaves room for Strapi's `_<10 hex>` hash suffix inside the 255-character filesystem limit. */
const MAX_FILENAME_LENGTH = 200;

export type FilenameCheck =
  | { outcome: 'ok'; safeName: string }
  /** `diagnostic` is for the server log only — never surfaced to the uploader. */
  | { outcome: 'invalid'; errorMessage: string; diagnostic?: string };

type NameRule = { pattern: RegExp; reason: string };

/**
 * `%00` is the headline case, but any encoded control character or separator is the same class of
 * trick, so the whole range is refused. A literal `%` is still fine — `100% cotton.pdf` matches
 * nothing here; only `%` followed by an escape that decodes to something dangerous does.
 */
const ENCODED_RULES: NameRule[] = [
  { pattern: /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i, reason: 'an encoded control character' },
  { pattern: /%u00[0-9a-f]{2}/i, reason: 'an encoded control character' },
  { pattern: /%2e%2e/i, reason: 'an encoded directory traversal' },
  { pattern: /%(?:2f|5c)/i, reason: 'an encoded path separator' },
];

const STRUCTURAL_RULES: NameRule[] = [
  // C0, DEL and C1. Core rejects C0 as well; this runs first so the uploader gets a clear reason.
  // eslint-disable-next-line no-control-regex
  { pattern: /[\u0000-\u001f\u007f-\u009f]/, reason: 'a control character' },

  // Zero-width and bidirectional-override characters. `invoice\u202Egpj.exe` renders to a reader
  // as `invoice.exe...jpg` — the extension the eye sees is not the extension the server parses.
  {
    pattern: /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/,
    reason: 'a zero-width or text-direction override character',
  },

  { pattern: /[/\\]/, reason: 'a path separator' },
  { pattern: /\.\./, reason: 'a directory traversal sequence' },
  { pattern: /[<>:"|?*]/, reason: 'a reserved character' },
  { pattern: /^\./, reason: 'a leading dot (hidden-file name)' },
  { pattern: /[. ]$/, reason: 'a trailing dot or space' },
];

/** `CON`, `LPT1` and friends are device names on Windows regardless of the extension. */
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Validate an uploaded filename and return the normalised form to use downstream.
 *
 * The returned `safeName` differs from the input only by NFC normalisation and outer whitespace.
 * Callers should write it back onto the file so core parses the same string that was validated.
 */
export function checkUploadFilename(rawName: string): FilenameCheck {
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    return { outcome: 'invalid', errorMessage: 'The upload has no filename.' };
  }

  const name = rawName.normalize('NFC').trim();

  if (name.length > MAX_FILENAME_LENGTH) {
    return {
      outcome: 'invalid',
      errorMessage: `Filename is too long. Maximum is ${MAX_FILENAME_LENGTH} characters.`,
    };
  }

  for (const rule of [...ENCODED_RULES, ...STRUCTURAL_RULES]) {
    if (rule.pattern.test(name)) {
      return {
        outcome: 'invalid',
        errorMessage: `Filename rejected: it contains ${rule.reason}.`,
        diagnostic: `"${describeForLog(rawName)}" matched ${rule.pattern}`,
      };
    }
  }

  const segments = name.split('.');
  if (segments.length < 2 || segments[segments.length - 1] === '') {
    return { outcome: 'invalid', errorMessage: 'Filename must include a file extension.' };
  }

  if (WINDOWS_RESERVED_BASENAME.test(segments[0])) {
    return {
      outcome: 'invalid',
      errorMessage: 'Filename rejected: it uses a reserved device name.',
    };
  }

  return { outcome: 'ok', safeName: name };
}

/**
 * Replace the whole basename with a random token, keeping the extension.
 *
 * Strapi already appends 10 random hex characters to the slugified basename, so URLs are not
 * guessable out of the box. This goes further and removes the uploader's text from the stored name
 * altogether, which is what "rename uploaded files using randomized names" asks for.
 */
export function randomisedFilename(name: string): string {
  const segments = extensionSegments(name);
  const ext = segments.length > 0 ? segments[segments.length - 1] : '';
  const token = randomBytes(16).toString('hex');
  return ext ? `${token}.${ext}` : token;
}

/** Control characters rendered visibly, so a rejection can be diagnosed from the log. */
function describeForLog(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Extension segments of a filename, lowercased, in order.
 *
 * `virus.svg.png` → `['svg', 'png']`. The last entry is the effective extension — the one
 * `path.extname()` returns and the one the web server maps to a content type.
 */
export function extensionSegments(name: string): string[] {
  const segments = name.split('.');
  return segments.slice(1).map((s) => s.toLowerCase());
}
