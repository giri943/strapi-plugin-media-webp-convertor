import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts'],
    environment: 'node',
    // The PDF cases build multi-megabyte documents on disk; the default 5s is not enough for the
    // 70MB scan or the 40k-stream linearity check.
    testTimeout: 60_000,
  },
});
