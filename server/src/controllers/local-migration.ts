import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from '../constants';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getStats(ctx: any) {
    try {
      const result = await strapi.plugin(PLUGIN_NAME).service('localMigration').getStats();
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 400;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'Failed to get stats' } };
    }
  },

  async testConnection(ctx: any) {
    const body = ctx.request.body as {
      region?: string;
      bucket?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    };

    if (!body.region?.trim() || !body.bucket?.trim() || !body.accessKeyId?.trim() || !body.secretAccessKey?.trim()) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Region, bucket, access key ID, and secret access key are required.' } };
      return;
    }

    try {
      const result = await strapi.plugin(PLUGIN_NAME).service('localMigration').testConnection({
        region: body.region.trim(),
        bucket: body.bucket.trim(),
        accessKeyId: body.accessKeyId.trim(),
        secretAccessKey: body.secretAccessKey.trim(),
      });
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 400;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'S3 connection test failed' } };
    }
  },

  async migrateBatch(ctx: any) {
    const body = ctx.request.body as {
      offset?: unknown;
      batchSize?: unknown;
      region?: string;
      bucket?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      baseUrl?: string;
      keyPrefix?: string;
      preserveFolders?: boolean;
      deleteLocal?: boolean;
    };

    if (
      !body.region?.trim() ||
      !body.bucket?.trim() ||
      !body.accessKeyId?.trim() ||
      !body.secretAccessKey?.trim() ||
      !body.baseUrl?.trim()
    ) {
      ctx.status = 400;
      ctx.body = {
        error: { message: 'Region, bucket, access key ID, secret access key, and base URL are required.' },
      };
      return;
    }

    const baseUrl = body.baseUrl.trim();
    if (!/^https?:\/\//i.test(baseUrl) || baseUrl.length > 1000) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Base URL must be a valid http:// or https:// URL.' } };
      return;
    }

    const offset = typeof body.offset === 'number' && body.offset >= 0 ? body.offset : 0;
    const batchSize = typeof body.batchSize === 'number' ? Math.min(20, Math.max(1, body.batchSize)) : 5;

    try {
      const result = await strapi.plugin(PLUGIN_NAME).service('localMigration').migrateBatch(offset, batchSize, {
        region: body.region.trim(),
        bucket: body.bucket.trim(),
        accessKeyId: body.accessKeyId.trim(),
        secretAccessKey: body.secretAccessKey.trim(),
        baseUrl,
        keyPrefix: body.keyPrefix?.trim() ?? '',
        preserveFolders: body.preserveFolders === true,
        deleteLocal: body.deleteLocal === true,
      });
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 400;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'Migration batch failed' } };
    }
  },
});
