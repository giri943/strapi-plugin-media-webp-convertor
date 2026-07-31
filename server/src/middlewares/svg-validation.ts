import { decodeSvgText, startsWithSvgElement } from './svg-text';
import { readHeadBytes, readWholeUpload, resolveUploadSize, type UploadFile } from './upload-file';

/**
 * Content security scanning for SVG uploads.
 *
 * An SVG is an XML document the browser executes, so an upload that merely *looks* like an
 * image can carry script. Every rule below is matched against the raw text **and** against an
 * entity-decoded copy, so `&#106;avascript:` cannot smuggle a payload past a literal match.
 */

const MAX_SVG_FILE_SIZE = 5 * 1024 * 1024;

/** Shared with `isImageFile` so the two never disagree about what counts as an SVG. */
export const SVG_MIME_TYPES = ['image/svg+xml', 'application/svg+xml', 'text/svg+xml'];

/** gzip magic — a `.svgz` is still executed by the browser but defeats text scanning. */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/** Bytes inspected when sniffing an undeclared SVG. */
const SNIFF_BYTES = 1024;

type SvgRule = { pattern: RegExp; reason: string };

/**
 * `(?:[a-z0-9-]+:)?` on element rules catches namespace-prefixed forms such as `<svg:script>`,
 * which parse identically but slip past a bare `<script` match.
 */
const SVG_RULES: SvgRule[] = [
  { pattern: /<\s*(?:[a-z0-9-]+:)?script\b/i, reason: 'a <script> element' },
  {
    pattern: /<\s*(?:[a-z0-9-]+:)?(?:iframe|object|embed|applet|frame|frameset|foreignObject|handler|audio|video)\b/i,
    reason: 'an embedded-content element',
  },
  {
    pattern: /<\s*(?:[a-z0-9-]+:)?(?:animate|animateTransform|animateMotion|set)\b/i,
    reason: 'a SMIL animation element (can rewrite attributes at runtime)',
  },
  { pattern: /<\s*(?:[a-z0-9-]+:)?(?:link|meta|base)\b/i, reason: 'an external-resource element' },
  { pattern: /<\?xml-stylesheet/i, reason: 'an XML stylesheet processing instruction' },
  { pattern: /<!ENTITY/i, reason: 'a DTD entity declaration (XXE risk)' },

  // Any attribute whose name starts with "on" is an event handler; SVG has no benign ones.
  { pattern: /\son[a-z]+\s*=/i, reason: 'an inline event handler attribute' },

  // Interleaved whitespace defeats a literal "javascript:" match.
  {
    pattern: /j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i,
    reason: 'a javascript: URL',
  },
  { pattern: /\b(?:vbscript|livescript|mocha)\s*:/i, reason: 'a scripting URL' },

  // `data:image/png;base64,…` is legitimate and common, so only executable payloads are refused.
  {
    pattern: /data\s*:\s*(?:text\/html|application\/(?:javascript|ecmascript|xhtml\+xml)|image\/svg\+xml)/i,
    reason: 'a data: URL carrying executable content',
  },

  { pattern: /@import\b/i, reason: 'a CSS @import' },
  { pattern: /expression\s*\(/i, reason: 'a CSS expression()' },
  { pattern: /-moz-binding/i, reason: 'a -moz-binding CSS rule' },

  // Internal references start with "#"; anything else pulls in an external document.
  // The quote is matched together with the first value character — an optional-quote group
  // would backtrack past it and flag the legitimate `href="#id"` form.
  {
    pattern: /<\s*(?:[a-z0-9-]+:)?use\b[^>]*?\b(?:xlink:)?href\s*=\s*(?:"[^#"]|'[^#']|[^\s>"'#])/i,
    reason: 'a <use> element referencing an external document',
  },
];

export type SvgValidationResult = { outcome: 'valid' } | { outcome: 'invalid'; errorMessage: string };

/** An SVG is claimed when either the client-sent mime type or the filename says so. */
export function isSvgFile(file: UploadFile): boolean {
  const mime = (file.mimetype || '').toLowerCase().trim();
  if (SVG_MIME_TYPES.includes(mime)) return true;
  const name = (file.originalFilename || '').toLowerCase();
  return name.endsWith('.svg') || name.endsWith('.svgz');
}

function codePointToChar(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Resolve XML/HTML entities so encoded payloads are scanned in their decoded form.
 * `&amp;` is resolved last so `&amp;#106;` does not decode into a live character.
 */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => codePointToChar(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => codePointToChar(parseInt(dec, 10)))
    .replace(/&lt;?/gi, '<')
    .replace(/&gt;?/gi, '>')
    .replace(/&quot;?/gi, '"')
    .replace(/&apos;?/gi, "'")
    .replace(/&colon;?/gi, ':')
    .replace(/&NewLine;?/gi, '\n')
    .replace(/&Tab;?/gi, '\t')
    .replace(/&amp;?/gi, '&');
}

/**
 * True when the file *is* an SVG document — i.e. `<svg>` is its root element — regardless of the
 * extension it was uploaded under. Catches an SVG renamed `.txt` without misclassifying an HTML
 * page or Markdown note that merely embeds an inline SVG example.
 */
export async function hasSvgSignature(file: UploadFile): Promise<boolean> {
  try {
    const head = await readHeadBytes(file, SNIFF_BYTES);
    return startsWithSvgElement(decodeSvgText(head).text);
  } catch {
    return false;
  }
}

export async function validateSvgFile(file: UploadFile): Promise<SvgValidationResult> {
  try {
    const size = await resolveUploadSize(file);

    if (size === 0) {
      return { outcome: 'invalid', errorMessage: 'SVG file is empty.' };
    }
    if (size > MAX_SVG_FILE_SIZE) {
      return {
        outcome: 'invalid',
        errorMessage: `SVG file is too large. Maximum is ${MAX_SVG_FILE_SIZE / (1024 * 1024)}MB.`,
      };
    }

    // Bounded by MAX_SVG_FILE_SIZE above, so reading every byte is safe here.
    const raw = await readWholeUpload(file);

    // A gzipped SVG renders in the browser but reads as binary noise here, so pattern
    // scanning would pass it blind. Refuse rather than accept something unscannable.
    if (raw.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC)) {
      return {
        outcome: 'invalid',
        errorMessage: 'Compressed SVG (.svgz) uploads are not accepted — upload an uncompressed .svg instead.',
      };
    }

    const { text, encoding } = decodeSvgText(raw);

    // If the decoded text has no <svg> element at all, the bytes were not interpreted the way
    // the browser will interpret them — an encoding we don't handle, or binary. Refusing beats
    // scanning gibberish and calling it clean.
    if (!/<\s*(?:[a-z0-9-]+:)?svg[\s>/]/i.test(text)) {
      return {
        outcome: 'invalid',
        errorMessage: `SVG could not be read for validation (decoded as ${encoding}). Re-save it as UTF-8 and upload again.`,
      };
    }

    const candidates = [text, decodeEntities(text)];

    for (const rule of SVG_RULES) {
      if (candidates.some((candidate) => rule.pattern.test(candidate))) {
        return {
          outcome: 'invalid',
          errorMessage: `SVG rejected: it contains ${rule.reason}.`,
        };
      }
    }

    return { outcome: 'valid' };
  } catch {
    return { outcome: 'invalid', errorMessage: 'Unable to validate SVG.' };
  }
}
