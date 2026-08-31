import {
  DEFAULT_ALLOWED_EXTENSIONS,
  EXTENSION_RULES,
} from '../middlewares/file-type-policy';

export default {
  default: {
    webpQuality: 82,
    webpConversionEnabled: true,
    pdfValidationEnabled: true,
    maxPdfSizeMb: 25,
    blockPdfActiveContent: true,
    fileTypePolicyEnabled: true,
    allowedFileExtensions: DEFAULT_ALLOWED_EXTENSIONS,
    blockMultipleExtensions: true,
    randomizeStoredFilenames: false,
  },
  validator(config: {
    webpQuality?: number;
    webpConversionEnabled?: boolean;
    pdfValidationEnabled?: boolean;
    maxPdfSizeMb?: number;
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
    if (config.maxPdfSizeMb !== undefined) {
      const mb = Number(config.maxPdfSizeMb);
      if (Number.isNaN(mb) || mb < 1 || mb > 500) {
        throw new Error('plugin config maxPdfSizeMb must be between 1 and 500');
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
