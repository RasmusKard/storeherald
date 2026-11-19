---
name: verify-storeherald
description: Run storeherald (the Cloudflare Worker that turns EAS, App Store Connect and /ingest webhooks into Slack, Discord and Teams posts) locally under wrangler dev, send it signed webhooks, and capture exactly what each target would have received. Use to prove a change to sources, routing, targets or delivery-failure handling works in the real Worker, not just in unit tests.
---

# Verify storeherald

storeherald has no UI. A user's surface is HTTP: senders POST signed webhooks to `/eas/<app>`, `/asc/<app>` and `/ingest`, an uptime check calls `GET /health_check`, and the visible result is the message each Slack, Discord or Teams webhook receives. This skill runs the Worker in local workerd (`wrangler dev --local`) with every target pointed at a local capture server, then drives it with correctly signed requests.

All helpers are in `.claude/skills/verify-storeherald/scripts/`. Run them from the repo root. Abbreviate in your shell with `S=.claude/skills/verify-storeherald/scripts; F=.claude/skills/verify-storeherald/fixtures`.

## Safety rules (never break these)

- Nothing leaves this machine. Every target URL must point at the run's capture server (`http://127.0.0.1:<port>/...`). `control.sh launch` and `doctor` refuse a config whose targets point anywhere else.
- No Apple or Google API calls: the run config has no `ascApi`, `playApi`, `apps.*.play` or `asc.appId`, and `run-config.ts` refuses one that does. Do not add them.
- Never run `wrangler deploy`, `wrangler dev --remote`, `wrangler secret put`, `npm run deploy`, `wrangler login`, or any command that touches the Cloudflare account. Local `wrangler dev --local` only; launch also unsets `CLOUDFLARE_*` credentials for it and turns off wrangler telemetry.
- Never post to a real EAS, App Store Connect, Slack, Discord or Teams endpoint, even to "check". The secrets in a run are random test values generated at launch.
- Kill only what `control.sh` started (it tracks process groups). Never `pkill wrangler` or `pkill workerd`: the user may have their own dev session.

## Launch

Needs Node 24+ and `npm ci` done in the repo. No Cloudflare login is needed.

```sh
.claude/skills/verify-storeherald/scripts/control.sh launch
export SH_RUN=...   # copy the export line launch prints; every other command reads it
```

Launch creates a run directory under `$STOREHERALD_VERIFY_ROOT` (default `$TMPDIR/storeherald-verify/<timestamp>-<pid>`), then:

1. Picks free ports and random test secrets, and writes `dev.env` from `fixtures/config.yaml` with `@CAPTURE@` replaced by the capture server URL.
2. Starts `scripts/capture-server.ts` on `127.0.0.1:<capturePort>`.
3. Starts `wrangler dev --local --ip 127.0.0.1 --port <workerPort> --env-file <run>/dev.env --persist-to <run>/state`. `--env-file` means the repo's own `.dev.vars` or `.env` (which may hold real webhook URLs) is never read.
4. Waits until `GET /health_check` answers 200, which means the config loaded. A 500 there means the config failed: launch prints the log tail, cleans up and exits 1.

Ready is the `storeherald ready at http://127.0.0.1:<port>` line. Two runs can coexist: each has its own ports, state dir and capture log. `wrangler dev` hot-reloads `src/`, so an edit during a run changes the Worker under you.

## Doctor

Read-only. Run it first, and again whenever anything looks off:

```sh
.claude/skills/verify-storeherald/scripts/control.sh doctor
```

Every line must be `ok`: wrangler and capture server alive in the process groups this run started, both ports served by them (not by someone else's process), `GET /health_check` 200, the capture server logging into this run, every target in the loaded config posting to the capture server, and `HEAD` at the launched revision (a `WARN` there is fine if you meant to change code). Any `FAIL`: run cleanup and launch again rather than driving a half-working instance.

## Drive

`scripts/post.ts` signs a body the way the real sender does (read from `src/sources/`) and POSTs it:

| Source | Command | Signature |
| --- | --- | --- |
| EAS | `node $S/post.ts eas <app> <json or @file>` | `expo-signature: sha1=<hex HMAC-SHA1 of body>` |
| App Store Connect | `node $S/post.ts asc <app> <json or @file>` | `x-apple-signature: hmacsha256=<hex HMAC-SHA256 of body>` |
| Custom events | `node $S/post.ts ingest <json or @file>` | Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>` |

Flags: `--expect <status>` exits 1 on any other reply; `--bad-signature` signs with a wrong secret; `--skew <seconds>` moves the `/ingest` timestamp (more than 300 is rejected). The configured app is `myapp` ("My App"). It prints `POST <path> -> <status> <reply text>`.

Ready-made bodies are in `fixtures/` (`eas-build-failed.json`, `eas-build-succeeded.json`, `eas-submit-failed.json`, `asc-version-rejected.json`, `asc-version-approved.json`, `asc-ping.json`, `ingest-update.json`). Inline JSON works too.

Read what the targets received:

```sh
.claude/skills/verify-storeherald/scripts/control.sh captured 10 | jq -c '{path, status, headline: (.body.text // .body.embeds[0].title // .body.attachments[0].content.body[0].items[0].inlines[0].text)}'
```

The capture server's paths name the target: `/slack/releases` (Slack, id `releases`), `/discord/dev?...` (Discord, id `dev-discord`), `/teams/releases` (Teams, id `teams`). `/status/503/...` (id `down`) always answers 503 and `/status/404/...` (id `gone`) always 404. It answers Teams 202 and everything else 200, like the real hosts. Routes are those of `config.example.yaml` plus `probe.*` routes for the failure targets; `fixtures/config.yaml` has them.

The feature map in [`features/README.md`](features/README.md) has one recipe per feature. Use it.

`curl` covers the unsigned routes: `curl -s -w ' %{http_code}\n' "$(jq -r .workerUrl "$SH_RUN/run.json")/health_check"`.

## Evidence

Everything lands in `$SH_RUN/evidence/`, which cleanup keeps:

- `requests.jsonl`: each request `post.ts` sent (source, path, body, flags) and the Worker's reply status and text.
- `captured.jsonl`: each post a target received (path, status the capture answered, full JSON body). This is the side effect that proves delivery.
- `wrangler.log`: wrangler output and the Worker's own JSON log lines (`"msg":"delivered"`, `"request rejected"`, `"delivery failed, asking the sender to retry"`, ...).
- `config.yaml`: the config the run used (`${VAR}` references only, no secret values). `revision.txt`: commit and `git status` at launch.

Proof standards:

- Drive the real user path: a signed POST to the public route, exactly as EAS, Apple or a CI job would send it. Never call `src/` functions directly or add test-only routes.
- Prove the action and the result: the sender's reply (`requests.jsonl`), what each target received (`captured.jsonl`), and the Worker's log line (`wrangler.log`). A 200 alone proves nothing about delivery.
- Check the negative side too: targets a route should skip have no new line in `captured.jsonl`.
- The capture server is the only mock, and it stands where the production boundary already is (the webhook URL in the config).
- Quote the evidence lines in your report with the run directory path.

## Cleanup

```sh
.claude/skills/verify-storeherald/scripts/control.sh cleanup
```

Stops the wrangler and capture process groups this run started (TERM, then KILL after 15 s), warns if a port is still taken by someone else, deletes `state/`, `dev.env` and the pid files, and writes `STOPPED`. `evidence/` and `run.json` stay. Run it after every attempt, failed ones included; launch already cleans up after itself when it fails. Delete old run directories under `$TMPDIR/storeherald-verify/` by hand only when their evidence is no longer needed.

## What this can't verify locally

- Google Play polling and the App Store Connect pollers (phased releases, reviews): they call Google and Apple APIs, which this skill must not reach. See `features/README.md`.
- Version details from `ascApi`: the same API. Without it, ASC messages have no version number, which is the documented behavior without `ascApi`.
- Real Slack, Discord and Teams rendering. The capture shows the exact JSON each would receive; how a client draws it is not checked.
