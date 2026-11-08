# Contributing

**English** · [Русский](CONTRIBUTING.ru.md)

Thank you for wanting to help. Bugs and requests go in an issue using a template; changes go in a pull request to `main`.

## Before a pull request

```bash
npm ci
npm run typecheck && npm test
```

Green means both commands return exit code 0. CI runs the same on Node 22 and 24.

## What to know

- Node 22.18+, TypeScript runs directly. Erasable syntax only: no `enum`, `namespace`, or parameter properties; imports use the `.ts` extension.
- There are no runtime dependencies. A new one needs a justification in the pull request description.
- Logs are public. Secrets, request URLs, headers, and whole API response bodies must not reach the log, an alert, or the state.
- New selection or sending logic gets a test that fails when the logic breaks. External APIs are mocked in tests; the tests do not go to the network.
- Texts for people live in the catalog `src/i18n/` (English and Russian); code and identifiers are in English. Issues and pull requests can be written in English or Russian.

A new network follows the steps in [docs/adding-a-source.md](docs/adding-a-source.md). Detailed rules for code changes are in [AGENTS.md](AGENTS.md).

## Security

Do not describe a vulnerability in a public issue — the procedure is in [SECURITY.md](SECURITY.md).
