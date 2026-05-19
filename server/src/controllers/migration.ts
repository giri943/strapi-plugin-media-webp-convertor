import type { Core } from '@strapi/strapi';

type S3Body = {
  region?: string;
  sourceBucket?: string;
  sourcePrefix?: string;
  destBucket?: string;
  destPrefix?: string;
  destRegion?: string;
  sourceAccessKeyId?: string;
  sourceSecretAccessKey?: string;
  destAccessKeyId?: string;
  destSecretAccessKey?: string;
  continuationToken?: string;
  maxKeys?: number;
};

function s3ContextFromBody(body: S3Body) {
  return {
    region: body.region || '',
    sourceBucket: body.sourceBucket || '',
    sourcePrefix: body.sourcePrefix || '',
    destBucket: body.destBucket || '',
    destPrefix: body.destPrefix || '',
    destRegion: body.destRegion,
    sourceAccessKeyId: body.sourceAccessKeyId,
    sourceSecretAccessKey: body.sourceSecretAccessKey,
    destAccessKeyId: body.destAccessKeyId,
    destSecretAccessKey: body.destSecretAccessKey,
  };
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async preview(ctx: any) {
    const { oldUrlPrefix, newUrlPrefix } = ctx.request.body as { oldUrlPrefix?: string; newUrlPrefix?: string };
    const oldP = (oldUrlPrefix ?? '').trim();
    const newP = (newUrlPrefix ?? '').trim();
    if (!oldP || !newP) {
      ctx.status = 400;
      ctx.body = {
        error: { message: 'Old URL prefix and new URL prefix are required and cannot be blank.' },
      };
      return;
    }
    try {
      const result = await strapi.plugin('strapi-media-webp-convertor').service('migration').previewUrlReplace(oldP, newP);
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 400;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'URL migration preview failed' } };
    }
  },

  async replaceUrls(ctx: any) {
    const { oldUrlPrefix, newUrlPrefix } = ctx.request.body as { oldUrlPrefix?: string; newUrlPrefix?: string };
    const oldP = (oldUrlPrefix ?? '').trim();
    const newP = (newUrlPrefix ?? '').trim();
    if (!oldP || !newP) {
      ctx.status = 400;
      ctx.body = {
        error: { message: 'Old URL prefix and new URL prefix are required and cannot be blank.' },
      };
      return;
    }
    try {
      const result = await strapi.plugin('strapi-media-webp-convertor').service('migration').applyUrlReplace(oldP, newP);
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 400;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'URL migration replace failed' } };
    }
  },

  async s3TestConnection(ctx: any) {
    const body = ctx.request.body as S3Body;
    const ctxS3 = s3ContextFromBody(body);
    if (
      !ctxS3.region?.trim() ||
      !ctxS3.sourceBucket?.trim() ||
      !ctxS3.destBucket?.trim() ||
      !ctxS3.sourceAccessKeyId?.trim() ||
      !ctxS3.sourceSecretAccessKey?.trim()
    ) {
      ctx.status = 400;
      ctx.body = {
        error: {
          message:
            'Region, source bucket, destination bucket, source access key ID, and source secret access key are required.',
        },
      };
      return;
    }
    try {
      const result = await strapi.plugin('strapi-media-webp-convertor').service('migration').testS3Connection(ctxS3);
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 400;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'S3 connection test failed' } };
    }
  },

  async s3CopyBatch(ctx: any) {
    const body = ctx.request.body as S3Body;
    const ctxS3 = s3ContextFromBody(body);
    if (
      !ctxS3.region?.trim() ||
      !ctxS3.sourceBucket?.trim() ||
      !ctxS3.destBucket?.trim() ||
      !ctxS3.sourceAccessKeyId?.trim() ||
      !ctxS3.sourceSecretAccessKey?.trim()
    ) {
      ctx.status = 400;
      ctx.body = {
        error: {
          message:
            'Region, source bucket, destination bucket, source access key ID, and source secret access key are required.',
        },
      };
      return;
    }
    try {
      const result = await strapi.plugin('strapi-media-webp-convertor').service('migration').copyS3Batch({
        ...ctxS3,
        continuationToken: body.continuationToken,
        maxKeys: body.maxKeys,
      });
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 400;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'S3 copy failed' } };
    }
  },

  async s3DeleteBatch(ctx: any) {
    const body = ctx.request.body as {
      region?: string;
      bucket?: string;
      prefix?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      continuationToken?: string;
      maxKeys?: number;
    };
    if (
      !body.region?.trim() ||
      !body.bucket?.trim() ||
      !body.accessKeyId?.trim() ||
      !body.secretAccessKey?.trim()
    ) {
      ctx.status = 400;
      ctx.body = {
        error: { message: 'Region, bucket, access key ID, and secret access key are required.' },
      };
      return;
    }
    try {
      const result = await strapi
        .plugin('strapi-media-webp-convertor')
        .service('migration')
        .deleteS3BatchByPrefix({
          region: body.region,
          bucket: body.bucket,
          prefix: body.prefix || '',
          accessKeyId: body.accessKeyId,
          secretAccessKey: body.secretAccessKey,
          continuationToken: body.continuationToken,
          maxKeys: body.maxKeys,
        });
      ctx.body = { data: result };
    } catch (e) {
      ctx.status = 400;
      ctx.body = { error: { message: e instanceof Error ? e.message : 'S3 delete failed' } };
    }
  },
});
