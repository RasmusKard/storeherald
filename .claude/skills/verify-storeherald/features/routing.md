# Routing to targets

Routes in the config pick which targets get each event type, whether the post mentions someone (`mention`), whether it is silent (`silent`), and which labels it must carry. Each target gets the message in its own format: Slack blocks, a Discord embed, a Teams Adaptive Card. Several matching routes merge per target.

## Sub-features

- `route-mention` mentions on routes with `mention: true` (Slack `mention` string, Teams `<at>` entity).
- `route-silent` sends Discord posts from `silent: true` routes with `flags` 4096.
- `route-labels` delivers `build.succeeded` to Slack only for the `production` profile.
- `route-render` shows each target's payload: headline, colour or style, fields, link buttons.

## How to get to it (user POV)

- Edit `routes` and `targets` in the config (`STOREHERALD_CONFIG`), then send any event. In a run, the config is `fixtures/config.yaml`.

## Driving it with post.ts

Preconditions:

- Baseline preconditions from the README hold, and `doctor` is all `ok`.

- **Mention plus silent.** Run `node $S/post.ts eas myapp @$F/eas-build-failed.json --expect 200`. The `/slack/releases` capture's `text` starts with `<!subteam^S0123ABC>`; the `/teams/releases` capture has `msteams.entities[0].mentioned.id` `alex@acme.com`; the `/discord/dev` capture has `flags` 4096 and no `content`.
- **Label filter, production.** Run `node $S/post.ts eas myapp @$F/eas-build-succeeded.json --expect 200`. New captures on `/slack/releases` and `/discord/dev`, none on `/teams/`.
- **Label filter, other profile.** Run `node $S/post.ts eas myapp "$(jq -c '.id="verify-build-3" | .metadata.buildProfile="preview"' $F/eas-build-succeeded.json)" --expect 200`. One new capture, on `/discord/dev` only.
- **Rendering.** Inspect the failed build's captures with `jq '.body'`. Slack: attachment `color` `#a32037`, a fields section with `Profile`, `Commit`, and a `View build` button. Discord: embed `color` 10690615, `author.name` `alex`, `footer.text` `EAS`. Teams: first container `style` `attention`.
- **Proof.** Keep the captures with the targets that did and did not receive each event.

## Gotchas

- Routes are a union, not first-match: an event that matches two routes for one target posts once, with mention if either route mentions and silent only if both are silent.
- Changing routes means editing `fixtures/config.yaml` and relaunching; the config is read once per Worker isolate. Keep every target URL on `@CAPTURE@`.
