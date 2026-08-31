import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from './constants';

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

export default async ({ strapi }: { strapi: Core.Strapi }) => {
  await strapi.plugin(PLUGIN_NAME).service('settings').ensureDefaults();
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
