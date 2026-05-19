# strapi-plugin-media-webp-convertor

Strapi **5.x** plugin: WebP normalization on upload (tunable quality), SVG checks, `fileInfo` name sync, and admin tools for **DB URL prefix replacement** plus **batched S3 copy** (ephemeral credentials only).

## Install (local app)

```ts
// config/plugins.ts
'strapi-media-webp-convertor': {
  enabled: true,
  resolve: './src/plugins/@strapi-media-webp-convertor',
  config: { webpQuality: 82, webpConversionEnabled: true },
},
```

Upload conversion is attached in the plugin **`bootstrap`** (`strapi.server.use`), so you do **not** need to list it in `config/middlewares.ts`. It still runs after the core body parser and before API routes.

## Admin

**Settings → Media WebP & migration** (or the menu label you configure).

- **Upload optimization:** WebP quality (1–100) and enable/disable conversion (stored in plugin store, not `.env`).
- **Migration:** Preview / apply URL prefix swaps on `plugin::upload.file`; S3 batch copy with **required** source settings (source AWS region, bucket, prefix field, source access key + secret) and **required** destination bucket; **destination AWS region** is optional (defaults to the source region for `CopyObject`). **Destination** access key + secret are **optional** (omit both to copy using source credentials). Run **Test connection** before **Run copy batch** is enabled — a successful test also **counts all source objects** under the prefix (paginated) and returns the total for the admin UI. Keys are sent per request only and are **not** persisted server-side.

## Permissions

Admin API routes use `admin::hasPermissions` on top of an authenticated session. **Super Admin** receives every registered action when the admin service runs `resetSuperAdminPermissions` at startup. **Other roles** must enable the **Media WebP & migration** entries under **Settings → Users & roles → Roles** (action ids: `plugin::strapi-media-webp-convertor.*`). Actions are registered in the plugin `register` phase.

## Publish to npm

The published tarball only includes `dist/` (see `"files"` in `package.json`). The `prepublishOnly` script runs `strapi-plugin build` automatically before `npm publish`.

1. **Create an npm account** at [https://www.npmjs.com](https://www.npmjs.com) and log in locally: `npm login`.
2. **Check the package name** is free: [https://www.npmjs.com/package/strapi-plugin-media-webp-convertor](https://www.npmjs.com/package/strapi-plugin-media-webp-convertor). If taken, change `"name"` in `package.json` (e.g. `@your-org/strapi-plugin-media-webp-convertor` for a scoped package).
3. From **this plugin folder** (`src/plugins/@strapi-media-webp-convertor` or your extracted repo root for the plugin):

   ```bash
   yarn install
   yarn build
   npm publish --access public
   ```

   For a **scoped** name (`@org/...`), `--access public` is required on the free npm tier for public scoped packages.

4. **Version bumps:** after each release, bump `"version"` in `package.json` (semver), then publish again.

**Dry run / local install without publishing:** from the plugin folder run `npm pack`. That creates `strapi-plugin-media-webp-convertor-0.1.0.tgz`. In another app: `yarn add ./path/to/strapi-plugin-media-webp-convertor-0.1.0.tgz` (or `npm install ./...tgz`).

**Develop against a local folder** (no pack): in the consumer app, `yarn add file:../relative/path/to/strapi-plugin-media-webp-convertor` (path must contain the plugin `package.json`).

## Install from npm (consumer Strapi app)

```bash
yarn add strapi-plugin-media-webp-convertor
# or
npm install strapi-plugin-media-webp-convertor
```

Then enable it **without** `resolve` (Strapi loads the plugin from `node_modules`):

```ts
// config/plugins.ts
'strapi-media-webp-convertor': {
  enabled: true,
  config: { webpQuality: 82, webpConversionEnabled: true },
},
```

Keep **peer dependencies** satisfied in the host app (same major line as your Strapi version: `@strapi/strapi`, `react`, `react-dom`, `styled-components`, `@strapi/design-system`, `@strapi/icons`, etc.). The plugin also depends on `sharp` and `@aws-sdk/client-s3` transitively via its own `dependencies`; no extra host install is required for those unless you dedupe aggressively.

**Private registry:** configure `.npmrc` in the consumer (or CI) with your registry URL and token, then `yarn add strapi-plugin-media-webp-convertor` as usual.

## MIT

See `package.json`.
