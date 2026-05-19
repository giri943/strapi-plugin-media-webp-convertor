import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from '../constants';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async stats(ctx: any) {
    try {
      const result = await strapi.plugin(PLUGIN_NAME).service('conversion').getStats();
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 500;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'Failed to get stats' } };
    }
  },

  async listFiles(ctx: any) {
    const page = Math.max(1, parseInt((ctx.query.page as string) || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt((ctx.query.pageSize as string) || '20', 10)));
    try {
      const result = await strapi.plugin(PLUGIN_NAME).service('conversion').listConvertibleFiles(page, pageSize);
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 500;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'Failed to list files' } };
    }
  },

  async convertBatch(ctx: any) {
    const { fileIds, quality } = ctx.request.body as { fileIds?: unknown; quality?: unknown };

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      ctx.status = 400;
      ctx.body = { error: { message: 'fileIds must be a non-empty array.' } };
      return;
    }
    if (fileIds.length > 50) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Maximum 50 files per batch.' } };
      return;
    }

    const ids = fileIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) {
      ctx.status = 400;
      ctx.body = { error: { message: 'fileIds must contain valid positive integers.' } };
      return;
    }

    let webpQuality = typeof quality === 'number' ? Math.min(100, Math.max(1, quality)) : null;
    if (webpQuality === null) {
      try {
        const settings = await strapi.plugin(PLUGIN_NAME).service('settings').get();
        webpQuality = (settings as { webpQuality: number }).webpQuality;
      } catch {
        webpQuality = 82;
      }
    }

    try {
      const result = await strapi.plugin(PLUGIN_NAME).service('conversion').convertBatch(ids, webpQuality);
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 500;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'Conversion failed' } };
    }
  },
});
