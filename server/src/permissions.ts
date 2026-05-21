import { PLUGIN_NAME } from './constants';

/** Admin RBAC action UIDs (full ids: `plugin::${PLUGIN_NAME}.${uid}`) */
export const PLUGIN_ACTIONS = {
  settingsRead: `plugin::${PLUGIN_NAME}.settings.read`,
  settingsUpdate: `plugin::${PLUGIN_NAME}.settings.update`,
  migrationPreview: `plugin::${PLUGIN_NAME}.migration.preview`,
  migrationReplaceUrls: `plugin::${PLUGIN_NAME}.migration.replace-urls`,
  /** S3 batched copy route; uid is `migration.batch-copy` (digits are not allowed in action uids). */
  migrationS3Copy: `plugin::${PLUGIN_NAME}.migration.batch-copy`,
  /** S3 batched delete route — kept separate so copy access does not imply destructive delete access. */
  migrationS3Delete: `plugin::${PLUGIN_NAME}.migration.batch-delete`,
  /** Local → S3 migration; uid uses "cloud" instead of "s3" — digits are not allowed in action uids. */
  migrationLocalS3: `plugin::${PLUGIN_NAME}.migration.local-to-cloud`,
  conversionList: `plugin::${PLUGIN_NAME}.conversion.list`,
  conversionConvert: `plugin::${PLUGIN_NAME}.conversion.convert`,
} as const;

/**
 * Payloads for `admin::permission` actionProvider (register phase only).
 * UIDs must match Strapi admin validation: lowercase, dots/hyphens, start and end with a letter.
 */
export const permissionActionDefinitions = [
  {
    uid: 'settings.read',
    displayName: 'Read upload optimization settings',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: 'media',
  },
  {
    uid: 'settings.update',
    displayName: 'Update upload optimization settings',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: 'media',
  },
  {
    uid: 'migration.preview',
    displayName: 'Preview upload URL migration',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: 'media',
  },
  {
    uid: 'migration.replace-urls',
    displayName: 'Apply upload URL migration (database)',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: 'media',
  },
  {
    uid: 'migration.batch-copy',
    displayName: 'Run batched S3 copy (ephemeral credentials)',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: 'media',
  },
  {
    uid: 'migration.batch-delete',
    displayName: 'Run batched S3 delete — permanently removes objects (ephemeral credentials)',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: 'media',
  },
  {
    uid: 'migration.local-to-cloud',
    displayName: 'Migrate local files to S3 (uploads files and rewrites DB URLs)',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: 'media',
  },
  {
    uid: 'conversion.list',
    displayName: 'List existing images for WebP conversion',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: 'media',
  },
  {
    uid: 'conversion.convert',
    displayName: 'Convert existing images to WebP (replaces files in storage)',
    pluginName: PLUGIN_NAME,
    section: 'plugins' as const,
    subCategory: 'media',
  },
];
