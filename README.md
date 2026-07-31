# strapi-plugin-media-webp-convertor

If your Strapi project is serving JPEGs and PNGs, you're sending more bytes than you need to. This plugin fixes that — automatically on every upload, and retroactively for everything already in your media library.

**What it does:**

- **Auto-converts uploads** — any JPEG, PNG, GIF, BMP, TIFF, or HEIC uploaded through Strapi gets converted to WebP before it hits storage. No changes to your content types or frontend needed.
- **Converts existing images** — a built-in admin UI to bulk-convert everything already in your media library, with search, filtering, per-file progress, and a storage savings report.
- **Migration helpers** — move your local uploads to S3, rewrite URL prefixes in the database, or copy and delete S3 objects across buckets.

---

## Requirements

- Strapi **5.x**
- Node **≥ 18**

---

## Getting started

```bash
npm install strapi-plugin-media-webp-convertor
# or
yarn add strapi-plugin-media-webp-convertor
```

Add it to `config/plugins.ts`:

```ts
export default {
  'strapi-media-webp-convertor': {
    enabled: true,
  },
};
```

That's it. Restart Strapi and uploads will start converting automatically. To tweak the quality or toggle conversion on/off, go to **Settings → Media WebP & migration** in the admin panel.

---

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `webpQuality` | `number` (1–100) | `82` | Lossy WebP quality. 75–90 is a good range for most use cases. |
| `webpConversionEnabled` | `boolean` | `true` | Set to `false` to pause conversion without uninstalling the plugin. |
| `pdfValidationEnabled` | `boolean` | `true` | Magic-byte validation of PDF uploads. Independent of `webpConversionEnabled`. |
| `maxPdfSizeMb` | `number` (1–500) | `25` | PDF uploads above this size are rejected. |
| `blockPdfActiveContent` | `boolean` | `true` | Reject PDFs containing JavaScript or `/Launch` actions. Requires `pdfValidationEnabled`. |

These can also be changed live from the admin panel — no restart needed. Values are stored in the Strapi plugin store, not in `.env`.

---

## What happens to each file type on upload

| File type | What happens |
|---|---|
| JPEG, PNG, GIF, BMP, TIFF, HEIC/HEIF | Converted to lossy WebP |
| WebP | Validated via magic bytes, passed through |
| SVG | Scanned for executable content, passed through if clean |
| PDF | Validated via magic bytes (`%PDF-` header + `%%EOF` trailer) and size, passed through |
| Everything else | Passed through unchanged |

Validation of SVG and PDF uploads runs **regardless of `webpConversionEnabled`** — pausing the
convertor does not reopen the door to scriptable uploads. A rejected upload returns `400` with the
reason in `error.message`, which the admin panel shows in the upload notification.

### PDF validation

A file claiming to be a PDF — by mime type or `.pdf` extension — must prove it:

- the `%PDF-` signature must appear within the first 1KB (byte 0 per spec, but leading junk that real readers tolerate is allowed),
- the header version must be a real one (`1.0`–`1.7` or `2.0`),
- the `%%EOF` trailer must appear in the last 2KB, which rejects truncated and corrupt uploads,
- the file must be non-empty and within `maxPdfSizeMb`.

The reverse is checked too: a file uploaded as an image whose bytes *start* with `%PDF-` is rejected as a type mismatch, so a PDF can't slip in disguised as a `.png`. Matching is anchored at byte 0 in this direction so images that merely mention the sequence in their metadata aren't flagged.

### PDF active content

A PDF can pass every signature check and still carry `/OpenAction → /S /JavaScript`, which runs
when the document opens. With `blockPdfActiveContent` on (the default), a validated PDF is also
scanned for:

- a JavaScript action — `/S /JavaScript`
- a document-level JavaScript name tree — `/Names << /JavaScript [ … ] >>`
- a script payload — `/JS`
- a `/Launch` action, which starts an external program

Two design choices keep false positives down:

- **Only object definitions are scanned, never page content streams.** An action dictionary can
  only live in an object definition, so a document that merely *discusses* `/JavaScript` — a
  security whitepaper, say — is not flagged.
- **Constructs are matched, not keywords.** A bare `/OpenAction` is allowed, since it usually just
  sets the initial zoom; it is only the JavaScript action it may point at that is refused.
  `/URI` link actions are likewise untouched.

`/ObjStm` object streams are inflated before scanning, so PDFs from modern producers — which
compress their object definitions and would show nothing to a plain-text scan — are covered.
Decompression is bounded (per-stream, total, and stream count), so a zip-bomb PDF is refused in
milliseconds rather than allocated.

Names are `#xx`-decoded before matching, since `/S /J#61vaScript` is the same action to a viewer.
Stream boundaries are located by position in a single linear pass, which both keeps the scan O(n)
and stops a malformed `stream\r` line ending from hiding the object that follows it. Files above
64 MB are not scanned at all and are reported as inconclusive rather than loaded into memory.

**Known limits, stated plainly:**

- **Interactive PDF forms are rejected.** Acrobat forms commonly use JavaScript for field
  validation and calculations. If you need to publish one, untick the setting.
- **Encrypted PDFs cannot be scanned.** Their objects are ciphertext. Such a file is stored and a
  warning is logged saying the scan was incomplete — it is not silently treated as clean.
- **This is not malware scanning.** Keyword matching raises the bar; it does not guarantee safety,
  and a determined attacker can hide a payload behind exotic filters. For real assurance, add an
  AV scanner and serve media with `Content-Disposition: attachment` from an origin separate from
  your admin panel.

### SVG validation

An SVG is an XML document the browser executes, so a "clean-looking" image can carry script. Each
upload is scanned as raw text **and** as an entity-decoded copy — so `&#106;avascript:` is caught
alongside the literal form — and refused when it contains any of:

- `<script>`, including namespace-prefixed `<svg:script>`
- embedded content: `<iframe>`, `<object>`, `<embed>`, `<foreignObject>`, `<applet>`, `<handler>`, `<audio>`, `<video>`, `<frame>`
- SMIL animation: `<animate>`, `<animateTransform>`, `<animateMotion>`, `<set>` — these can rewrite `href` at runtime
- external resources: `<link>`, `<meta>`, `<base>`, `<?xml-stylesheet?>`, `<use>` pointing outside the document
- any `on*` event-handler attribute (matched generically, not from a fixed list)
- `javascript:` / `vbscript:` URLs, including whitespace-obfuscated `java<TAB>script:`
- `data:` URLs carrying executable content — `data:image/png;base64,…` stays allowed
- CSS `@import`, `expression()`, `-moz-binding`
- `<!ENTITY>` declarations (XXE)
- gzipped `.svgz`, which cannot be text-scanned and is therefore refused outright

Files are decoded the way a browser decodes them — UTF-8, UTF-16LE and UTF-16BE, with or without a
byte-order mark — because the same payload saved as UTF-16 would otherwise scan as gibberish and
pass. An SVG whose bytes cannot be interpreted at all is refused rather than assumed clean.

Detection is by content as well as by extension, so an SVG renamed `.txt` is still scanned. The
test is whether `<svg>` is the document's **root element**, so an HTML page or Markdown file that
merely embeds an inline SVG example is left alone.

Two consequences worth knowing:

- **Animated SVGs are refused.** SMIL elements are blocked wholesale because `<set attributeName="href" to="javascript:…">` is a working XSS vector. Use CSS animation or a video format instead.
- Validation reduces risk but is not a substitute for serving user media from a separate origin with `Content-Security-Policy` and `Content-Disposition: attachment`.

---

## Convert existing images

Go to **Settings → Media WebP & migration → Convert existing**.

This tab shows everything in your media library that isn't WebP yet and lets you convert it — one file at a time, or everything in one go.

When a file is converted, the plugin:
1. Downloads the original from storage.
2. Converts it to WebP via [sharp](https://sharp.pixelplumbing.com/).
3. Uploads the new `.webp` file through the Strapi upload provider.
4. Updates the database record — `url`, `name`, `ext`, `mime`, `size`, and all format variants (thumbnail, small, medium, large).
5. Deletes the old file from storage.

The database is updated **before** the old file is deleted, so a failed deletion never breaks a record.

Because Strapi media fields store a file relation (not a raw URL), every content item that references the file automatically gets the new WebP URL — no content edits needed.

> **Heads up:** Rich-text / WYSIWYG fields that contain hard-coded image URLs are the exception. Use the **URL migration** tab to fix those after converting.

### Bulk convert

Click **Convert All** to process your entire library in one run.

- Live **progress bar** and a **storage savings report** as it runs — e.g. *Saved 14 MB · 38% smaller*.
- **Quality override** — use a different quality for this run without touching your global setting.
- **Lossless mode for PNGs** — tick the checkbox to get pixel-perfect WebP output for PNG files. Useful for logos, icons, or anything with transparency where quality loss is not acceptable. Note that lossless WebP is typically larger than lossy.
- **Stop / resume** at any time. Files already converted won't show up in the next run.
- Converts up to 5 000 files per run in batches of 10. For very large libraries, run it a few times.

### Search and filter

You don't have to convert everything at once. Use the filters above the file list to narrow down what you're working on:

- **Search by name** — type to filter by filename. Results update as you type (400 ms debounce) without blanking out the list.
- **File type** — pick a specific MIME type (JPEG, PNG, GIF, BMP, TIFF, HEIC) from the dropdown. Applies immediately.
- **Clear filters** — resets both and shows the full list again.

Convert All always converts only what's currently visible after filtering.

### Individual convert

Each file row has a **Convert** button. After conversion it shows the before → after size with a percentage. If something goes wrong, the button turns into **Retry** and shows the error on hover.

### Storage provider support

| Provider | How files are downloaded |
|---|---|
| Local (`@strapi/provider-upload-local`) | Read from filesystem |
| AWS S3 / compatible (public bucket) | HTTP fetch from the file URL |
| CloudFront / CDN in front of S3 | HTTP fetch from the CDN URL |
| Private S3 bucket | ⚠ Not supported — the URL must be publicly reachable |

---

## Migration tools

Go to **Settings → Media WebP & migration → Migration**. The tools are organized into three tabs.

### Local to S3

If your media currently lives on disk (`public/uploads/`) and you want to switch to S3, this does the move for you.

1. Enter your S3 region, bucket, access key, secret, and the public base URL where files will be served from (e.g. `https://my-bucket.s3.ap-south-1.amazonaws.com` or your CDN).
2. Optionally tick **Preserve folder structure** to mirror your media library folders as S3 key prefixes.
3. Optionally tick **Delete local files** to remove the originals from disk after each successful upload.
4. **Test connection**, then **Start migration**.

The plugin uploads each file plus its format variants (thumbnail / small / medium / large) and rewrites the database URL. When it finishes, update `config/plugins.ts` to use the S3 upload provider and restart Strapi.

Required IAM permissions: `s3:ListBucket` + `s3:PutObject` on the destination bucket.

### URL Rewrite

If you moved your files to a new bucket or CDN, use this to rewrite the stored URL prefixes in the database without touching the files themselves.

1. Enter the old prefix (e.g. `https://old-cdn.example.com`) and the new one.
2. **Preview** to see how many records will be affected.
3. **Apply URL Replace** to run the replacement.

This updates both the main `url` field and all format variant URLs in `plugin::upload.file`.

### S3 Batch Copy

Copies all objects under a source prefix to a destination bucket, 100 at a time.

**Source (all required):** region, bucket, key prefix, access key ID, secret access key.

**Destination:** bucket name is required. Region is optional (defaults to source). Access keys are optional — leave them blank to reuse the source credentials (works for same-account copies).

Hit **Test Connection** before starting — it validates credentials, checks IAM permissions, and counts the objects to be copied. The copy button is locked until the test passes.

Required IAM permissions: `s3:ListBucket` + `s3:GetObject` on the source; `s3:ListBucket` + `s3:PutObject` on the destination.

Credentials are sent with each request and are never stored server-side.

#### Danger Zone — delete objects from a bucket

Sits at the bottom of the S3 Batch Copy tab, collapsed by default. Use it to clean up a destination prefix before retrying a copy, or to wipe a bucket prefix entirely. There's a confirmation dialog before anything is removed, and you can stop and resume mid-run. Pre-fill from the copy destination fields above with one click.

Required IAM permissions: `s3:ListBucket` + `s3:DeleteObject` on the target bucket.

---

## Permissions

Super Admin gets everything automatically. For other roles, go to **Settings → Roles**, edit the role, and enable what you need under **Media WebP & migration**:

| Action | What it unlocks |
|---|---|
| `settings.read` | View the quality and enabled settings |
| `settings.update` | Save changes to settings |
| `conversion.list` | View the Convert existing tab and stats |
| `conversion.convert` | Run individual or bulk conversion |
| `migration.preview` | Preview URL replacements |
| `migration.replace-urls` | Apply URL replacements |
| `migration.local-to-cloud` | Migrate local files to S3 |
| `migration.batch-copy` | Run S3 batch copy |
| `migration.batch-delete` | Run S3 batch delete (Danger Zone) |

---

## Known warnings

### `webpsave_buffer: no property named 'smart_deblock'`

This is a harmless warning printed by libvips when the version installed on your server is older than 8.14.5 and doesn't recognise the `smart_deblock` property. Conversions complete successfully — you can safely ignore it.

To suppress the warning, set this environment variable in your Strapi server:

```bash
VIPS_WARNING=0
```

Or update libvips to 8.14.5+ on your system.

---

## License

MIT
