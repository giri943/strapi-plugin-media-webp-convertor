import type { Core } from '@strapi/strapi';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async get(ctx: any) {
    const data = await strapi.plugin('strapi-media-webp-convertor').service('settings').get();
    ctx.body = { data };
  },

  async update(ctx: any) {
    const body = ctx.request.body as { webpQuality?: number; webpConversionEnabled?: boolean };
    const data = await strapi.plugin('strapi-media-webp-convertor').service('settings').set({
      webpQuality: body.webpQuality,
      webpConversionEnabled: body.webpConversionEnabled,
    });
    ctx.body = { data };
  },
});
