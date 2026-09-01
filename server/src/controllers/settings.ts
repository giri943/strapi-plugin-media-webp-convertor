import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from '../constants';
import { SETTINGS_LIMITS } from '../services/settings';
import { formatBytes, resolveUploadLimit } from '../middlewares/upload-size';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async get(ctx: any) {
    const data = await strapi.plugin(PLUGIN_NAME).service('settings').get();
    const uploadLimit = resolveUploadLimit(strapi);
    // Limits travel with the values so the admin form validates against the server's ranges
    // rather than its own copy of the numbers. The upload ceiling goes with them as read-only
    // context: it belongs to the host project, so the panel reports it rather than editing it.
    ctx.body = {
      data,
      meta: {
        limits: SETTINGS_LIMITS,
        uploadLimit: {
          bytes: uploadLimit.bytes,
          formatted: formatBytes(uploadLimit.bytes),
          source: uploadLimit.source,
        },
      },
    };
  },

  async update(ctx: any) {
    const body = ctx.request.body as {
      webpQuality?: number;
      webpConversionEnabled?: boolean;
      pdfValidationEnabled?: boolean;
      maxSvgSizeMb?: number;
      blockPdfActiveContent?: boolean;
      fileTypePolicyEnabled?: boolean;
      allowedFileExtensions?: string[];
      blockMultipleExtensions?: boolean;
      randomizeStoredFilenames?: boolean;
    };
    const data = await strapi.plugin(PLUGIN_NAME).service('settings').set({
      webpQuality: body.webpQuality,
      webpConversionEnabled: body.webpConversionEnabled,
      pdfValidationEnabled: body.pdfValidationEnabled,
      maxSvgSizeMb: body.maxSvgSizeMb,
      blockPdfActiveContent: body.blockPdfActiveContent,
      fileTypePolicyEnabled: body.fileTypePolicyEnabled,
      allowedFileExtensions: body.allowedFileExtensions,
      blockMultipleExtensions: body.blockMultipleExtensions,
      randomizeStoredFilenames: body.randomizeStoredFilenames,
    });
    ctx.body = { data };
  },
});
