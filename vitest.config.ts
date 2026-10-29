import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/test/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    // Integration tests boot an embedded PostgreSQL cluster and share seeded
    // state, so test files run one at a time rather than in parallel.
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 180_000,
    reporters: ['default'],
  },
});
