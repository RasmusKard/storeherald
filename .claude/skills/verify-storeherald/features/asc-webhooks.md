# App Store Connect webhooks

App Store Connect posts to `/asc/<app>` when an App Store version, a build upload or a TestFlight external build changes state. storeherald checks the `x-apple-signature` HMAC and posts App Review, release and TestFlight messages such as `iOS rejected: My App`. The webhook's Test button and states that mean nothing to users (such as `PREPARE_FOR_SUBMISSION`) get 200 and no message.

## Sub-features

- `asc-rejected` turns `IN_REVIEW` to `REJECTED` into `appreview.rejected` with a mention and a note that Apple gives no reason via the API.
- `asc-approved-live` turns `IN_REVIEW` to `READY_FOR_DISTRIBUTION` into two messages: `appreview.approved` and `release.live`.
- `asc-build-upload` turns a build upload `COMPLETE` or `FAILED` into `testing.build.available` or `build.processing_failed`.
- `asc-beta-review` turns TestFlight external build states into `betareview.*` and `testing.build.available`.
- `asc-ping` answers 200 to the Test ping and posts nothing.
- `asc-bad-signature` answers 401 and posts nothing.

## How to get to it (user POV)

- App Store Connect › Users and Access › Integrations › Webhooks: one webhook per app with URL `https://<host>/asc/<app>` and the config's secret. The Test button sends the ping.

## Driving it with post.ts

Preconditions:

- Baseline preconditions from the README hold, and `doctor` is all `ok`.
- The config has no `ascApi`, so messages carry no version number and nothing calls Apple.

- **Test ping.** Run `node $S/post.ts asc myapp @$F/asc-ping.json --expect 200`. No new capture; `wrangler.log` has `"msg":"ASC event ignored"` with `"type":"webhookPingCreated"`.
- **Rejected.** Run `node $S/post.ts asc myapp @$F/asc-version-rejected.json --expect 200`. Slack (with `<!subteam^S0123ABC>`), Teams (with `<at>Alex</at>`) and Discord (silent) each get `🔴 iOS rejected: My App`; the Slack body says Apple does not expose the reason.
- **Approved and live.** Run `node $S/post.ts asc myapp @$F/asc-version-approved.json --expect 200`. Six new captures: Slack, Teams and Discord each get `✅ iOS approved: My App` and `✅ iOS live on the App Store: My App`, none with a mention.
- **Build upload processed.** Run `node $S/post.ts asc myapp '{"data":{"type":"buildUploadStateUpdated","id":"verify-upload-1","attributes":{"newState":"COMPLETE"}}}' --expect 200`. Slack, Teams and Discord get `iOS build processed, available in TestFlight: My App`.
- **Bad signature.** Run `node $S/post.ts asc myapp @$F/asc-version-rejected.json --bad-signature --expect 401`. Reply `bad signature`, no new capture.
- **Proof.** Keep the `requests.jsonl` lines, the new captures and the `wrangler.log` lines, including the `ASC event ignored` line for the ping.

## Gotchas

- Do not add `ascApi` to the run config to get version numbers: it calls `api.appstoreconnect.apple.com`, and `run-config.ts` refuses it.
- Approval is only recognized coming from `IN_REVIEW`. A fixture with another `oldValue` and `READY_FOR_DISTRIBUTION` yields only `release.live`.
- The App Store Connect pollers (phased release, reviews) are not webhooks; they are not drivable locally.
