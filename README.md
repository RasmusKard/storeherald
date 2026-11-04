# storeherald

**A Cloudflare Worker that posts an Expo app's builds, store reviews and releases to Slack, Discord and Microsoft Teams.**

Routes in the config pick which events go where:

```yaml
routes:
  - types: ["build.failed", "submit.failed", "appreview.rejected"]
    targets: [releases, teams]
    mention: true
  - types: ["*"]
    targets: [dev-discord]
    silent: true
```

The [config reference](https://rasmuskard.github.io/storeherald/interfaces/ConfigFile.html) lists every option and event type. [`config.example.yaml`](config.example.yaml) is a starting point.

When a target fails:

- If it's down (no reply, a timeout, a 429 or a 5xx) and no target got the event, the Worker replies 503. EAS resends it a few times, an `/ingest` caller should resend it, and App Store Connect needs a resend by hand (see [Limits](#limits)). The Google Play and App Store Connect pollers retry on their next poll.
- If another target got it, the sender isn't asked to resend. The failure is logged at `error` level.
- If it rejects the post with any other 4xx, such as for a deleted webhook, the sender isn't asked to resend either. The failure is logged at `error` level.
- A message can occasionally be posted twice: a post that timed out is retried even if it landed, and a resent event repeats its messages that did get through.

## Install

Needs Node 24 or later and a Cloudflare account. Deploy a release, not `main`: the [config reference](https://rasmuskard.github.io/storeherald/interfaces/ConfigFile.html) describes the latest release.

```sh
git clone https://github.com/RasmusKard/storeherald.git
cd storeherald
git checkout "$(git tag --sort=-v:refname | head -1)"
npm ci
```

To upgrade, run `git fetch --tags`, check out the newest tag the same way, then run `npm ci` and `npx wrangler deploy`. [`CHANGELOG.md`](CHANGELOG.md) lists each release's changes.

## Usage

1. Write the config: your apps, targets and routes. Start from [`config.example.yaml`](config.example.yaml) and remove the sources you don't use: every `${VAR}` must be set. Put each key inline in its own variable, since Workers [limits the size of each one](https://developers.cloudflare.com/workers/platform/limits/).
2. Set the config and every variable it references as secrets:

   ```sh
   npx wrangler secret put STOREHERALD_CONFIG < config.yaml
   npx wrangler secret put EAS_WEBHOOK_SECRET
   ```

3. If you neither use Google Play nor set `asc.appId`, remove `triggers` and `kv_namespaces` from [`wrangler.jsonc`](wrangler.jsonc). Otherwise set its cron schedule to how often to poll, at most every 2 minutes: a faster schedule can post a change twice.
4. Deploy with `npx wrangler deploy`. It prints the Worker's URL.
5. [Connect the sources](#sources).
6. Logs are JSON lines in the Worker's logs. Alert on those with `"level":"error"` and point your uptime check at `GET /health_check`, which fails when the config does.

To run it locally, put the variables in `.dev.vars` and run `npx wrangler dev`. Wrangler expands `${VAR}` in `.dev.vars` itself, so write `\${VAR}` there.

To host it yourself, run it on [celld](https://github.com/denoland/celld). celld refuses the `observability` key and needs an `id` on the KV namespace, so remove the one and add the other in `wrangler.jsonc`. It doesn't expand `${VAR}` in `.dev.vars`, so write it there unescaped.

## Sources

### EAS builds and submissions

`/eas/<app>`:

```sh
eas webhook:create --event BUILD --url https://your.host/eas/myapp --secret "$EAS_WEBHOOK_SECRET"
eas webhook:create --event SUBMIT --url https://your.host/eas/myapp --secret "$EAS_WEBHOOK_SECRET"
```

### App Store Connect

`/asc/<app>`: in App Store Connect › Users and Access › Integrations › Webhooks, create one webhook per app.

- URL: `https://your.host/asc/myapp`.
- Secret: the one in `config.yaml`.
- Events: *App Store version state changes*, *Build upload state changes* and, for TestFlight, the external build state and beta feedback triggers.

Add [`ascApi`](https://rasmuskard.github.io/storeherald/interfaces/ConfigAscApi.html) to the config to get version numbers in messages.

Phased releases, App Review results for in-app purchases and events, and App Store reviews have no webhook. With [`asc.appId`](https://rasmuskard.github.io/storeherald/interfaces/ConfigAsc.html#appid) set, the Worker polls them; App Store reviews also need [`asc.reviews`](https://rasmuskard.github.io/storeherald/interfaces/ConfigAsc.html#reviews).

### Google Play

To let the Worker poll Play:

- In a Google Cloud project, enable the *Google Play Android Developer API*.
- Create a service account in that project and download its JSON key.
- Invite it in Play Console › Users and permissions with read-only access to the app.
- For [`vitals`](https://rasmuskard.github.io/storeherald/interfaces/ConfigPlay.html#vitals) alerts, also enable the *Google Play Developer Reporting API* in that project.
- For [`reviews`](https://rasmuskard.github.io/storeherald/interfaces/ConfigPlay.html#reviews), also give it the *Reply to reviews* permission.

### Custom events

`/ingest` takes events from any CI job or script, for example after publishing an OTA update (EAS has no webhook for those).

- Set `ingest.secret` in the config. Generate one with `node -e 'console.log("whsec_"+require("crypto").randomBytes(32).toString("base64"))'`.
- Sign each request with [Standard Webhooks](https://www.standardwebhooks.com/). Its libraries do this, or see the example below.
- The JSON body is an [`IngestEvent`](https://rasmuskard.github.io/storeherald/interfaces/IngestEvent.html).
- Resend on a 503.

<details>
<summary>Posting an event from Node</summary>

```js
// post-event.mjs: node post-event.mjs '{"type":"update.published","title":"OTA update published"}'
import { createHmac, randomUUID } from 'node:crypto';
const body = process.argv[2];
const id = `msg_${randomUUID()}`, ts = String(Math.floor(Date.now() / 1000));
const key = Buffer.from(process.env.INGEST_SECRET.replace(/^whsec_/, ''), 'base64');
const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
const res = await fetch(process.env.INGEST_URL, {
  method: 'POST',
  body,
  headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` },
});
if (!res.ok) throw new Error(`ingest: ${res.status} ${await res.text()}`);
```

</details>

## Targets

[`slack`](https://rasmuskard.github.io/storeherald/interfaces/SlackTarget.html), [`discord`](https://rasmuskard.github.io/storeherald/interfaces/DiscordTarget.html) and [`teams`](https://rasmuskard.github.io/storeherald/interfaces/TeamsTarget.html), each with its options and where its webhook URL comes from.

## Limits

- Google Play rejection reasons aren't in its API. They arrive by email.
- If every target was down when an App Store Connect event arrived, resend it by hand from the webhook's delivery list in App Store Connect.

## License

[MIT](LICENSE)
