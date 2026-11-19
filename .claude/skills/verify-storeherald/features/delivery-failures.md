# Delivery failures and resend

When a target fails, storeherald decides whether the sender should resend. If the target is down (no reply, timeout, 429 or 5xx) and no target got the event, it answers 503 `delivery failed, please retry` so EAS or an `/ingest` caller resends. If another target got it, or the target rejected the post with another 4xx, it answers 200 and logs the failure at `error` level. A failed post is retried once before giving up.

## Sub-features

- `fail-all-down` answers 503 when the only target is down, after one retry.
- `fail-partial` answers 200 when one target is down but another got the message, and logs an error.
- `fail-rejected` answers 200 when the target rejects with 404, without retry, and logs `delivery rejected`.

## How to get to it (user POV)

- A sender posts any event while a target's webhook is down or deleted. In a run, the `probe.*` routes send to the `down` (503) and `gone` (404) targets.

## Driving it with post.ts

Preconditions:

- Baseline preconditions from the README hold, and `doctor` is all `ok`.

- **All targets down.** Run `node $S/post.ts ingest '{"type":"probe.down","title":"Down probe"}' --expect 503`. Reply `delivery failed, please retry` after about a second; two captures on `/status/503/slack/down` (the try and the retry); `wrangler.log` has `"msg":"delivery failed, asking the sender to retry"` with `"status":503`.
- **One of two down.** Run `node $S/post.ts ingest '{"type":"probe.partial","title":"Partial probe"}' --expect 200`. Captures on `/discord/dev` (200) and twice on `/status/503/slack/down`; `wrangler.log` has `"level":"error"` and `"msg":"delivery failed, not retried because another target got it"`.
- **Rejected.** Run `node $S/post.ts ingest '{"type":"probe.rejected","title":"Rejected probe"}' --expect 200`. One capture on `/status/404/discord/gone`; `wrangler.log` has `"level":"error"` and `"msg":"delivery rejected"` with `"status":404`.
- **Proof.** Keep the replies, the capture counts per path (they show the retry or its absence), and the log lines.

## Gotchas

- The retry waits for `Retry-After` (1 s by default, capped at 2 s), so expect the 503 reply after about a second.
- A timeout (no reply in 5 s) is also "down", but the capture server always answers, so this map does not drive it.
- The poller side of failures (state saved only after delivery) needs the pollers, which are not drivable locally.
