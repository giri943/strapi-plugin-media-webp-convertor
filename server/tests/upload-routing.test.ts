import { describe, expect, it, beforeEach } from 'vitest';
import { isStrapiMultipartUpload } from '../src/middlewares/upload-transform-helpers';
import { formatBytes, resolveUploadLimit, resetUploadLimitCache } from '../src/middlewares/upload-size';

/**
 * These two areas have each broken in a real project rather than here, which is why they are the
 * first things covered. The route table moved three times across Strapi 5 and the plugin silently
 * stopped converting; the size limit is read from host config whose shape is easy to get wrong.
 */

const MB = 1024 * 1024;

/** A POST carrying multipart files, which is the precondition the matcher checks first. */
function uploadCtx(path: string) {
  return { request: { method: 'POST', files: { files: {} } }, path };
}

describe('isStrapiMultipartUpload', () => {
  /**
   * Taken from @strapi/upload's own published route tables, not from observed traffic:
   *   up to 5.47.0   POST /  and  POST /unstable/stream
   *   5.48.0-5.52.0  POST /  only
   *   5.52.1+        POST /  and  POST /files  and  POST /files/:id/replace
   * One bundle has to serve all three, so all three shapes must match.
   */
  it.each([
    ['/upload', 'classic multiplexer, every 5.x'],
    ['/api/upload', 'content API, every 5.x'],
    ['/upload/unstable/stream', 'SSE upload, up to 5.47.0'],
    ['/upload/files', 'per-file upload, 5.52.1+'],
    ['/upload/files/42/replace', 'replace by numeric id, 5.52.1+'],
    ['/upload/files/abc-def-123/replace', 'replace by documentId, 5.52.1+'],
    ['/admin/upload', 'behind a proxy prefix'],
    ['/cms/api/upload', 'mounted under a base path'],
    ['/cms/upload/files', 'base path plus per-file upload'],
    ['/upload/', 'trailing slash'],
  ])('accepts %s (%s)', (path) => {
    expect(isStrapiMultipartUpload(uploadCtx(path))).toBe(true);
  });

  it.each([
    ['/upload/unstable/stream-from-urls', 'JSON body, files fetched server-side'],
    ['/upload/actions/upload-from-urls', 'JSON body, 5.52.1+'],
    ['/upload/files/42', 'GET and DELETE only'],
    ['/upload/folders', 'JSON'],
    ['/upload/actions/bulk-delete', 'JSON'],
    ['/upload/actions/bulk-update', 'JSON'],
    ['/upload/ai-metadata-jobs', 'JSON, 5.52.1+'],
    ['/upload/settings', 'GET and PUT'],
    ['/upload/configuration', 'GET and PUT'],
    ['/upload/folder-structure', 'GET'],
    ['/myupload', 'unrelated path that merely ends in upload'],
    ['/uploads/photo.png', 'static asset path'],
    ['/content-manager/collection-types/api::page.page', 'unrelated endpoint'],
  ])('ignores %s (%s)', (path) => {
    expect(isStrapiMultipartUpload(uploadCtx(path))).toBe(false);
  });

  it('ignores anything that is not a POST', () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      expect(
        isStrapiMultipartUpload({ request: { method, files: { files: {} } }, path: '/upload' })
      ).toBe(false);
    }
  });

  it('ignores a POST carrying no files', () => {
    expect(isStrapiMultipartUpload({ request: { method: 'POST' }, path: '/upload' })).toBe(false);
    expect(
      isStrapiMultipartUpload({ request: { method: 'POST', files: {} }, path: '/upload' })
    ).toBe(false);
  });

  it('survives a missing path', () => {
    expect(isStrapiMultipartUpload({ request: { method: 'POST', files: { files: {} } } })).toBe(false);
  });
});

describe('resolveUploadLimit', () => {
  beforeEach(() => resetUploadLimitCache());

  /** Only `config.get` is used, so this is the whole surface the resolver depends on. */
  function fakeStrapi(config: Record<string, unknown>) {
    return { config: { get: (key: string) => config[key] } } as never;
  }

  const DEFAULT_MIDDLEWARES = ['strapi::logger', 'strapi::body', 'strapi::public'];

  it('prefers the body middleware, which is what actually gates a multipart upload', () => {
    const r = resolveUploadLimit(
      fakeStrapi({
        middlewares: [{ name: 'strapi::body', config: { formidable: { maxFileSize: 150 * MB } } }],
        // Left at Strapi's 1GB default on purpose: it must not win.
        'plugin::upload.sizeLimit': 1_000_000_000,
      })
    );
    expect(r.bytes).toBe(150 * MB);
    expect(r.source).toContain('formidable');
  });

  it('honours sizeLimit when the body middleware says nothing', () => {
    const r = resolveUploadLimit(
      fakeStrapi({ middlewares: DEFAULT_MIDDLEWARES, 'plugin::upload.sizeLimit': 150 * MB })
    );
    expect(r.bytes).toBe(150 * MB);
  });

  it("caps Strapi's 1GB sizeLimit default at formidable's real 200MB ceiling", () => {
    const r = resolveUploadLimit(
      fakeStrapi({ middlewares: DEFAULT_MIDDLEWARES, 'plugin::upload.sizeLimit': 1_000_000_000 })
    );
    expect(r.bytes).toBe(200 * MB);
    expect(r.source).toContain('capped');
  });

  it('reads a middleware entry that resolves by path instead of name', () => {
    const r = resolveUploadLimit(
      fakeStrapi({
        middlewares: [{ resolve: './src/middlewares/body', config: { formidable: { maxFileSize: 75 * MB } } }],
      })
    );
    expect(r.bytes).toBe(75 * MB);
  });

  it('falls through a non-numeric value rather than trusting it', () => {
    const r = resolveUploadLimit(
      fakeStrapi({
        middlewares: [{ name: 'strapi::body', config: { formidable: { maxFileSize: 'lots' } } }],
        'plugin::upload.sizeLimit': 90 * MB,
      })
    );
    expect(r.bytes).toBe(90 * MB);
  });

  it('falls back to 200MB with nothing configured', () => {
    expect(resolveUploadLimit(fakeStrapi({})).bytes).toBe(200 * MB);
  });

  it('never throws when config access throws', () => {
    const hostile = { config: { get: () => { throw new Error('boom'); } } } as never;
    expect(resolveUploadLimit(hostile).bytes).toBe(200 * MB);
  });

  it('caches, because host config cannot change at runtime', () => {
    const first = resolveUploadLimit(
      fakeStrapi({ middlewares: [{ name: 'strapi::body', config: { formidable: { maxFileSize: 10 * MB } } }] })
    ).bytes;
    const second = resolveUploadLimit(fakeStrapi({ 'plugin::upload.sizeLimit': 999 * MB })).bytes;
    expect(second).toBe(first);
  });
});

describe('formatBytes', () => {
  it.each([
    [1 * MB, '1MB'],
    [150 * MB, '150MB'],
    [200 * MB, '200MB'],
    [1536 * MB, '1.5GB'],
  ])('%i -> %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
