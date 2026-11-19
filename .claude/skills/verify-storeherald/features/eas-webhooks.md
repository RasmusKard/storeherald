# EAS build and submission webhooks

EAS posts to `/eas/<app>` when a build or submission finishes. storeherald checks the `expo-signature` HMAC, answers 200, and posts a message such as `iOS build failed: My App 1.4.2 (57)` with the error, profile, commit and a link to the build. A wrong signature gets 401, an unknown app 404, and a body that is not an EAS build or submission 400.

## Sub-features

- `eas-build-failed` turns an errored build into a `build.failed` message with the error text and a mention.
- `eas-build-succeeded` turns a finished build into `build.succeeded` with a Download link.
- `eas-submit-failed` turns an errored submission into `submit.failed` naming the store.
- `eas-bad-signature` answers 401 and posts nothing.
- `eas-unknown-app` answers 404 for an app not in the config.
- `eas-foreign-body` answers 400 for a signed body that is not an EAS webhook.

## How to get to it (user POV)

- `eas webhook:create --event BUILD --url https://<host>/eas/<app> --secret <secret>`, then EAS posts on each finished build.
- The same with `--event SUBMIT` for submissions.

## Driving it with post.ts

Preconditions:

- Baseline preconditions from the README hold, and `doctor` is all `ok`.
- App `myapp` has `eas.secret` set (it does in `fixtures/config.yaml`).

- **Failed build.** Send the errored iOS build. Run `node $S/post.ts eas myapp @$F/eas-build-failed.json --expect 200`. Three new captures: `/slack/releases` whose `text` starts with `<!subteam^S0123ABC> 🔴` and contains `iOS build failed: My App 1.4.2 (57)`; `/teams/releases` with the same headline and an `<at>Alex</at>` mention; `/discord/dev?...` with `flags` 4096 (silent). The Slack attachment holds `Fastlane failed (EAS_BUILD_UNKNOWN_FASTLANE_ERROR)`. `wrangler.log` has three `"msg":"delivered"` lines with `"type":"build.failed"`.
- **Succeeded build.** Run `node $S/post.ts eas myapp @$F/eas-build-succeeded.json --expect 200`. Two new captures: `/slack/releases` with `✅` and `Android build succeeded: My App 1.4.2 (58)` and no mention, and `/discord/dev?...`. No `/teams/` capture. The Slack buttons include `Download`.
- **Failed submission.** Run `node $S/post.ts eas myapp @$F/eas-submit-failed.json --expect 200`. Slack, Teams and Discord each get `Android submission to Google Play failed: My App`, Slack and Teams with a mention.
- **Bad signature.** Run `node $S/post.ts eas myapp @$F/eas-build-failed.json --bad-signature --expect 401`. Reply `bad signature`, no new capture, and `wrangler.log` has `"msg":"request rejected"` with `"status":401`.
- **Unknown app.** Run `node $S/post.ts eas nosuchapp @$F/eas-build-failed.json --expect 404`. Reply `not found`, no new capture.
- **Foreign body.** Run `node $S/post.ts eas myapp '{"id":"x"}' --expect 400`. Reply `not an EAS build or submission webhook`, no new capture.
- **Proof.** Keep `requests.jsonl`, the new `captured.jsonl` lines and the matching `wrangler.log` lines, and quote the headline of each capture.

## Gotchas

- EAS signs the raw bytes. Editing a fixture is fine, but send it with `post.ts`, which signs exactly what it sends.
- A `build.succeeded` reaches Slack only with `metadata.buildProfile` `production` (route label filter). Without it, only Discord gets it.
- A canceled build (`"status":"canceled"`) is `build.canceled`, severity info, and goes only to Discord.
- Discord's capture path carries `?wait=true&with_components=true`; match on the `/discord/` prefix.
