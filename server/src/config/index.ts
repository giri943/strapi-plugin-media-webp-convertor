import { EXTENSION_RULES } from '../middlewares/file-type-policy';

/**
 * There is deliberately no upload size setting here.
 *
 * The size ceiling is the host project's own — `strapi::body`'s `formidable.maxFileSize`, or
 * `plugin::upload.sizeLimit` — resolved at runtime by `middlewares/upload-size.ts`. A second number
 * in the plugin could only ever contradict the first, and the usual result is a project that has
 * configured 150 MB uploads being refused at 25 MB by something it forgot was there.
 *
 * `maxSvgSizeMb` is the single exception, and it is a scanning constraint rather than a policy
 * choice: the SVG rules match against the whole decoded document.
 */
export default {
  default: {
    webpQuality: 82,
    webpConversionEnabled: true,
    pdfValidationEnabled: true,
    maxSvgSizeMb: 5,
    blockPdfActiveContent: true,
    fileTypePolicyEnabled: true,
    /**
     * Empty on purpose — the recommended set is resolved in the settings service, not here.
     *
     * Strapi merges a user's `config/plugins` block over this object with lodash `defaultsDeep`,
     * which merges arrays **by index** rather than replacing them. Listing the real defaults here
     * would mean an operator who tightens the policy to `['pdf', 'png']` silently gets every
     * default entry from index 2 onwards back — a widened allow-list that reads as narrowed in
     * their own config file. An empty array has nothing to backfill from.
     */
    allowedFileExtensions: [] as string[],
    blockMultipleExtensions: true,
    randomizeStoredFilenames: false,
  },
  validator(config: {
    webpQuality?: number;
    webpConversionEnabled?: boolean;
    pdfValidationEnabled?: boolean;
    maxSvgSizeMb?: number;
    blockPdfActiveContent?: boolean;
    fileTypePolicyEnabled?: boolean;
    allowedFileExtensions?: unknown;
    blockMultipleExtensions?: boolean;
    randomizeStoredFilenames?: boolean;
  }) {
    if (config.webpQuality !== undefined) {
      const q = Number(config.webpQuality);
      if (Number.isNaN(q) || q < 1 || q > 100) {
        throw new Error('plugin config webpQuality must be between 1 and 100');
      }
    }
    if (config.maxSvgSizeMb !== undefined) {
      const mb = Number(config.maxSvgSizeMb);
      if (Number.isNaN(mb) || mb < 1 || mb > 50) {
        throw new Error('plugin config maxSvgSizeMb must be between 1 and 50');
      }
    }
    if (config.allowedFileExtensions !== undefined) {
      if (!Array.isArray(config.allowedFileExtensions)) {
        throw new Error('plugin config allowedFileExtensions must be an array of extensions');
      }
      // Fail loudly rather than dropping the entry silently. An operator who lists `exe` here has
      // misunderstood what the setting does, and a startup error is the only way they find out.
      const unsupported = config.allowedFileExtensions
        .filter((e): e is string => typeof e === 'string')
        .map((e) => e.trim().toLowerCase().replace(/^\.+/, ''))
        .filter((e) => e.length > 0 && !Object.prototype.hasOwnProperty.call(EXTENSION_RULES, e));
      if (unsupported.length > 0) {
        throw new Error(
          `plugin config allowedFileExtensions contains types this plugin cannot validate: ${unsupported.join(', ')}. Supported: ${Object.keys(EXTENSION_RULES).sort().join(', ')}`
        );
      }
    }
  },
};
