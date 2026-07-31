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

/** Name check as well as `instanceof`, so a duplicated bundle can't misclassify a rejection. */
export function isUploadRejectedError(error: unknown): error is UploadRejectedError {
  if (error instanceof UploadRejectedError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'UploadRejectedError'
  );
}
