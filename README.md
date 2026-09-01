# strapi-plugin-media-webp-convertor

Converts uploads to WebP, refuses the files a media library shouldn't accept, and migrates existing
media between local storage and S3.

- **Auto-converts uploads** — JPEG, PNG, GIF, BMP, TIFF and HEIC become WebP before they reach
  storage. No content-type or frontend changes needed.
- **Converts existing images** — bulk-convert your library from the admin panel, with search,
  per-file progress and a savings report.
- **Blocks malicious uploads** — default-deny type policy, filename checks, and content that must
  match the extension it claims. Executables, scripts and image/PHP polyglots are refused whatever
  they're named. Strapi does not do this on its own.
- **Validates SVG and PDF** — SVGs are scanned for script; PDFs for JavaScript and launch actions,
  at any file size.
- **Migration helpers** — local → S3, URL prefix rewrites, S3 bucket copy and delete.

---

## Requirements

- Strapi **5.x**
- Node **≥ 18**
- `sharp` — already present in a standard Strapi install

---

## Install

```bash
npm install strapi-plugin-media-webp-convertor
```

Enable it in `config/plugins.ts` (or `.js`):

```ts
export default {
  'strapi-media-webp-convertor': {
    enabled: true,
  },
};
```

Restart Strapi. Conversion and upload validation are on by default — nothing else is required.

Settings live under **Settings → Media WebP & migration** in the admin panel and can be changed
without a restart.

---

## Configuration

Every option is optional. Set them in `config/plugins.ts` under a `config` block to define the
startup defaults, or change them live in the admin panel.

```ts
export default {
  'strapi-media-webp-convertor': {
    enabled: true,
    config: {
      // --- WebP conversion ---
      webpConversionEnabled: true,
      webpQuality: 82,

      // --- Upload type policy ---
      fileTypePolicyEnabled: true,
      allowedFileExtensions: [],        // [] = the recommended set below
      blockMultipleExtensions: true,
      randomizeStoredFilenames: false,

      // --- Document validation ---
      pdfValidationEnabled: true,
      blockPdfActiveContent: true,
      maxSvgSizeMb: 5,
    },
  },
};
```

| Key | Type | Default | What it does |
|---|---|---|---|
| `webpConversionEnabled` | `boolean` | `true` | Convert raster uploads to WebP. `false` pauses conversion without affecting validation. |
| `webpQuality` | `number` 1–100 | `82` | Lossy WebP quality. 75–90 suits most sites. |
| `fileTypePolicyEnabled` | `boolean` | `true` | Default-deny type policy: filename checks, extension allow-list, extension ↔ content agreement. |
| `allowedFileExtensions` | `string[]` | `[]` | Extensions to accept. Empty means the recommended set. An explicit list **replaces** it. |
| `blockMultipleExtensions` | `boolean` | `true` | Reject names carrying a second extension, e.g. `invoice.svg.png`. |
| `randomizeStoredFilenames` | `boolean` | `false` | Replace the stored basename with a random token, dropping the uploader's filename. |
| `pdfValidationEnabled` | `boolean` | `true` | Magic-byte validation of PDFs. |
| `blockPdfActiveContent` | `boolean` | `true` | Reject PDFs containing JavaScript or `/Launch` actions. Needs `pdfValidationEnabled`. |
| `maxSvgSizeMb` | `number` 1–50 | `5` | Largest SVG accepted. The only size limit the plugin owns — see [Upload size](#upload-size). |

Values are validated at boot. An out-of-range number or an extension the plugin cannot
content-verify stops startup with a message naming the problem, rather than being silently ignored.

### Using environment variables

```ts
export default ({ env }) => ({
  'strapi-media-webp-convertor': {
    enabled: true,
    config: {
      webpQuality: env.int('WEBP_QUALITY', 82),
      fileTypePolicyEnabled: env.bool('UPLOAD_POLICY_ENABLED', true),
      allowedFileExtensions: env.array('UPLOAD_ALLOWED_EXTENSIONS', []),
    },
  },
});
```

### Two things worth knowing

**Admin panel settings win.** Anything saved in the panel is stored in the Strapi plugin store and
takes precedence over `config/plugins.ts`, which supplies the defaults for a fresh install. If a
config change appears to do nothing, it was already overridden in the panel.

**`allowedFileExtensions` replaces the default, it does not add to it.** Strapi merges plugin config
with lodash `defaultsDeep`, which merges arrays by index. The plugin's own default is therefore
empty, so `['pdf', 'png']` means exactly those two rather than those two plus whatever sat at index 2
onwards in a longer list.

---

## Upload size

**The plugin has no size limit of its own** (SVG aside). It uses whatever your project already
allows, so there is one number and one place to change it. It reads, in order:

1. `formidable.maxFileSize` on the `strapi::body` middleware,
2. `plugin::upload.sizeLimit`, capped at formidable's default,
3. formidable's 200 MB default.

The resolved value and its source are logged at startup and shown read-only in the admin panel. To
raise it, set it where Strapi enforces it:

```ts
// config/middlewares.ts
export default [
  // …
  {
    name: 'strapi::body',
    config: {
      formLimit: '150mb',
      jsonLimit: '150mb',
      textLimit: '150mb',
      formidable: { maxFileSize: 150 * 1024 * 1024 },
    },
  },
  // …
];
```

> Setting only `sizeLimit` in `config/plugins.ts` does **not** raise the multipart ceiling. Strapi
> reads `sizeLimit` for upload-by-URL; multipart uploads are gated by formidable inside
> `strapi::body`, which defaults to 200 MB.

Which layer rejected an upload: `413 FileTooBig` is `strapi::body`, before the plugin ran. `400`
with a readable reason is this plugin.

`maxSvgSizeMb` is the exception, and it's a scanning constraint rather than a policy choice — the SVG
rules match against the whole decoded document, so it has to be read in full.

---

## Upload security

Strapi does not restrict upload types on its own. Its `plugin::upload.security` block is inert until
configured, and even configured it trusts the extension when the content has no detectable
signature — so `shell.php.png` sent as `image/png` is accepted. This plugin enforces its own
default-deny policy before core sees the request.

**1. Filename safety.** Names are rejected, never repaired, when they contain an encoded control
character or separator (`%00`, `%2e%2e`, `%2f`), a raw control character, a zero-width or
text-direction override, a path separator, `..`, a reserved character, a leading dot, a trailing dot
or space, a Windows device name, or no extension.

`virus.svg%00.png` is worth spelling out: multipart filenames are never URL-decoded, so those are
three literal characters rather than a null byte. Strapi's own null-byte check never fires and
`path.extname()` reports `.png`, which is why matching the literal form is the fix.

**2. Extension allow-list.** Anything not enabled is refused. Enabled by default:

| Group | Extensions |
|---|---|
| Images | `jpg` `jpeg` `png` `gif` `webp` `avif` `bmp` `tif` `tiff` `heic` `heif` `svg` |
| Documents | `pdf` `docx` `xlsx` `pptx` `csv` |
| Video | `mp4` `webm` `mov` |
| Audio | `mp3` `wav` `ogg` `m4a` |

Also supported, off by default: `odt` `ods` `odp` `rtf` `txt` `m4v` `ogv` `oga` `aac` `flac`.

Legacy `.doc` / `.xls` / `.ppt` and the macro-enabled `.docm` / `.xlsm` / `.pptm` family cannot be
enabled at all: they are OLE containers that can carry VBA macros, and OLE is rejected on sight.
Save as `.docx` / `.xlsx` / `.pptx`.

**3. Content must match the extension.** The first 8KB are sniffed and the detected type must be one
the extension permits, so PNG bytes under a `.jpg` name are refused. For text formats (`svg`, `csv`,
`txt`) the rule inverts — detecting *any* signature is itself the mismatch, which catches a renamed
executable or PDF.

Regardless of the name, an upload is refused when its bytes are a Windows, Linux or macOS
executable, a Java class, an OLE container, a cabinet, an Android or WebAssembly binary, a Windows
shortcut or a static library — or when its content starts with `#!`, `<%`, `<script`, `<html` or
`<!doctype html`, or contains `<?php` anywhere in the sniff window. That last one is the image/PHP
polyglot: a valid PNG with a webshell appended.

`application/zip` is deliberately not on that list, since it is the real container of every `.docx`
and `.odt`. Archives are controlled by the allow-list instead.

### What a rejected upload is told

Refusals describe **the file**, never the check. An uploader learns that `.sql` is not accepted but
not which extensions are; that content did not match its extension but not what it was detected as.
Reflecting either back would hand a prober a map of the policy and a type oracle. Full detail goes
to the server log:

```
[strapi-media-webp-convertor] "report.sql" rejected — ".sql" is not in the allow-list [avif, bmp, csv, …]
[strapi-media-webp-convertor] "image.jpg" rejected — detected "image/png", expected one of [image/jpeg]
```

### Not covered

Storing uploads outside the web root and serving them without execute permission is worth doing but
lives in your provider and web-server config — S3 bucket policy, CloudFront behaviour, nginx
`location`. The plugin logs a reminder at startup when the provider is `local`. Content scanning is
signature and pattern based, not antivirus; for malware detection put a scanner in front of the
upload endpoint.

---

## What happens to each file type

| File type | What happens |
|---|---|
| JPEG, PNG, GIF, BMP, TIFF, HEIC/HEIF | Converted to lossy WebP |
| WebP | Magic bytes validated, passed through |
| SVG | Scanned for executable content, passed through if clean |
| PDF | Magic bytes validated, then scanned for active content at any size |
| Other allowed types | Content verified against the extension, passed through |
| Everything else | Rejected |

Validation runs **regardless of `webpConversionEnabled`** — pausing the convertor does not reopen the
door to scriptable uploads.

### PDF validation

A file claiming to be a PDF must prove it: the `%PDF-` signature in the first 1KB, a real header
version (`1.0`–`1.7` or `2.0`), a `%%EOF` trailer in the last 2KB, and non-empty. The reverse is
checked too, so a PDF cannot arrive disguised as a `.png`.

With `blockPdfActiveContent` on, a validated PDF is also scanned for a JavaScript action
(`/S /JavaScript`), a document-level JavaScript name tree, a `/JS` payload, and `/Launch`. Names are
`#xx`-decoded first, since `/S /J#61vaScript` is the same action to a viewer, and `/ObjStm` object
streams are inflated so modern compressed producers are covered. Decompression is bounded, so a
zip-bomb PDF is refused in milliseconds.

Only object definitions are scanned, never page content streams — a whitepaper that merely
*discusses* `/JavaScript` is not flagged. And constructs are matched rather than keywords, so a bare
`/OpenAction` (usually just the initial zoom) and `/URI` links are left alone.

**Every PDF is scanned, whatever its size.** The scan reads in chunks rather than buffering, so peak
memory is flat — a 70 MB PDF is checked in well under a second.

Known limits:

- **Interactive PDF forms are rejected.** Acrobat forms commonly use JavaScript for field
  validation. Untick the setting if you need to publish one.
- **Encrypted PDFs cannot be scanned.** Their objects are ciphertext, so the file is stored with a
  warning logged that the scan was incomplete — never silently treated as clean. Same for object
  streams that exceed the decompression budget. These are the only paths to an inconclusive result.
- **This is not malware scanning.**

### SVG validation

An SVG is an XML document the browser executes. Each upload is scanned as raw text **and** as an
entity-decoded copy, so `&#106;avascript:` is caught alongside the literal form, and refused when it
contains:

- `<script>`, including namespace-prefixed `<svg:script>`
- embedded content: `<iframe>`, `<object>`, `<embed>`, `<foreignObject>`, `<applet>`, `<handler>`, `<audio>`, `<video>`, `<frame>`
- SMIL animation: `<animate>`, `<animateTransform>`, `<animateMotion>`, `<set>` — these can rewrite `href` at runtime
- external resources: `<link>`, `<meta>`, `<base>`, `<?xml-stylesheet?>`, `<use>` pointing outside the document
- any `on*` event-handler attribute
- `javascript:` / `vbscript:` URLs, including whitespace-obfuscated forms
- `data:` URLs carrying executable content — `data:image/png;base64,…` stays allowed
- CSS `@import`, `expression()`, `-moz-binding`
- `<!ENTITY>` declarations (XXE)
- gzipped `.svgz`, which cannot be text-scanned

Files are decoded the way a browser decodes them (UTF-8, UTF-16LE, UTF-16BE, with or without BOM),
because the same payload saved as UTF-16 would otherwise scan as gibberish and pass. Detection is by
content as well as extension, so an SVG renamed `.txt` is still scanned — the test is whether `<svg>`
is the root element, so an HTML page embedding an inline SVG example is left alone.

**Animated SVGs are refused**, because `<set attributeName="href" to="javascript:…">` is a working
XSS vector. Use CSS animation or a video format.

---

## Convert existing images

**Settings → Media WebP & migration → Convert existing** lists everything in your library that isn't
WebP yet.

Per file, the plugin downloads the original, converts it with [sharp](https://sharp.pixelplumbing.com/),
uploads the `.webp` through your provider, updates the database record (`url`, `name`, `ext`, `mime`,
`size` and every format variant), then deletes the old file. The record is updated *before* deletion,
so a failed delete never breaks a record.

Because Strapi media fields store a relation rather than a raw URL, referencing content picks up the
new URL automatically. Rich-text fields with hard-coded URLs are the exception — use **URL Rewrite**
afterwards.

- **Convert All** processes the library with a progress bar and savings report, up to 5 000 files per
  run in batches of 10.
- **Quality override** and **lossless mode for PNGs** apply per run without touching your global setting.
- **Search and filter** by filename or MIME type. Convert All only touches what's visible.
- **Stop / resume** at any time.

| Provider | How files are downloaded |
|---|---|
| Local | Read from filesystem |
| S3 / compatible (public bucket) | HTTP fetch from the file URL |
| CloudFront / CDN over S3 | HTTP fetch from the CDN URL |
| Private S3 bucket | ⚠ Not supported — the URL must be publicly reachable |

---

## Migration tools

**Settings → Media WebP & migration → Migration.** Credentials are sent per request and never stored
server-side.

**Local to S3.** Enter region, bucket, keys and the public base URL; optionally preserve media
library folders as key prefixes, and optionally delete local files after each successful upload. Test
the connection, then start. Files and their format variants are uploaded and database URLs rewritten.
Afterwards, switch your upload provider to S3 in `config/plugins.ts` and restart.
Needs `s3:ListBucket` + `s3:PutObject`.

**URL Rewrite.** Replace stored URL prefixes in the database without touching files. Preview the
match count first. Updates the main `url` and all format variants.

**S3 Batch Copy.** Copies objects under a source prefix to a destination bucket, 100 at a time.
Destination region and keys are optional and default to the source. Test Connection validates
credentials and counts objects; the copy button stays locked until it passes.
Needs `s3:ListBucket` + `s3:GetObject` on the source, `s3:ListBucket` + `s3:PutObject` on the destination.

**Danger Zone.** Collapsed at the bottom of the copy tab — deletes objects under a bucket prefix,
with a confirmation dialog and stop/resume. Needs `s3:DeleteObject`.

---

## Permissions

Super Admin has everything. For other roles, **Settings → Roles → Media WebP & migration**:

| Action | Unlocks |
|---|---|
| `settings.read` / `settings.update` | View / save plugin settings |
| `conversion.list` / `conversion.convert` | View the Convert existing tab / run conversions |
| `migration.preview` / `migration.replace-urls` | Preview / apply URL replacements |
| `migration.local-to-cloud` | Migrate local files to S3 |
| `migration.batch-copy` / `migration.batch-delete` | S3 batch copy / delete |

---

## Upgrading

Upload validation is **on by default**, so files that previously uploaded may now be refused. Stored
media is never touched — only new uploads are affected.

Before upgrading, check what your editors actually publish:

```sql
SELECT ext, COUNT(*) FROM files GROUP BY ext ORDER BY COUNT(*) DESC;
```

Anything in that list outside the allow-list will stop uploading. Enable it in the panel, or leave it
blocked deliberately. Legacy `.doc` / `.xls` / `.ppt` are the likeliest surprise and cannot be
re-enabled.

| Now refused | Why | To allow it |
|---|---|---|
| Types outside the allow-list — `.exe`, `.zip`, `.txt`, `.doc`, scripts | Extension allow-list | Tick it in the panel, if the plugin can verify it |
| `invoice.svg.png`, `shell.php.jpg` | `blockMultipleExtensions` | Untick the setting |
| Names with `%00`, `..`, path separators, direction overrides | Filename safety | Not configurable — rename the file |
| Content that isn't the format its extension claims | Content agreement | Not configurable — upload the real format |
| A valid image with `<?php` appended | Polyglot detection | Not configurable — strip the payload |
| SVG with script, event handlers, SMIL animation or external references | SVG scanning | Not configurable — sanitise the file |
| `.svgz` | Cannot be scanned | Upload it uncompressed |
| PDF with JavaScript or `/Launch` | `blockPdfActiveContent` | Untick the setting |
| A `.pdf` that isn't one, or is truncated | `pdfValidationEnabled` | Untick the setting |

**`maxPdfSizeMb` has been removed.** The plugin inherits your project's upload limit instead. Delete
it from `config/plugins.ts` — it is ignored. PDFs up to your project's limit are now accepted *and*
fully scanned; the two changes shipped together because removing the old 25 MB cap alone would have
been unsafe while the scanner still gave up above 64 MB.

---

## Known warnings

`webpsave_buffer: no property named 'smart_deblock'` — harmless. libvips older than 8.14.5 doesn't
recognise the property. Conversions still succeed.

---

## License

MIT
