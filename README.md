# strapi-plugin-media-webp-convertor

Strapi 5 plugin with two features:

1. **Auto WebP conversion** — every raster image uploaded through the Strapi media library is converted to WebP on the fly (configurable quality, SVG passthrough with security checks).
2. **Migration tools** — admin UI to swap URL prefixes in the database and to batch-copy / batch-delete objects between S3 buckets.

## Requirements

- Strapi **5.x**
- Node **≥ 18**

## Installation

```bash
yarn add strapi-plugin-media-webp-convertor
# or
npm install strapi-plugin-media-webp-convertor
```

Enable the plugin in `config/plugins.ts`:

```ts
export default {
  'strapi-media-webp-convertor': {
    enabled: true,
    config: {
      webpQuality: 82,           // optional — see config reference below
      webpConversionEnabled: true,
    },
  },
};
```

No changes to `config/middlewares.ts` are needed. The upload interceptor is registered automatically during the plugin bootstrap phase.

## Config reference

| Key | Type | Default | Description |
|---|---|---|---|
| `webpQuality` | `number` (1–100) | `82` | WebP encoding quality passed to [sharp](https://sharp.pixelplumbing.com/). Higher = better quality, larger file. |
| `webpConversionEnabled` | `boolean` | `true` | Master switch. When `false`, uploads are passed through unchanged. |

Both values can also be changed at runtime from the admin panel under **Settings → Media WebP & migration** and are stored in the Strapi plugin store (not in `.env`). Runtime values override the config file defaults.

## What gets converted

| File type | Behaviour |
|---|---|
| JPEG, PNG, GIF, BMP, TIFF, HEIC/HEIF | Converted to WebP, filename updated to `.webp` |
| WebP | Validated (magic bytes check), passed through unchanged |
| SVG | Security-checked for scripts / event handlers / iframes, passed through unchanged |
| Everything else | Passed through unchanged |

## Permissions

**Super Admin** automatically receives all plugin actions.

For other roles, go to **Settings → Users & Roles → Roles**, edit the role, and enable the relevant entries under **Media WebP & migration**:

| Action | What it unlocks |
|---|---|
| `settings.read` | View the quality / enabled settings |
| `settings.update` | Save settings changes |
| `migration.preview` | Preview URL prefix matches before replacing |
| `migration.replace` | Apply URL prefix replacements in the database |
| `migration.s3-copy` | Run S3 batch copy |
| `migration.s3-delete` | Run S3 batch delete |

## Migration panel

Access via **Settings → Media WebP & migration → Migration tab**.

### URL prefix replacement

Swaps the URL prefix stored in `plugin::upload.file` records (both the main `url` field and format thumbnail URLs). Use this after moving files to a new CDN or S3 bucket.

1. Enter the **old prefix** (e.g. `https://old-bucket.s3.amazonaws.com`) and **new prefix** (e.g. `https://cdn.example.com`).
2. Click **Preview** to see how many records match.
3. Click **Apply** to perform the replacement.

### S3 batch copy

Copies all objects under a source prefix to a destination bucket, in pages of 100 objects.

**Required source fields:** AWS region, bucket, key prefix, access key ID, secret access key.

**Required destination fields:** bucket name.

**Optional destination fields:** region (defaults to source region), access key ID + secret (omit both to reuse source credentials — useful for same-account copies).

Credentials are sent per-request only and are never persisted server-side.

Click **Test connection** first — this validates all four required IAM permissions and counts the objects under the prefix. The copy button is only enabled after a successful test.

#### Required IAM permissions

| Permission | Why |
|---|---|
| `s3:ListBucket` on source | List objects to copy |
| `s3:GetObject` on source | Read each object |
| `s3:ListBucket` on destination | Verify destination access |
| `s3:PutObject` on destination | Write each object |

Cross-account copies buffer each object through the server (GetObject → PutObject). Same-account copies use `CopyObject` directly.

### S3 batch delete

Deletes all objects under a given prefix in batches. A confirmation dialog is shown before any deletion starts.

Uses the same credential fields as the copy destination. You can pre-fill them from the copy destination with the **Pre-fill from copy destination** toggle.

## License

MIT
