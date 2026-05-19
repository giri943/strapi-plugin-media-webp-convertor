import { getFetchClient } from '@strapi/strapi/admin';
import { PLUGIN_ID } from '../pluginId';

/**
 * Strapi mounts plugin **admin** routes at `/{pluginName}/…` (not under `/admin/plugins/…`).
 * `getFetchClient` prepends `window.strapi.backendURL` and sends the admin JWT.
 */
const basePath = () => `/${PLUGIN_ID}`;

function shortErrorMessage(message: string): string {
  const t = message.trim();
  if (t.startsWith('<!') || t.toLowerCase().includes('<!doctype')) {
    return 'Unexpected HTML response (check API URL and authentication).';
  }
  return t.length > 280 ? `${t.slice(0, 280)}…` : t;
}

/** Strapi / axios-style error bodies: `{ error: { message } }` on `response.data`. */
function messageFromResponseData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const err = d.error;
  if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    return (err as Record<string, unknown>).message as string;
  }
  if (typeof d.message === 'string') return d.message;
  return undefined;
}

function unwrapError(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as Record<string, unknown>;
    const response = err.response as Record<string, unknown> | undefined;
    const fromBody = messageFromResponseData(response?.data);
    if (fromBody) return shortErrorMessage(fromBody);
    if (typeof err.message === 'string') return shortErrorMessage(err.message);
  }
  if (e instanceof Error && e.message) return shortErrorMessage(e.message);
  return 'Request failed';
}

export async function getSettings() {
  const { get } = getFetchClient();
  try {
    const { data } = await get(`${basePath()}/settings`);
    const body = data as { data?: { webpQuality: number; webpConversionEnabled: boolean } };
    if (!body?.data) throw new Error('Invalid settings response');
    return body.data;
  } catch (e) {
    throw new Error(unwrapError(e));
  }
}

export async function putSettings(payload: { webpQuality?: number; webpConversionEnabled?: boolean }) {
  const { put } = getFetchClient();
  try {
    const { data } = await put(`${basePath()}/settings`, payload);
    const body = data as { data?: { webpQuality: number; webpConversionEnabled: boolean } };
    if (!body?.data) throw new Error('Invalid settings response');
    return body.data;
  } catch (e) {
    throw new Error(unwrapError(e));
  }
}

export async function postMigrationPreview(oldUrlPrefix: string, newUrlPrefix: string) {
  const { post } = getFetchClient();
  try {
    const { data } = await post(`${basePath()}/migration/preview`, { oldUrlPrefix, newUrlPrefix });
    const body = data as { data?: { matchCount: number; samples: string[] } };
    if (!body?.data) throw new Error('Invalid preview response');
    return body.data;
  } catch (e) {
    throw new Error(unwrapError(e));
  }
}

export async function postMigrationReplaceUrls(oldUrlPrefix: string, newUrlPrefix: string) {
  const { post } = getFetchClient();
  try {
    const { data } = await post(`${basePath()}/migration/replace-urls`, { oldUrlPrefix, newUrlPrefix });
    const body = data as { data?: { updated: number; previewMatchCount: number } };
    if (!body?.data) throw new Error('Invalid replace response');
    return body.data;
  } catch (e) {
    throw new Error(unwrapError(e));
  }
}

export type S3TestConnectionResult = {
  ok: boolean;
  message: string;
  sourceObjectCount?: number;
  sourceObjectCountTruncated?: boolean;
};

export async function postS3TestConnection(payload: Record<string, unknown>) {
  const { post } = getFetchClient();
  try {
    const { data } = await post(`${basePath()}/migration/s3-test-connection`, payload);
    const body = data as { data?: S3TestConnectionResult };
    if (!body?.data) throw new Error('Invalid S3 test response');
    return body.data;
  } catch (e) {
    throw new Error(unwrapError(e));
  }
}

export async function postS3CopyBatch(payload: Record<string, unknown>) {
  const { post } = getFetchClient();
  try {
    const { data } = await post(`${basePath()}/migration/s3-copy-batch`, payload);
    const body = data as {
      data?: { copiedKeys: string[]; nextContinuationToken?: string; done: boolean; listed: number };
    };
    if (!body?.data) throw new Error('Invalid S3 copy response');
    return body.data;
  } catch (e) {
    throw new Error(unwrapError(e));
  }
}

export type S3DeleteBatchResult = {
  deleted: number;
  nextContinuationToken?: string;
  done: boolean;
  listed: number;
};

export async function postS3DeleteBatch(payload: Record<string, unknown>) {
  const { post } = getFetchClient();
  try {
    const { data } = await post(`${basePath()}/migration/s3-delete-batch`, payload);
    const body = data as { data?: S3DeleteBatchResult };
    if (!body?.data) throw new Error('Invalid S3 delete response');
    return body.data;
  } catch (e) {
    throw new Error(unwrapError(e));
  }
}

/* ------------------------------------------------------------------ */
/*  Conversion API                                                      */
/* ------------------------------------------------------------------ */

export type ConversionStats = {
  total: number;
  alreadyWebP: number;
  needsConversion: number;
};

export type ConversionFile = {
  id: number;
  name: string;
  url: string;
  mime: string;
  size: number;
  ext: string;
  hash: string;
  formats?: Record<string, { url: string; [key: string]: unknown }> | null;
};

export type ConversionFileList = {
  files: ConversionFile[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export type ConversionBatchResult = {
  converted: number;
  failed: number;
  errors: { id: number; name: string; error: string }[];
  /** KB of the original files that were successfully converted. */
  originalKB: number;
  /** KB of the resulting WebP files. */
  newKB: number;
  /** originalKB − newKB (can be negative if WebP is somehow larger). */
  savedKB: number;
};

export async function getConversionStats(): Promise<ConversionStats> {
  const { get } = getFetchClient();
  try {
    const { data } = await get(`${basePath()}/conversion/stats`);
    const body = data as { data?: ConversionStats };
    if (!body?.data) throw new Error('Invalid stats response');
    return body.data;
  } catch (e) {
    throw new Error(unwrapError(e));
  }
}

export async function getConversionFiles(page: number, pageSize: number): Promise<ConversionFileList> {
  const { get } = getFetchClient();
  try {
    const { data } = await get(`${basePath()}/conversion/files?page=${page}&pageSize=${pageSize}`);
    const body = data as { data?: ConversionFileList };
    if (!body?.data) throw new Error('Invalid file list response');
    return body.data;
  } catch (e) {
    throw new Error(unwrapError(e));
  }
}

export async function postConversionBatch(payload: {
  fileIds: number[];
  quality: number;
}): Promise<ConversionBatchResult> {
  const { post } = getFetchClient();
  try {
    const { data } = await post(`${basePath()}/conversion/convert-batch`, payload);
    const body = data as { data?: ConversionBatchResult };
    if (!body?.data) throw new Error('Invalid conversion response');
    return body.data;
  } catch (e) {
    throw new Error(unwrapError(e));
  }
}
