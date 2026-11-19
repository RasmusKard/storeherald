# storeherald verification map

This directory is the maintained source for verifying what storeherald's users see: senders get a reply to each webhook, and chat channels get a message. Read the index, then use the matching feature file as the recipe. [`../SKILL.md`](../SKILL.md) covers launch, doctor, evidence and cleanup.

## Baseline preconditions

- A run started with `control.sh launch` and `SH_RUN` exported from its output.
- `control.sh doctor` prints only `ok` lines (a `WARN` about HEAD is fine when you changed code on purpose).
- The run uses `fixtures/config.yaml` unchanged: app `myapp` ("My App") with EAS and App Store Connect webhooks, `/ingest` enabled, targets `releases` (Slack), `dev-discord` (Discord), `teams` (Teams), `down` (always 503) and `gone` (always 404).
- In a shell: `S=.claude/skills/verify-storeherald/scripts; F=.claude/skills/verify-storeherald/fixtures`.
- Never drive an instance this run did not launch, and never point a target at a real webhook.

## Driving conventions

- Send every webhook with `node $S/post.ts`, which signs it as the real sender does. Pass `--expect <status>` so a wrong reply fails the command.
- Before an action, note the capture count: `n0=$(wc -l < "$SH_RUN/evidence/captured.jsonl")`. After it, read only the new posts: `tail -n +$((n0+1)) "$SH_RUN/evidence/captured.jsonl"` (launch creates the file empty).
- Summarize a post with `jq -c '{path, status, headline: (.body.text // .body.embeds[0].title // .body.attachments[0].content.body[0].items[0].inlines[0].text)}'`.
- Message ids include the webhook's id, so a resend of the same fixture is a new delivery, not a dedupe. Change the `id` in inline JSON when you need distinct events.

## Proof and skip reporting

- Proof is three views of one action: the reply in `requests.jsonl`, the posts in `captured.jsonl` (and which targets got none), and the Worker's log line in `wrangler.log`.
- Report the run directory, the fixture or JSON sent, and the matching evidence lines.
- Report a path you could not drive with the command you tried and why. Do not report it as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then has exactly four H2 sections in this order: `Sub-features` (short IDs, one line each), `How to get to it (user POV)` (every user entry point), `Driving it with post.ts` (starts with `Preconditions:`, then labeled bullets pairing each action with an exact command and observable result), and `Gotchas`. Keep implementation details out; name only routes, payloads, commands and observable proof.

## Features

- [EAS build and submission webhooks](./eas-webhooks.md): signed `/eas/<app>` posts become build and submission messages; bad signatures, unknown apps and foreign bodies are refused.
- [App Store Connect webhooks](./asc-webhooks.md): signed `/asc/<app>` events become App Review, release and TestFlight messages; the Test ping and unmapped states post nothing.
- [Custom events via /ingest](./ingest.md): Standard Webhooks signed events from CI, with timestamp and body validation.
- [Routing to targets](./routing.md): which targets get a message, with mentions, silent posts and label filters, and how each target's payload looks.
- [Delivery failures and resend](./delivery-failures.md): when the sender gets a 503 to resend, and when a failure is only logged.

## Not drivable locally

- Google Play polling (releases, vitals, reviews) and the App Store Connect pollers (phased release, App Store reviews, in-app purchase and event review): they run on the cron and call Google and Apple APIs, which verification must never reach. `curl "$(jq -r .workerUrl "$SH_RUN/run.json")/cdn-cgi/local/scheduled"` runs the cron handler, but with this config it polls nothing. Report these as unverified.
- `GET /health_check` is covered by `control.sh doctor`: 200 `ok` while the config loads, 500 when it doesn't (launch fails fast on that).
