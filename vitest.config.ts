import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The e2e suites spawn real `git` and package-manager subprocesses in temporary repositories;
    // vitest's 5s default is not enough once three files run in parallel on Windows.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The slot pool lives inside the repository, so every busy slot carries its own copy of this
    // suite. `.gitignore` hides it from git and from nobody else: a test run would collect the
    // slots too — 39 files instead of 13 — and the extra copies may belong to another branch.
    exclude: [...configDefaults.exclude, '**/.ratoon/**'],
  },
})
