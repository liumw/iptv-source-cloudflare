# Contributing

Use Node.js 24 and pnpm 11. Fork the repository, make your change on a branch, then run:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm check
pnpm test
pnpm deploy:check
```

Open a pull request describing the behavior change and relevant validation. The test suite uses isolated databases and example addresses; it does not depend on a production Cloudflare account.

Keep the project source-free. Do not submit playlists, channel datasets, actual playback URLs, private database snapshots or credentials. Use reserved example domains in test fixtures. Deployment-specific D1 identifiers and account settings belong in each user's own fork.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.
