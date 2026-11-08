# Security

**English** · [Русский](SECURITY.ru.md)

## How to report a vulnerability

Do not open a public issue. Report it privately: the **Security** tab → **Report a vulnerability** ([direct link](https://github.com/discours/social-notifier/security/advisories/new)). Only the maintainers will see the report.

Describe what can be done and how to reproduce it. If a real token ended up in the report, give only its type and where it is stored, not the value.

## What counts as a vulnerability

- A secret ends up in a run log, an alert, a Telegram message, or the `state` branch.
- A pull request from a fork, or foreign input (post text, an API response), gets access to secrets or runs code in a workflow.
- Post text breaks the markup of a Telegram message or replaces a link.
- The config or an API response sends a request with a token to a foreign address.

## If your token leaked

Revoke it in the network that issued it, issue a new one, and update the repository secret. How to issue a token is on the network's page in [docs/sources](docs/sources). Git history and logs keep the value even after deletion, so revoking is required.
