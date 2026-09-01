import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from './constants';
import { formatBytes, resolveUploadLimit } from './middlewares/upload-size';

type MiddlewareFactory = (config: unknown, opts: { strapi: Core.Strapi }) => (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>;

/**
 * Mounts the upload transform on the global Koa app after core `initMiddlewares` (runs in plugin bootstrap).
 * This avoids requiring a line in the host `config/middlewares.ts`; order is still after `strapi::body`
 * and before the router is mounted at listen time.
 */
/**
 * The plugin decides what may be *stored*. It has no say in how the bytes are later *served*, and
 * the local provider serves them from inside the web root as static files. That is fine for images
 * and documents, but "store uploads outside the web root, without execute permission" is a control
 * that lives in the host's provider and reverse-proxy configuration, so say so once at startup
 * rather than leaving the gap silent.
 */
function warnAboutLocalProvider(strapi: Core.Strapi) {
  try {
    const uploadConfig = strapi.config.get('plugin::upload') as { provider?: unknown } | undefined;
    const provider = typeof uploadConfig?.provider === 'string' ? uploadConfig.provider : 'local';
    if (provider !== 'local') return;

    strapi.log.info(
      `[${PLUGIN_NAME}] Upload provider is "local", so media is served from public/uploads inside the web root. ` +
        'Upload type validation is enforced, but make sure your web server serves that path as static content only, with script execution disabled.'
    );
  } catch {
    /* advisory only — never block boot over a log line */
  }
}

/**
 * Report the size ceiling the plugin inherited, and where it read it from.
 *
 * Worth a line at startup because the value is not the plugin's own: an operator who sets
 * `sizeLimit` but not the body middleware's `formidable.maxFileSize` gets a different number than
 * they expect, and this is where that shows up.
 */
function reportUploadLimit(strapi: Core.Strapi) {
  try {
    const limit = resolveUploadLimit(strapi);
    strapi.log.info(
      `[${PLUGIN_NAME}] Maximum upload size ${formatBytes(limit.bytes)}, inherited from ${limit.source}. ` +
        'The plugin applies no size limit of its own; PDFs are content-scanned at any size.'
    );
  } catch {
    /* advisory only */
  }
}

export default async ({ strapi }: { strapi: Core.Strapi }) => {
  await strapi.plugin(PLUGIN_NAME).service('settings').ensureDefaults();
  reportUploadLimit(strapi);
  warnAboutLocalProvider(strapi);

  const factory = strapi.plugin(PLUGIN_NAME).middleware('convert-upload-webp') as MiddlewareFactory | undefined;
  if (typeof factory !== 'function') {
    strapi.log.warn(
      `[${PLUGIN_NAME}] Middleware factory "convert-upload-webp" is missing; WebP upload optimization is disabled.`
    );
    return;
  }

  const handler = factory({}, { strapi });
  strapi.server.use(handler);
};
