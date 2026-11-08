# How to add a network

**English** · [Русский](adding-a-source.ru.md)

A network is an adapter: a file in `src/sources/` that knows the source fields in the config, the secrets it needs, and how to get the latest posts. The core of the radar — queue, grouping, alerts, state — knows nothing about networks.

Examples: [`bluesky.ts`](../src/sources/bluesky.ts) — a network without a key, [`youtube.ts`](../src/sources/youtube.ts) — a key in a header and two requests, [`x.ts`](../src/sources/x.ts) — a paid network that asks only for new posts.

## Steps

1. **Adapter** `src/sources/<network>.ts`: the source interface (`type` and its own fields) and a `SourceAdapter` object from [`adapter.ts`](../src/sources/adapter.ts):
   - `parse` validates the fields from the config. Anything that ends up in the request URL is checked with a regular expression: IDs with digits, handles by the network's syntax.
   - `fetch` returns at most `ctx.config.fetchLimit` of the latest posts through `collectPosts`. An element that is not recognized is counted, not silently dropped: if the whole response could not be parsed, that is a format error and, from the second run, an alert.
   - API errors become a `SourceError` with a kind (`auth`, `permission`, `billing`, `rate_limit`, `config`, `http`, `bad_response`): the alert uses the kind to suggest what to do.
   - Foreign items (reposts, private posts) are filtered out before `collectPosts`, otherwise they count as garbage in the response.
2. **Registry** [`src/sources/index.ts`](../src/sources/index.ts): add the source type to the `SourceConfig` union and the adapter to `ADAPTERS`. If you forget one of the two, the type check fails.
3. **Secret**, if one is needed: the name goes into `SOURCE_SECRETS` ([`src/env.ts`](../src/env.ts)) and into the adapter's `secrets`, and the line `NAME: ${{ secrets.NAME }}` goes into the `env` of the steps in `radar.yml` and `probe.yml`. A test checks all three places: the adapter's secret is in `SOURCE_SECRETS`, every secret from `SOURCE_SECRETS` is requested by at least one network, and both workflows pass exactly these secrets.
4. **Texts.** Every string a person can see — an error message, a hint for a config field, a log line — goes into the catalog, not into the adapter. Add the key to the `Texts` interface in [`src/i18n/index.ts`](../src/i18n/index.ts) and the text to both [`en.ts`](../src/i18n/en.ts) and [`ru.ts`](../src/i18n/ru.ts). The adapter throws `new SourceError(kind, (t) => t.errors.<key>)` and reports a problem in a config field with `issues.add(field, (t) => t.config.fields.<key>)`; for real examples see [`bluesky.ts`](../src/sources/bluesky.ts) and [`feed.ts`](../src/sources/feed.ts). The test `test/i18n.test.ts` fails if Cyrillic appears in code literals outside `src/i18n/ru.ts`. Code comments may stay in Russian.
5. **Page** `docs/sources/<network>.md` and its Russian copy `docs/sources/<network>.ru.md`: what you need, the cost, how to get access, a source example in a `json` block, what arrives and what does not. The `json` blocks are identical in both versions. A test checks that the network's page has a source example of its type and that it passes config validation.
6. **Tables** in the [README](../README.md#networks) and [setup.md](setup.md#2-sources) — in both languages (README.md, README.ru.md, setup.md, setup.ru.md).
7. **Tests** in [`test/sources.test.ts`](../test/sources.test.ts): a response in the shape of the live API, garbage in the response, error classification, the token not in the request URL.

## Rules

- The token goes in a header or the request body, not in the URL: a URL can end up in the log.
- No runtime dependencies: `fetch` and the Node standard library.
- Requests go through `requestJson` or `readText` from [`src/http.ts`](../src/http.ts): they have a timeout and a limit on the response size. Parse a custom text format in linear time, without regular expressions that use lazy quantifiers on foreign text: one slow response stops polling for all networks.
- Error texts go only through the `src/i18n/` catalog, in both languages, and never include whole API response bodies: the log is public.
- A paid network asks only for new posts: the adapter gets the IDs it has seen in `ctx.known`.

Check before a pull request: `npm run typecheck && npm test`.
