# strapi-plugin-media-webp-convertor

Strapi 5 plugin with three features:

1. **Auto WebP conversion** — every raster image uploaded through the Strapi media library is converted to WebP on the fly (configurable quality, SVG passthrough with security checks).
2. **Convert existing images** — admin UI to batch-convert images already in the media library to WebP, with search & filter, lossless mode for PNGs, storage savings report, and individual or bulk conversion.
3. **Migration tools** — admin UI to swap URL prefixes in the database and to batch-copy / batch-delete objects between S3 buckets.

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

## What gets converted (on upload)

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
| `conversion.list` | View the Convert existing tab and stats |
| `conversion.convert` | Run individual or bulk WebP conversion on existing images |
| `migration.preview` | Preview URL prefix matches before replacing |
| `migration.replace` | Apply URL prefix replacements in the database |
| `migration.s3-copy` | Run S3 batch copy |
| `migration.s3-delete` | Run S3 batch delete |

---

## Convert existing images

Access via **Settings → Media WebP & migration → Convert existing tab**.

This tab scans the media library for images that are not yet WebP (JPEG, PNG, GIF, BMP, TIFF, HEIC/HEIF) and lets you convert them individually or all at once.

### What it does per file

1. Downloads the original file from storage (HTTP fetch for S3 / CDN, filesystem read for local storage).
2. Converts to WebP using [sharp](https://sharp.pixelplumbing.com/) — lossy by default, lossless for PNGs when the option is enabled.
3. Uploads the new `.webp` file through the configured Strapi upload provider.
4. Updates the `plugin::upload.file` database record — `url`, `name`, `ext`, `mime`, `size`, and all format variant URLs (thumbnail, small, medium, large).
5. Deletes the old file from storage.

The database record is always updated **before** the old file is deleted, so a partial failure never leaves a broken record.

### How content references are updated

Strapi media fields store a **relation** (file ID), not a raw URL. When the `plugin::upload.file` record is updated, all content that references that file via a media relation field automatically serves the new WebP URL — no content edits are needed.

> **Rich-text / WYSIWYG fields** that contain hard-coded image URLs (e.g. pasted URLs in a markdown body) are not updated automatically. Use the **URL migration** tab to rewrite those prefixes after conversion.

### Stats card

Shows the current breakdown of your media library:

| Counter | Meaning |
|---|---|
| Total media files | All records in `plugin::upload.file` |
| Already WebP | Files with `mime = image/webp` |
| Need conversion | Files with a convertible MIME type (JPEG, PNG, GIF, BMP, TIFF, HEIC/HEIF) |

### Bulk convert

Click **Convert All (N)** to convert every non-WebP image in one run.

- A confirmation dialog is shown before anything starts.
- An optional **quality override** slider lets you use a different quality for this run without changing the global setting.
- Enable **Use lossless WebP for PNG files** to encode PNGs pixel-perfectly. Lossless WebP preserves every detail but produces larger files than lossy — use it when quality loss on transparency-heavy graphics is unacceptable.
- Files are collected and then converted in batches of 10. A progress bar tracks completion.
- A **storage savings report** is shown live during conversion and in the completion message — e.g. `Saved 14.2 MB · 38% smaller`.
- Click **Stop** at any time to pause between batches. Click **Convert All** again to resume — files already converted are WebP and will not appear in the next run.
- Up to 5 000 files are collected per run. For libraries larger than that, run Convert All multiple times.
- When a **search or MIME filter** is active, Convert All converts only the filtered set. The confirmation dialog describes the active filter.

### Search and filter

The **Files to convert** card includes controls to narrow the list before converting:

| Control | Behaviour |
|---|---|
| **Search by name** | Filters the list to files whose name contains the search term (case-insensitive, 400 ms debounce). Results update in place — the existing list fades while new results load. |
| **File type dropdown** | Filters to a single MIME type — JPEG, PNG, GIF, BMP, TIFF, or HEIC. Applies immediately on change. |
| **Clear filters** | Resets both filters and reloads the full list. Appears only when at least one filter is active. |

Pagination respects the active filters — Next / Prev page through the filtered set only.

### Individual convert

Each row in the file list has a **Convert** button. If conversion fails, the button changes to **Retry** and the error tooltip shows the reason.

After a successful individual conversion, the row shows the before/after size and the percentage reduction — e.g. `148 KB → 122 KB (−18%)`.

Individual conversion respects the **lossless PNG** checkbox in the bulk card.

### Provider compatibility

| Storage provider | File download method |
|---|---|
| Local (`@strapi/provider-upload-local`) | Read directly from the filesystem |
| AWS S3 / compatible (public bucket) | HTTP fetch from the file URL |
| CloudFront / CDN in front of S3 | HTTP fetch from the CDN URL |
| Private S3 bucket | ⚠ Not supported — the file URL must be publicly accessible |

---

## Migration panel

Access via **Settings → Media WebP & migration → Migration tab**.

### URL prefix replacement

Swaps the URL prefix stored in `plugin::upload.file` records (both the main `url` field and format thumbnail URLs). Use this after moving files to a new CDN or S3 bucket, or after bulk-converting existing images if any rich-text fields contain hard-coded URLs.

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
