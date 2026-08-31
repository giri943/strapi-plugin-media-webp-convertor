/**
 * Raised when an upload fails validation and must be refused.
 *
 * Deliberately *not* `@strapi/utils`'s `ApplicationError`: a plugin can end up installed with
 * its own nested copy of `@strapi/utils`, and core's error middleware only recognises errors
 * built from *its* copy (`error instanceof ApplicationError`). When the copies differ, a clean
 * 400 degrades into an opaque 500 with no message for the admin panel. The upload middleware
 * therefore maps this error onto the HTTP response itself.
 */
export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadRejectedError';
  }
}

/**
 * Make a rejection reason safe to render in the Strapi admin panel.
 *
 * The media library does not print `error.message` directly — it passes it through
 * `formatMessage` as an ICU template (`upload.apiError.<message>`). ICU reads `<…>` as a tag and
 * `{…}` as a placeholder, so a reason mentioning a `<script>` element made the upload card throw
 * `UNCLOSED_TAG` and take the React tree down with it. The validators word their reasons in prose,
 * and this is the backstop that keeps a future one from reintroducing the crash.
 */
export function toClientSafeMessage(message: string): string {
  return message
    .replace(/[<>{}]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Name check as well as `instanceof`, so a duplicated bundle can't misclassify a rejection. */
export function isUploadRejectedError(error: unknown): error is UploadRejectedError {
  if (error instanceof UploadRejectedError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'UploadRejectedError'
  );
}
