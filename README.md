# strapi-plugin-media-webp-convertor

If your Strapi project is serving JPEGs and PNGs, you're sending more bytes than you need to. This plugin fixes that — automatically on every upload, and retroactively for everything already in your media library. It also refuses the uploads a media library shouldn't accept in the first place.

**What it does:**

- **Auto-converts uploads** — any JPEG, PNG, GIF, BMP, TIFF, or HEIC uploaded through Strapi gets converted to WebP before it hits storage. No changes to your content types or frontend needed.
- **Converts existing images** — a built-in admin UI to bulk-convert everything already in your media library, with search, filtering, per-file progress, and a storage savings report.
- **Refuses what shouldn't be stored** — a default-deny type policy: only allow-listed extensions are accepted, filenames carrying tricks like `virus.svg%00.png` or `shell.php.jpg` are rejected, and every upload's bytes must match the extension it claims. Executables, scripts and image/PHP polyglots are refused whatever they're called. Strapi does not do this on its own.
- **Validates uploads** — SVGs are scanned for script and other executable content; PDFs are checked against their magic bytes and, by default, refused if they carry JavaScript or launch actions. Rejections return a `400` with a readable reason.
- **Migration helpers** — move your local uploads to S3, rewrite URL prefixes in the database, or copy and delete S3 objects across buckets.

Everything is configurable from the admin panel, and every check can be switched off — though the
panel will tell you when you've switched off something that matters.

---

## Requirements

- Strapi **5.x**
- Node **≥ 18**
- `sharp` — already present in a standard Strapi install

---

## Upgrading from 1.0.x

This release adds upload validation that is **on by default**, so files that previously uploaded
without complaint may now be refused. Nothing silently changes your stored media — only new
uploads are affected.

Uploads that used to succeed and now fail:

| Upload | Why | To allow it again |
|---|---|---|
| A PDF containing JavaScript or a `/Launch` action | `blockPdfActiveContent` | Untick **Reject PDFs containing JavaScript or launch actions** |
| A file named `.pdf` that isn't one, or a truncated PDF | `pdfValidationEnabled` | Untick **Validate PDF uploads** |
| A PDF larger than 25 MB | `maxPdfSizeMb` | Raise the limit (up to 500) |
| An SVG containing script, event handlers, SMIL animation, or external references | SVG scanning | Not configurable — sanitise the file |
| A `.svgz` (gzipped SVG) | Cannot be scanned | Upload it uncompressed |

Two behaviour changes worth knowing:

- **SVG and PDF validation no longer respect `webpConversionEnabled`.** Previously, turning off
  conversion also turned off SVG scanning. Pausing the convertor must not reopen the door to
  scriptable uploads, so the checks now run independently.
- **Animated SVGs are refused.** SMIL elements are blocked wholesale because
  `<set attributeName="href" to="javascript:…">` is a working XSS vector.

If you need the old permissive behaviour while you audit your content, set
`pdfValidationEnabled: false` and `blockPdfActiveContent: false`. SVG scanning has no off switch by
design.

---

## Upgrading from 2.0.x

This release adds the [file type policy](#file-type-policy), **on by default**. Uploads are now
default-deny: only the types on the allow-list are accepted, and the bytes must match the extension.
Stored media is untouched — only new uploads are affected.

Uploads that used to succeed and now fail:

| Upload | Why | To allow it again |
|---|---|---|
| Any type not on the allow-list — `.exe`, `.zip`, `.txt`, `.doc`, `.xls`, `.ppt`, scripts | Extension allow-list | Tick the type in **File type policy**, if it is one the plugin can verify |
| `invoice.svg.png`, `shell.php.jpg` and other double extensions | `blockMultipleExtensions` | Untick **Reject filenames carrying more than one extension** |
| A filename containing `%00`, `..`, a path separator, or a text-direction override | Filename safety | Not configurable — rename the file |
| A file whose content is not the format its extension claims | Content agreement | Not configurable — upload the real format |
| A valid image with `<?php` appended | Polyglot detection | Not configurable — strip the payload |

Before upgrading, check which types your editors actually publish:

```sql
SELECT ext, COUNT(*) FROM files GROUP BY ext ORDER BY COUNT(*) DESC;
```

Anything in that list that is not on the allow-list will stop uploading. Enable it in the admin
panel, or leave it blocked deliberately.

Legacy Office formats are the likeliest surprise: `.doc`, `.xls` and `.ppt` cannot be enabled,
because they are OLE containers and OLE is rejected on sight. Re-save as `.docx` / `.xlsx` / `.pptx`.

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
| `fileTypePolicyEnabled` | `boolean` | `true` | Default-deny type policy: filename checks, the extension allow-list, and extension ↔ content agreement. |
| `allowedFileExtensions` | `string[]` | see below | Extensions accepted when the policy is on. Only extensions the plugin can content-verify are accepted here. |
| `blockMultipleExtensions` | `boolean` | `true` | Reject names carrying a second file extension, like `invoice.svg.png`. Requires `fileTypePolicyEnabled`. |
| `randomizeStoredFilenames` | `boolean` | `false` | Replace the stored basename with a random token, dropping the uploader's filename entirely. |

These can also be changed live from the admin panel — no restart needed. Values are stored in the Strapi plugin store, not in `.env`.

---

## File type policy

Strapi does not restrict upload types on its own. Its `plugin::upload.security` block exists but is
inert until you configure it, and even configured it trusts the extension when the content has no
detectable signature — which means a PHP file sent as `shell.php.png` with
`Content-Type: image/png` is accepted. So the plugin enforces its own default-deny policy, before
core sees the request.

Three gates, because each one alone is bypassable.

**1. Filename safety.** The name is rejected — not repaired — when it contains an encoded control
character or separator (`%00`, `%2e%2e`, `%2f`), a raw control character, a zero-width or
text-direction override, a path separator, `..`, a reserved character, a leading dot, a trailing dot
or space, a Windows device name, or no extension at all. The validated name is then written back
onto the upload, so core parses the same string that was checked.

`virus.svg%00.png` is the case worth spelling out. Multipart filenames are never URL-decoded, so
those are three literal characters, not a null byte — Strapi's own null-byte check never fires, and
`path.extname()` reports `.png`. Matching the literal form is what closes it.

**2. Extension allow-list.** Anything not enabled is refused. Enabled by default:

| Group | Extensions |
|---|---|
| Images | `jpg` `jpeg` `png` `gif` `webp` `avif` `bmp` `tif` `tiff` `heic` `heif` `svg` |
| Documents | `pdf` `docx` `xlsx` `pptx` `csv` |
| Video | `mp4` `webm` `mov` |
| Audio | `mp3` `wav` `ogg` `m4a` |

Also supported, off by default: `odt` `ods` `odp` `rtf` `txt` `m4v` `ogv` `oga` `aac` `flac`.

Legacy `.doc` / `.xls` / `.ppt` and the macro-enabled `.docm` / `.xlsm` / `.pptm` family are not
offered at all. They are OLE containers that can carry VBA macros, and the OLE container is on the
signature denylist below — allowing the extension would contradict that. Save as `.docx` / `.xlsx` /
`.pptx`.

An extension can only be enabled if the plugin knows how to content-verify it. Listing something
else in `allowedFileExtensions` fails at startup with a message naming the offender, rather than
being dropped silently.

**3. Content must match the extension.** The first 8KB are sniffed and the detected type has to be
one the extension permits, so PNG bytes under a `.jpg` name are refused. Text formats (`svg`, `csv`,
`txt`) have no signature to find, so for those the rule inverts: detecting *any* signature is itself
the mismatch, which is what catches a renamed executable or PDF.

Independently of the name, an upload is refused outright when its bytes are a Windows, Linux or
macOS executable, a Java class, an OLE container, a cabinet, an Android or WebAssembly binary, a
Windows shortcut, or a static library — and when its content starts with `#!`, `<%`, `<script`,
`<html` or `<!doctype html`, or contains `<?php` anywhere in the sniff window. The last one is the
image/PHP polyglot: a valid PNG with a webshell appended.

`application/zip` is deliberately *not* on the signature denylist, because it is the real container
of every `.docx` and `.odt`. Archives are controlled by the allow-list instead. The tradeoff is that
a plain zip renamed `.docx` is accepted; it is inert unless something extracts it.

### What a rejected upload is told

Refusals return `400` with a reason that describes **the file**, never the check. So an uploader
learns that `.sql` is not accepted, but not which extensions are — and that content did not match
its extension, but not what the content was detected as. Reflecting the allow-list or the detected
type back would hand a prober a map of the policy and a type oracle to test against.

The full detail goes to the server log instead:

```
[strapi-media-webp-convertor] "report.sql" rejected — ".sql" is not in the allow-list [avif, bmp, csv, …]
[strapi-media-webp-convertor] "image.jpg" rejected — detected "image/png", expected one of [image/jpeg]
```

Reasons are also written in prose rather than with markup. The media library renders `error.message`
through `formatMessage`, where ICU treats `<…>` as a tag and `{…}` as a placeholder — a reason
mentioning a `<script>` element used to throw `UNCLOSED_TAG` and break the upload card. Messages are
stripped of those characters on the way out, so this cannot recur.

### What this does not cover

Storing uploads outside the web root and serving them without execute permission is real and worth
doing, but it is provider and web-server configuration — your S3 bucket policy, CloudFront
behaviour, or nginx `location` block. The plugin cannot reach it. When the upload provider is
`local`, the plugin logs a reminder at startup that `public/uploads` sits inside the web root.

Content scanning is signature and pattern based, not antivirus. If you need malware detection, put
a scanner in front of the upload endpoint.

---

## What happens to each file type on upload

Every upload first passes the [file type policy](#file-type-policy) — filename checks, the extension
allow-list, and extension ↔ content agreement. What happens after that depends on the type:

| File type | What happens |
|---|---|
| JPEG, PNG, GIF, BMP, TIFF, HEIC/HEIF | Converted to lossy WebP |
| WebP | Validated via magic bytes, passed through |
| SVG | Scanned for executable content, passed through if clean |
| PDF | Validated via magic bytes (`%PDF-` header + `%%EOF` trailer) and size, passed through |
| Other allowed types (documents, video, audio) | Content verified against the extension, passed through |
| Everything else | Rejected |

Type and content validation runs **regardless of `webpConversionEnabled`** — pausing the convertor
does not reopen the door to scriptable uploads. A rejected upload returns `400` with the reason in
`error.message`, which the admin panel shows in the upload notification. The reason given to the
uploader never includes internal detail; diagnostics go to the server log instead.

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
