import { PLUGIN_ACTIONS } from '../../permissions';

const adminAuth = ['admin::isAuthenticatedAdmin'] as const;

const requireActions = (...actions: string[]) => [
  ...adminAuth,
  { name: 'admin::hasPermissions' as const, config: { actions } },
];

export default () => ({
  type: 'admin' as const,
  routes: [
    {
      method: 'GET' as const,
      path: '/settings',
      handler: 'settings.get',
      config: { policies: requireActions(PLUGIN_ACTIONS.settingsRead) },
    },
    {
      method: 'PUT' as const,
      path: '/settings',
      handler: 'settings.update',
      config: { policies: requireActions(PLUGIN_ACTIONS.settingsUpdate) },
    },
    {
      method: 'POST' as const,
      path: '/migration/preview',
      handler: 'migration.preview',
      config: { policies: requireActions(PLUGIN_ACTIONS.migrationPreview) },
    },
    {
      method: 'POST' as const,
      path: '/migration/replace-urls',
      handler: 'migration.replaceUrls',
      config: { policies: requireActions(PLUGIN_ACTIONS.migrationReplaceUrls) },
    },
    {
      method: 'POST' as const,
      path: '/migration/s3-test-connection',
      handler: 'migration.s3TestConnection',
      config: { policies: requireActions(PLUGIN_ACTIONS.migrationS3Copy) },
    },
    {
      method: 'POST' as const,
      path: '/migration/s3-copy-batch',
      handler: 'migration.s3CopyBatch',
      config: { policies: requireActions(PLUGIN_ACTIONS.migrationS3Copy) },
    },
    {
      method: 'POST' as const,
      path: '/migration/s3-delete-batch',
      handler: 'migration.s3DeleteBatch',
      config: { policies: requireActions(PLUGIN_ACTIONS.migrationS3Delete) },
    },
    {
      method: 'GET' as const,
      path: '/conversion/stats',
      handler: 'conversion.stats',
      config: { policies: requireActions(PLUGIN_ACTIONS.conversionList) },
    },
    {
      method: 'GET' as const,
      path: '/conversion/files',
      handler: 'conversion.listFiles',
      config: { policies: requireActions(PLUGIN_ACTIONS.conversionList) },
    },
    {
      method: 'POST' as const,
      path: '/conversion/convert-batch',
      handler: 'conversion.convertBatch',
      config: { policies: requireActions(PLUGIN_ACTIONS.conversionConvert) },
    },
  ],
});
