## What changes

<!-- What and why. If the behavior changes for Telegram readers, show what the message looks like before and after. English or Russian is fine. -->

## Checks

- [ ] `npm run typecheck && npm test` are green
- [ ] new selection or sending logic is covered by a test that fails when the logic breaks
- [ ] tokens go only in a header or the request body; request URLs and response bodies do not reach the log or an alert
- [ ] new network — follows the steps in [docs/adding-a-source.md](https://github.com/discours/social-notifier/blob/main/docs/adding-a-source.md); its secret is passed in `radar.yml` and `probe.yml`
