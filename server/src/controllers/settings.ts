import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from '../constants';
import { SETTINGS_LIMITS } from '../services/settings';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async get(ctx: any) {
    const data = await strapi.plugin(PLUGIN_NAME).service('settings').get();
    // Limits travel with the values so the admin form validates against the server's ranges
    // rather than its own copy of the numbers.
    ctx.body = { data, meta: { limits: SETTINGS_LIMITS } };
  },

  async update(ctx: any) {
    const body = ctx.request.body as {
      webpQuality?: number;
      webpConversionEnabled?: boolean;
      pdfValidationEnabled?: boolean;
      maxPdfSizeMb?: number;
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
      maxPdfSizeMb: body.maxPdfSizeMb,
      blockPdfActiveContent: body.blockPdfActiveContent,
      fileTypePolicyEnabled: body.fileTypePolicyEnabled,
      allowedFileExtensions: body.allowedFileExtensions,
      blockMultipleExtensions: body.blockMultipleExtensions,
      randomizeStoredFilenames: body.randomizeStoredFilenames,
    });
    ctx.body = { data };
  },
});
