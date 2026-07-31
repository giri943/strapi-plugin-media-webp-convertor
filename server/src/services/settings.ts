import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME, SETTINGS_STORE_KEY } from '../constants';

export type PluginSettings = {
  webpQuality: number;
  webpConversionEnabled: boolean;
  pdfValidationEnabled: boolean;
  maxPdfSizeMb: number;
  blockPdfActiveContent: boolean;
};

const DEFAULTS: PluginSettings = {
  webpQuality: 82,
  webpConversionEnabled: true,
  pdfValidationEnabled: true,
  maxPdfSizeMb: 25,
  blockPdfActiveContent: true,
};

/**
 * Accepted ranges, served to the admin panel via the settings endpoint so the form and the
 * server clamp cannot drift apart.
 */
export const SETTINGS_LIMITS = {
  minPdfSizeMb: 1,
  maxPdfSizeMb: 500,
  minWebpQuality: 1,
  maxWebpQuality: 100,
} as const;

function clampQuality(q: unknown): number {
  const n = typeof q === 'number' ? q : Number(q);
  if (Number.isNaN(n)) return DEFAULTS.webpQuality;
  return Math.min(SETTINGS_LIMITS.maxWebpQuality, Math.max(SETTINGS_LIMITS.minWebpQuality, Math.round(n)));
}

function clampPdfSize(mb: unknown): number {
  const n = typeof mb === 'number' ? mb : Number(mb);
  if (Number.isNaN(n)) return DEFAULTS.maxPdfSizeMb;
  return Math.min(SETTINGS_LIMITS.maxPdfSizeMb, Math.max(SETTINGS_LIMITS.minPdfSizeMb, Math.round(n)));
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
      maxPdfSizeMb: clampPdfSize(stored?.maxPdfSizeMb ?? configDefaults.maxPdfSizeMb ?? DEFAULTS.maxPdfSizeMb),
      blockPdfActiveContent:
        typeof stored?.blockPdfActiveContent === 'boolean'
          ? stored.blockPdfActiveContent
          : (configDefaults.blockPdfActiveContent ?? DEFAULTS.blockPdfActiveContent),
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
        maxPdfSizeMb:
          partial.maxPdfSizeMb !== undefined ? clampPdfSize(partial.maxPdfSizeMb) : current.maxPdfSizeMb,
        blockPdfActiveContent:
          partial.blockPdfActiveContent !== undefined
            ? Boolean(partial.blockPdfActiveContent)
            : current.blockPdfActiveContent,
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
