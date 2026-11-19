# Custom events via /ingest

A CI job or script posts a JSON `IngestEvent` to `/ingest`, signed with Standard Webhooks using the config's `ingest.secret`. storeherald validates it strictly and posts it like any other event, for example an `update.published` after an OTA update. Bad or stale signatures get 401, an invalid body 400 with the reason, and a body over 1 MB 413.

## Sub-features

- `ingest-post` delivers a valid event with its title, body, actor, source, fields and links.
- `ingest-bad-signature` answers 401 for a wrong key.
- `ingest-stale` answers 401 for a timestamp more than 5 minutes off.
- `ingest-invalid` answers 400 with the first problem in the body.

## How to get to it (user POV)

- Set `ingest.secret` in the config, then POST signed JSON to `https://<host>/ingest` from any HTTP client. The README's `post-event.mjs` is the documented example.

## Driving it with post.ts

Preconditions:

- Baseline preconditions from the README hold, and `doctor` is all `ok`.

- **Publish event.** Run `node $S/post.ts ingest @$F/ingest-update.json --expect 200`. Slack, Teams and Discord get `✅ OTA update published`; the Slack context line names `GitHub Actions · ci`, and the title links to the `View update` URL.
- **Wrong key.** Run `node $S/post.ts ingest @$F/ingest-update.json --bad-signature --expect 401`. Reply `bad signature`, no new capture.
- **Stale timestamp.** Run `node $S/post.ts ingest @$F/ingest-update.json --skew 600 --expect 401`. Reply `bad signature`, no new capture.
- **Invalid body.** Run `node $S/post.ts ingest '{"type":"Bad Type","title":"x"}' --expect 400`. Reply `type must look like "update.published"`, no new capture.
- **Proof.** Keep the `requests.jsonl` lines (they include the reply text), the new captures, and the `wrangler.log` `request rejected` lines with their `reason`.

## Gotchas

- `type` decides routing. A type no route matches (for example `deploy.done`) answers 200 and posts nothing; that is correct behavior, not a delivery.
- Each `post.ts ingest` call uses a new `webhook-id`, so the same body sent twice is two messages.
