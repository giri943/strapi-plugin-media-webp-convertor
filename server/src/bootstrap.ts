import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from './constants';

type MiddlewareFactory = (config: unknown, opts: { strapi: Core.Strapi }) => (ctx: unknown, next: () => Promise<unknown>) => Promise<unknown>;

/**
 * Mounts the upload transform on the global Koa app after core `initMiddlewares` (runs in plugin bootstrap).
 * This avoids requiring a line in the host `config/middlewares.ts`; order is still after `strapi::body`
 * and before the router is mounted at listen time.
 */
export default async ({ strapi }: { strapi: Core.Strapi }) => {
  await strapi.plugin(PLUGIN_NAME).service('settings').ensureDefaults();

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
