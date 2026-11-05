import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The e2e suites spawn real `git` and package-manager subprocesses in throwaway containers;
    // vitest's 5s default is not enough once three files run in parallel on Windows.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
