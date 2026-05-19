# strapi-plugin-media-webp-convertor

Strapi 5 plugin that automatically converts uploaded images to WebP, converts existing media library images in bulk, and provides S3 / URL migration helpers.

## Requirements

- Strapi **5.x**
- Node **≥ 18**

## Installation

```bash
npm install strapi-plugin-media-webp-convertor
```

Enable in `config/plugins.ts`:

```ts
export default {
  'strapi-media-webp-convertor': {
    enabled: true,
  },
};
```

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `webpQuality` | `number` (1–100) | `82` | WebP encoding quality. Higher = sharper, larger file. |
| `webpConversionEnabled` | `boolean` | `true` | Master switch. When `false`, uploads pass through unchanged. |

Both settings can also be changed live from the plugin admin panel and are stored in the Strapi plugin store.

## Upload behaviour

| File type | On upload |
|---|---|
| JPEG, PNG, GIF, BMP, TIFF, HEIC/HEIF | Converted to lossy WebP |
| WebP | Magic-bytes validated, passed through |
| SVG | Security-checked (scripts, event handlers, iframes), passed through |
| Everything else | Passed through unchanged |

## Permissions

Super Admin gets all actions automatically. For other roles, enable under **Settings → Roles → Media WebP & migration**:

| Action | Unlocks |
|---|---|
| `settings.read` | View settings |
| `settings.update` | Save settings |
| `conversion.list` | View Convert existing tab and stats |
| `conversion.convert` | Run individual or bulk conversion |
| `migration.preview` | Preview URL replacements |
| `migration.replace` | Apply URL replacements |
| `migration.s3-copy` | Run S3 batch copy |
| `migration.s3-delete` | Run S3 batch delete |

---

## Convert existing images

**Settings → Media WebP & migration → Convert existing**

Scans the media library for non-WebP images and converts them in place. The database record is updated automatically — content that uses Strapi media relation fields serves the new URL with no edits needed.

> Rich-text fields with hard-coded image URLs are not updated. Use the Migration tab's URL replacement after conversion.

### Per-file process

1. Download original from storage (HTTP fetch for S3/CDN, filesystem read for local).
2. Convert to WebP via [sharp](https://sharp.pixelplumbing.com/).
3. Upload new `.webp` through the configured Strapi upload provider.
4. Update the DB record (`url`, `name`, `ext`, `mime`, `size`, format variants).
5. Delete the old file from storage.

The record is updated before the old file is deleted — a partial failure never leaves a broken record.

### Bulk convert

- Optional **quality override** slider for the current run.
- Optional **lossless mode for PNG** — pixel-perfect output, larger file size.
- Converts in batches of 10 with a live progress bar and **storage savings report** (e.g. `Saved 14 MB · 38% smaller`).
- **Stop / resume** between batches. Converted files are already WebP and won't appear on the next run.
- Respects active **search / MIME filter** — Convert All converts only the filtered set.

### Search and filter

| Control | Behaviour |
|---|---|
| Search by name | Case-insensitive, 400 ms debounce. List fades in place — no full reload. |
| File type dropdown | Filter to JPEG / PNG / GIF / BMP / TIFF / HEIC. Applies immediately. |
| Clear filters | Resets both and reloads the full list. |

### Individual convert

Each file row has a **Convert** button. On success, shows before/after size and % reduction. On failure, shows **Retry** with the error reason.

### Provider compatibility

| Provider | Download method |
|---|---|
| Local (`@strapi/provider-upload-local`) | Filesystem read |
| AWS S3 / compatible (public bucket) | HTTP fetch |
| CloudFront / CDN in front of S3 | HTTP fetch |
| Private S3 bucket | ⚠ Not supported — URL must be publicly accessible |

---

## Migration

**Settings → Media WebP & migration → Migration**

### URL prefix replacement

Rewrites the URL prefix on every media record (main URL + format thumbnails). Updates the database only — files in storage are not moved.

1. Enter old prefix and new prefix.
2. **Preview** — see how many records match.
3. **Apply** — run the replacement.

### S3 batch copy

Copies objects from a source prefix to a destination bucket in pages of 100.

| Field | Required |
|---|---|
| Source region, bucket, prefix, access key ID, secret | Yes |
| Destination bucket | Yes |
| Destination region | No (defaults to source region) |
| Destination access key ID + secret | No (omit to reuse source credentials) |

Run **Test connection** first — the copy button stays disabled until the test passes. Credentials are never stored server-side.

Required IAM permissions: `s3:ListBucket` + `s3:GetObject` on source, `s3:ListBucket` + `s3:PutObject` on destination.

### S3 batch delete

Permanently deletes all objects under a given prefix. Requires confirmation before starting. Uses the same credential fields as the copy destination and can be pre-filled from those fields.

Required IAM permissions: `s3:ListBucket` + `s3:DeleteObject` on the target bucket.

---

## License

MIT
