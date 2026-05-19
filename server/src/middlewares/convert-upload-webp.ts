import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { isStrapiMultipartUpload, processUploadFiles } from './upload-transform-helpers';

const { ApplicationError } = errors;

/**
 * Strapi plugin middleware: WebP normalization + SVG checks + fileInfo name sync.
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
      const msg = error instanceof Error ? error.message : String(error);
      strapi.log.error(`[strapi-media-webp-convertor] Upload transform error: ${msg}`);
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw new ApplicationError(msg || 'Upload processing failed');
    }
    return next();
  };
};
