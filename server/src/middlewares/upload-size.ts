import type { Core } from '@strapi/strapi';

/**
 * The host project's upload size limit, resolved once from Strapi's own configuration.
 *
 * The plugin deliberately keeps no size limit of its own. A project that has decided it accepts
 * 150 MB uploads — usually via an env var wired into `config/middlewares.ts` — should not then be
 * told "no" by a plugin holding a second, smaller number. One value, one place it comes from.
 *
 * Reading resolved config rather than `process.env` directly matters: the env var name is a project
 * convention (`MAX_UPLOAD_FILE_SIZE` is common but nothing enforces it), and by the time the plugin
 * boots, whatever it was called has already landed in the config below.
 */

/** formidable 2.x's own default, which is what actually gates multipart uploads when unset. */
const FORMIDABLE_DEFAULT_BYTES = 200 * 1024 * 1024;

type MiddlewareEntry =
  | string
  | { name?: string; resolve?: string; config?: { formidable?: { maxFileSize?: unknown } } };

function positiveInteger(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * `formidable.maxFileSize` from the `strapi::body` middleware entry.
 *
 * This is the limit that genuinely gates a multipart upload — `strapi::body` runs before this
 * plugin and answers `413` on its own, so nothing larger ever reaches us.
 */
function bodyMiddlewareLimit(strapi: Core.Strapi): number | undefined {
  const entries = strapi.config.get('middlewares') as MiddlewareEntry[] | undefined;
  if (!Array.isArray(entries)) return undefined;

  for (const entry of entries) {
    if (typeof entry === 'string' || !entry) continue;
    const isBody = entry.name === 'strapi::body' || entry.resolve?.includes('body');
    if (!isBody) continue;
    const limit = positiveInteger(entry.config?.formidable?.maxFileSize);
    if (limit !== undefined) return limit;
  }
  return undefined;
}

export type ResolvedUploadLimit = {
  bytes: number;
  /** Where the number came from, for the startup log. */
  source: string;
};

let cached: ResolvedUploadLimit | undefined;

/**
 * Resolve the effective maximum upload size in bytes.
 *
 * Precedence is deliberate. `plugin::upload.sizeLimit` carries a 1 GB *default*, so it reads as
 * "set" on virtually every project and would be a misleading primary source; the body middleware's
 * value is the one an operator changes to actually raise the ceiling. When only `sizeLimit` is
 * configured it is honoured, but capped at formidable's default, because that is still the real
 * gate in front of us.
 */
export function resolveUploadLimit(strapi: Core.Strapi): ResolvedUploadLimit {
  if (cached) return cached;

  try {
    const fromBody = bodyMiddlewareLimit(strapi);
    if (fromBody !== undefined) {
      cached = { bytes: fromBody, source: 'strapi::body formidable.maxFileSize' };
      return cached;
    }

    const fromUpload = positiveInteger(strapi.config.get('plugin::upload.sizeLimit'));
    if (fromUpload !== undefined) {
      const bytes = Math.min(fromUpload, FORMIDABLE_DEFAULT_BYTES);
      cached = {
        bytes,
        source:
          bytes === fromUpload
            ? 'plugin::upload.sizeLimit'
            : `plugin::upload.sizeLimit, capped at formidable's ${formatBytes(FORMIDABLE_DEFAULT_BYTES)} default`,
      };
      return cached;
    }
  } catch {
    /* fall through to the default */
  }

  cached = { bytes: FORMIDABLE_DEFAULT_BYTES, source: "formidable's default" };
  return cached;
}

/** Test seam — configuration does not change at runtime, so the value is cached per process. */
export function resetUploadLimitCache() {
  cached = undefined;
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)}GB`;
  }
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}
