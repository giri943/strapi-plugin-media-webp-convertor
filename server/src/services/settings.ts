import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME, SETTINGS_STORE_KEY } from '../constants';
import {
  DEFAULT_ALLOWED_EXTENSIONS,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_EXTENSION_GROUPS,
  normaliseAllowedExtensions,
} from '../middlewares/file-type-policy';

export type PluginSettings = {
  webpQuality: number;
  webpConversionEnabled: boolean;
  pdfValidationEnabled: boolean;
  /**
   * The only size setting the plugin owns. Everything else defers to the host's upload limit;
   * this exists because SVG scanning matches against the whole decoded document.
   */
  maxSvgSizeMb: number;
  blockPdfActiveContent: boolean;
  fileTypePolicyEnabled: boolean;
  allowedFileExtensions: string[];
  blockMultipleExtensions: boolean;
  randomizeStoredFilenames: boolean;
};

const DEFAULTS: PluginSettings = {
  webpQuality: 82,
  webpConversionEnabled: true,
  pdfValidationEnabled: true,
  maxSvgSizeMb: 5,
  blockPdfActiveContent: true,
  fileTypePolicyEnabled: true,
  allowedFileExtensions: [...DEFAULT_ALLOWED_EXTENSIONS],
  blockMultipleExtensions: true,
  // Off by default: it changes stored URLs and drops the uploader's filename from the media
  // library, which is a workflow decision rather than a security default. Strapi already appends
  // 10 random hex characters to every stored name, so URLs are not guessable without it.
  randomizeStoredFilenames: false,
};

/**
 * Accepted ranges, served to the admin panel via the settings endpoint so the form and the
 * server clamp cannot drift apart.
 */
export const SETTINGS_LIMITS = {
  minSvgSizeMb: 1,
  maxSvgSizeMb: 50,
  minWebpQuality: 1,
  maxWebpQuality: 100,
  /** Every extension the plugin can content-verify — the allow-list may not exceed this. */
  supportedFileExtensions: SUPPORTED_EXTENSIONS,
  /** The same set, grouped, so the admin form does not keep its own copy. */
  supportedFileExtensionGroups: SUPPORTED_EXTENSION_GROUPS,
  defaultFileExtensions: DEFAULT_ALLOWED_EXTENSIONS,
} as const;

function clampQuality(q: unknown): number {
  const n = typeof q === 'number' ? q : Number(q);
  if (Number.isNaN(n)) return DEFAULTS.webpQuality;
  return Math.min(SETTINGS_LIMITS.maxWebpQuality, Math.max(SETTINGS_LIMITS.minWebpQuality, Math.round(n)));
}

function clampSvgSize(mb: unknown): number {
  const n = typeof mb === 'number' ? mb : Number(mb);
  if (Number.isNaN(n)) return DEFAULTS.maxSvgSizeMb;
  return Math.min(SETTINGS_LIMITS.maxSvgSizeMb, Math.max(SETTINGS_LIMITS.minSvgSizeMb, Math.round(n)));
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const getStore = () => strapi.store({ type: 'plugin', name: PLUGIN_NAME, key: SETTINGS_STORE_KEY });

  async function get(): Promise<PluginSettings> {
    const stored = (await getStore().get({})) as Partial<PluginSettings> | null;
    const configDefaults = strapi.config.get(`plugin::${PLUGIN_NAME}`) as Partial<PluginSettings>;
    return {
      webpQuality: clampQuality(stored?.webpQuality ?? configDefaults.webpQuality ?? DEFAULTS.webpQuality),
      webpConversionEnabled:
        typeof stored?.webpConversionEnabled === 'boolean'
          ? stored.webpConversionEnabled
          : (configDefaults.webpConversionEnabled ?? DEFAULTS.webpConversionEnabled),
      pdfValidationEnabled:
        typeof stored?.pdfValidationEnabled === 'boolean'
          ? stored.pdfValidationEnabled
          : (configDefaults.pdfValidationEnabled ?? DEFAULTS.pdfValidationEnabled),
      maxSvgSizeMb: clampSvgSize(stored?.maxSvgSizeMb ?? configDefaults.maxSvgSizeMb ?? DEFAULTS.maxSvgSizeMb),
      blockPdfActiveContent:
        typeof stored?.blockPdfActiveContent === 'boolean'
          ? stored.blockPdfActiveContent
          : (configDefaults.blockPdfActiveContent ?? DEFAULTS.blockPdfActiveContent),
      fileTypePolicyEnabled:
        typeof stored?.fileTypePolicyEnabled === 'boolean'
          ? stored.fileTypePolicyEnabled
          : (configDefaults.fileTypePolicyEnabled ?? DEFAULTS.fileTypePolicyEnabled),
      // Normalised on the way out as well as in: settings written by an older build, or edited
      // directly in the store, must never widen the policy to a type we cannot verify.
      allowedFileExtensions: normaliseAllowedExtensions(
        stored?.allowedFileExtensions ?? configDefaults.allowedFileExtensions ?? DEFAULTS.allowedFileExtensions
      ),
      blockMultipleExtensions:
        typeof stored?.blockMultipleExtensions === 'boolean'
          ? stored.blockMultipleExtensions
          : (configDefaults.blockMultipleExtensions ?? DEFAULTS.blockMultipleExtensions),
      randomizeStoredFilenames:
        typeof stored?.randomizeStoredFilenames === 'boolean'
          ? stored.randomizeStoredFilenames
          : (configDefaults.randomizeStoredFilenames ?? DEFAULTS.randomizeStoredFilenames),
    };
  }

  return {
    get,
    async set(partial: Partial<PluginSettings>): Promise<PluginSettings> {
      const current = await get();
      const next: PluginSettings = {
        webpQuality: partial.webpQuality !== undefined ? clampQuality(partial.webpQuality) : current.webpQuality,
        webpConversionEnabled:
          partial.webpConversionEnabled !== undefined ? Boolean(partial.webpConversionEnabled) : current.webpConversionEnabled,
        pdfValidationEnabled:
          partial.pdfValidationEnabled !== undefined ? Boolean(partial.pdfValidationEnabled) : current.pdfValidationEnabled,
        maxSvgSizeMb:
          partial.maxSvgSizeMb !== undefined ? clampSvgSize(partial.maxSvgSizeMb) : current.maxSvgSizeMb,
        blockPdfActiveContent:
          partial.blockPdfActiveContent !== undefined
            ? Boolean(partial.blockPdfActiveContent)
            : current.blockPdfActiveContent,
        fileTypePolicyEnabled:
          partial.fileTypePolicyEnabled !== undefined
            ? Boolean(partial.fileTypePolicyEnabled)
            : current.fileTypePolicyEnabled,
        allowedFileExtensions:
          partial.allowedFileExtensions !== undefined
            ? normaliseAllowedExtensions(partial.allowedFileExtensions)
            : current.allowedFileExtensions,
        blockMultipleExtensions:
          partial.blockMultipleExtensions !== undefined
            ? Boolean(partial.blockMultipleExtensions)
            : current.blockMultipleExtensions,
        randomizeStoredFilenames:
          partial.randomizeStoredFilenames !== undefined
            ? Boolean(partial.randomizeStoredFilenames)
            : current.randomizeStoredFilenames,
      };
      await getStore().set({ value: next });
      return next;
    },

    async ensureDefaults(): Promise<void> {
      const existing = await getStore().get({});
      if (existing == null) {
        await getStore().set({ value: DEFAULTS });
      }
    },
  };
};
