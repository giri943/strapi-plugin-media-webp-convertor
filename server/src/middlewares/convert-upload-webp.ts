import type { Core } from '@strapi/strapi';
import { isStrapiMultipartUpload, processUploadFiles } from './upload-transform-helpers';
import { isUploadRejectedError, toClientSafeMessage } from './upload-rejection';

/**
 * Strapi plugin middleware: PDF + SVG validation, WebP normalization, and fileInfo name sync.
 * Mounted globally from the plugin `bootstrap` (after `strapi::body`, before routes).
 */
export default (_config: unknown, { strapi }: { strapi: Core.Strapi }) => {
  return async (ctx: any, next: () => Promise<unknown>) => {
    if (!isStrapiMultipartUpload(ctx)) {
      return next();
    }
    try {
      await processUploadFiles(ctx, strapi);
    } catch (error) {
      const rejected = isUploadRejectedError(error);
      const message = error instanceof Error ? error.message : String(error);

      if (!rejected) {
        strapi.log.error(`[strapi-media-webp-convertor] Upload transform error: ${message}`);
      }

      // The response is written here rather than rethrown. Core's error middleware maps a
      // rejection to 400 only when it is an `ApplicationError` from *its own* copy of
      // `@strapi/utils`; when the host resolves a second copy for this plugin, that
      // `instanceof` fails and the uploader gets a bare 500 with no reason. Writing the
      // Strapi-shaped error body directly makes the message reach the admin panel either way.
      ctx.status = rejected ? 400 : 500;
      ctx.body = {
        data: null,
        error: {
          status: ctx.status,
          name: rejected ? 'ValidationError' : 'ApplicationError',
          // Sanitised on the way out: the admin panel renders this through ICU, where `<` and `{`
          // are syntax. Anything unexpected stays internal — only refusals get a reason at all.
          message: rejected ? toClientSafeMessage(message) : 'Upload processing failed.',
          details: {},
        },
      };
      return;
    }
    return next();
  };
};
