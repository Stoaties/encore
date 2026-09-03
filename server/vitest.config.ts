import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // all test files share one postgres database and truncate between tests
    fileParallelism: false,
  },
});
