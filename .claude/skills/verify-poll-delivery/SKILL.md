---
name: verify-poll-delivery
description: "Model-check, with TLA+, that the Google Play poller never saves a release state no target got, across cron runs, overlapping runs, KV and delivery failures. Use when changing pollEach (src/sources/shared.ts), playDiff or pollPlay (src/sources/play.ts), deliver or deliverOne (src/router.ts), or the cron handler in src/worker.ts, or when asked whether a Play release change can be missed or posted twice."
---

# Verify poll delivery

`PollDelivery.tla` models how a cron run loads the `play-state` KV value, lists each Play track, diffs it with `playDiff`, delivers the messages through the router, and saves what it saw. TLC, the TLA+ model checker, tries every order of those steps across several runs, with Google moving releases on at any moment and any message, KV read or KV write failing.

## The rules

- **NoSilentSkip.** The store only ever records a release state that some target got, that the router gave up on for good (no route, 4xx, render error), that sends no message, or that the first poll saved as its baseline. Harm if broken: a release goes into review, is rejected or goes live, and no channel ever hears about it, because every later poll finds the state already recorded.
- **NoDuplicate.** With KV working and runs not overlapping, a release state reaches the targets at most once. Harm if broken: the same "approved" or "live" post appears again in every channel.

## Run it

```sh
.claude/skills/verify-poll-delivery/check.sh            # every config, about 10 s
.claude/skills/verify-poll-delivery/check.sh NoOverlap.cfg
```

It needs Java 11 or later on `PATH`. The first run downloads `tla2tools.jar` v1.7.4 (pinned by SHA-256) into `node_modules/.cache/verify-poll-delivery/`, which also holds each config's TLC output.

Each config prints `ok` when TLC gives the result the script expects, or `CHANGED`, and the script exits 1 on any `CHANGED`. It also lists covered files that changed since the sync commit.

| Config | What it explores | Expected |
| --- | --- | --- |
| `NoOverlap.cfg` | 4 runs one after another from the first deploy on, 1 track with 2 releases, KV may fail | holds |
| `Overlap.cfg` | 2 overlapping runs after the first deploy, 2 tracks with 1 release each, KV may fail | holds |
| `OverlapFirstDeploy.cfg` | 2 overlapping runs while the store is still empty | NoSilentSkip broken: known finding 2 |
| `NoDuplicate.cfg` | 3 runs one after another, 1 track with 2 releases, KV never fails | NoDuplicate broken: known finding 1 |

## Read a result

Read every result with `/pstack:statechart` on `PollDelivery.tla` and the config. For a broken rule, it tells the shortest path to the break in plain words. For a rule that holds, it draws how a run moves between states. The raw trace is in the config's `.out` file. Each state names its action, such as `<Delivered line …>`.

When a result is `CHANGED`:

1. **A rule now breaks.** Replay the path against the real code, one step for each action, using the action-to-code table below. A test in the style of `test/play.test.ts` can drive `pollPlay` with a stubbed `fetch`, a `Map`-backed store and `createRouter` with fake targets. To replay overlapping runs, hold one run's Play `fetch` on a promise while another run finishes. If every step happens in the code, it is a bug: report it with the path in the code's words, and don't loosen the rule or the model. If a step can't happen in the code, the model is wrong: fix the model and say what was wrong.
2. **A known finding now holds.** Either the code was fixed, so update `expected()` in `check.sh` and the findings below, or the model no longer reaches that case, which needs the same scrutiny as a new break.
3. **`error`.** TLC failed to parse or run the model. Read the `.out` file.

## Keep it in step with the code

Sync commit: `857098cf10a3ae4119fddb1c6908863352adc30b`

Move it forward only after you have read the covered code at the new commit, confirmed that each action below still describes it, and run `check.sh` with the expected results.

| Code | Model |
| --- | --- |
| `src/worker.ts` `scheduled` | `CronStarts`: one cron run; `Overlap` says whether the next may start before it ends |
| `src/sources/shared.ts` `pollEach`: `store.get`, `JSON.parse`, `kept` | `StateLoads`, `StateLoadFails` |
| `src/sources/shared.ts` `pollEach`: `p.poll` throwing | `PlayListFails` |
| `src/sources/shared.ts` `pollEach`: `if (... === 'ok') kept[p.id] = next` | end of `Delivered` |
| `src/sources/shared.ts` `pollEach`: `json !== raw`, `store.put`, its `.catch` | `StateSaves`, `StateSaveFails` |
| `src/sources/play.ts` `pollPlay`, `listReleases` | the `play-state` entries, one per `Tracks` element; `PlayListed` reads `google` |
| `src/sources/play.ts` `playDiff`: baseline, `prev[key] === state`, `EVENTS` and `PUBLISHED` | `PlayListed`, `Eventful` |
| `src/router.ts` `deliver`, `deliverOne`: the `'ok'` or `'retry'` outcome | `Delivered`: each message reached a target, needs a retry, or was given up on |

Each step in the model is one stretch of code between two `await`s, because another cron run can interleave at every `await`. The one exception is `Delivered`, which covers all of `router.deliver`: its awaits between messages touch nothing that another run reads.

When your change touches covered code:

- If it changes what the code does, change the matching action first, from the code and before you look at results, then run `check.sh`. Keep the bounds unless the change makes them wrong.
- If it changes a promise on purpose, change the rule and cite the evidence (doc comment, README, test or commit message). Never change a rule just to make it hold.
- If it adds a new path to the stored state, such as another writer of `play-state` or a new early return in `pollEach`, add an action for it.

## Bounds and assumptions

- Bounds are those in the table above: up to 4 runs, 2 tracks or 2 releases per track, and the release lifecycle absent → in review → approved → live, or in review → rejected. Google can move a release at any moment. A pass covers these bounds only.
- A release that is absent, or in a state `playDiff` sends nothing for (draft, not sent for review), is one state: `"absent"`.
- The router is reduced to one outcome per message. Which targets got it, mention and silent flags, and `postJson`'s own retries are not modeled. A message that reached one target while another failed counts as reached, as `deliverOne` decides.
- KV is one register with last-writer-wins puts. Cloudflare KV's stale reads are covered by `Overlap.cfg`: a stale read looks the same as a run that loaded before another run saved.

## Not covered

- The other pollers that use `pollEach`: `play-vitals` and `play-reviews` in `pollPlay`, and the App Store Connect poller (`pollAsc`). They share the save rule, so finding 1 applies to them, but their diffs (`vitalsDiff`, `playReviewsDiff`, `phasedDiff`, `unresolvedDiff`, `ascReviewsDiff`) are not modeled. Neither is a review that the API lists only after a newer one, which the reviews' high-water mark would skip.
- Webhook sources (EAS, App Store Connect, `/ingest`), signature checks, rendering, and target-level duplicates from `postJson` retrying a request that had landed.
- Intermediate states that Google passes through between two polls. Polling can't see them, by design.
- Liveness, such as "a change is eventually posted once targets recover". Only safety rules are checked.

## Known findings at the sync commit

1. **NoDuplicate: one failing message re-posts the rest.** Runs don't overlap and KV works.
   1. Two releases on one track change before a poll: 57 is approved and 58 is rejected.
   2. `playDiff` returns two messages. `deliver` posts "approved" to Slack, Slack answers the "rejected" post with 503 twice, so `deliverOne` returns `'retry'` and `deliver` returns `'retry'`.
   3. `pollEach` doesn't save the track's `next`, so the next run diffs against the old state and posts "approved" again, and keeps doing so on every run until "rejected" gets through.

   The same holds for any `pollEach` entry with several messages, such as several new reviews or vitals issues in one poll. `deliverOne` avoids exactly this within one message, but `pollEach` saves per entry, not per message.
2. **NoSilentSkip: overlapping runs on the first deploy swallow a change.** The store has no `play-state` yet.
   1. Run B starts, loads the empty store, and waits on `tracks.releases.list`.
   2. Run A starts, loads the empty store, lists release 57 as in review, saves that as its baseline and posts nothing.
   3. Google approves 57.
   4. B's list returns approved. B has no entry either, so it also treats this as a baseline, posts nothing, and saves over A's entry.
   5. Every later run finds "approved" stored and posts nothing, so the approval is never announced.

   This needs runs that overlap, which the README's cron advice avoids, and it can only happen on the first deploy or after a track is added.
