// changelogithub 15 keeps only feat/fix/perf in Release notes. This repository
// also lands refactor and docs commits, so widen the table here instead of
// relabelling commits to fit the generator.
export default {
  types: {
    refactor: { title: '♻️ Refactors' },
    docs: { title: '📝 Documentation' },
  },
}
