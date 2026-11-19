---------------------------- MODULE PollDelivery ----------------------------
(* How the Google Play poller turns release states into messages across cron runs.
   Each action names the code it stands for. A step is one action only where the
   code has no `await` inside it: other cron runs can interleave at every await. *)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Tracks,      \* app.play.tracks: one pollEach entry each, `${packageName}/${track}`
  Releases,    \* releases in a track, by playDiff's key `${releaseName}|${codes}`
  MaxRuns,     \* cron runs (worker.ts scheduled) the model explores
  Overlap,     \* TRUE: a run may start before the previous one ended (README: a slow run can overlap the next)
  FirstDeploy, \* TRUE: the store starts empty. FALSE: an earlier run saved what Google shows now.
  StoreFails,  \* TRUE: KV get and put can throw
  None        \* model value: no entry for the track in the stored JSON, playDiff's `prev === undefined`

\* pollEach polls the tracks one after another, in config order: some fixed order.
TrackOrder == CHOOSE o \in [1..Cardinality(Tracks) -> Tracks] : \A i, j \in DOMAIN o : i # j => o[i] # o[j]
NTracks == Cardinality(Tracks)
Runs == 1..MaxRuns

\* releaseLifecycleState. "absent": not in tracks.releases.list (or DRAFT and the other states
\* playDiff sends nothing for), so a change to it sends nothing.
States == {"absent", "inReview", "approved", "rejected", "live"}
\* The states playDiff maps to a message: EVENTS plus RELEASE_LIFECYCLE_STATE_PUBLISHED.
Eventful == {"inReview", "approved", "rejected", "live"}
\* How Google moves a release. Acyclic, so each release changes a bounded number of times.
Moves == {<<"absent", "inReview">>, <<"inReview", "approved">>, <<"inReview", "rejected">>, <<"approved", "live">>}

Entry == [Releases -> States]
NoState == [t \in Tracks |-> None]

VARIABLES
  google,    \* what tracks.releases.list returns now
  kv,        \* the `play-state` KV value: one JSON object for every track
  pc,        \* each run's place in pollEach
  read,      \* pollEach's `state`: the KV value as this run loaded it
  kept,      \* pollEach's `kept`: what this run will save
  idx,       \* index into TrackOrder of the poll this run is on
  polled,    \* playDiff's `next` for the current poll
  msgs,      \* playDiff's `messages` for the current poll, as <<release, state>> pairs
  \* Ghosts, for the rules below. The code has no such state.
  handled,   \* [track][release]: states whose message reached a target, or that the router gave up on
  posts,     \* [track][release][state]: times a message reached a target, capped at 2
  baseline   \* [track][release]: states a first-poll baseline saved while the store had no entry for the track

locals == <<read, kept, idx, polled, msgs>>
ghosts == <<handled, posts, baseline>>
vars == <<google, kv, pc, locals, ghosts>>

Init ==
  /\ google \in [Tracks -> [Releases -> {"absent", "inReview"}]]
  /\ kv = IF FirstDeploy THEN NoState ELSE google
  /\ pc = [r \in Runs |-> "idle"]
  /\ read = [r \in Runs |-> NoState]
  /\ kept = read
  /\ idx = [r \in Runs |-> 1]
  /\ polled = [r \in Runs |-> None]
  /\ msgs = [r \in Runs |-> {}]
  /\ handled = [t \in Tracks |-> [x \in Releases |-> {}]]
  /\ posts = [t \in Tracks |-> [x \in Releases |-> [s \in States |-> 0]]]
  /\ baseline = [t \in Tracks |-> [x \in Releases |-> IF FirstDeploy THEN {} ELSE {google[t][x]}]]

\* The run returns. Its locals are dropped, so finished runs look alike to TLC.
Finish(r) ==
  /\ pc' = [pc EXCEPT ![r] = "done"]
  /\ read' = [read EXCEPT ![r] = NoState]
  /\ kept' = [kept EXCEPT ![r] = NoState]
  /\ idx' = [idx EXCEPT ![r] = 1]

\* Google moves a release on, at any time.
GoogleMovesRelease ==
  \E t \in Tracks, x \in Releases, s \in States :
    /\ <<google[t][x], s>> \in Moves
    /\ google' = [google EXCEPT ![t][x] = s]
    /\ UNCHANGED <<kv, pc, locals, ghosts>>

\* worker.ts scheduled fires a cron run. Runs start in order.
CronStarts(r) ==
  /\ pc[r] = "idle"
  /\ r > 1 => pc[r - 1] # "idle"
  /\ Overlap \/ \A q \in Runs : pc[q] \in {"idle", "done"}
  /\ pc' = [pc EXCEPT ![r] = "load"]
  /\ UNCHANGED <<google, kv, locals, ghosts>>

\* pollEach: `raw = await store.get(key)`, then `kept` starts as the loaded state.
StateLoads(r) ==
  /\ pc[r] = "load"
  /\ read' = [read EXCEPT ![r] = kv]
  /\ kept' = [kept EXCEPT ![r] = kv]
  /\ pc' = [pc EXCEPT ![r] = "poll"]
  /\ UNCHANGED <<google, kv, idx, polled, msgs, ghosts>>

\* pollEach: store.get throws, so the run logs and returns without saving.
StateLoadFails(r) ==
  /\ StoreFails
  /\ pc[r] = "load"
  /\ Finish(r)
  /\ UNCHANGED <<google, kv, polled, msgs, ghosts>>

\* pollEach: `await p.poll(state[p.id])` = listReleases, then playDiff against the loaded state.
\* playDiff: no message on the first poll (prev undefined), nor for a state equal to prev's, nor for a state without an event.
PlayListed(r) ==
  /\ pc[r] = "poll"
  /\ idx[r] <= NTracks
  /\ LET t == TrackOrder[idx[r]]
         prev == read[r][t]
     IN /\ polled' = [polled EXCEPT ![r] = google[t]]
        /\ msgs' = [msgs EXCEPT ![r] =
             IF prev = None THEN {}
             ELSE {<<x, google[t][x]>> : x \in {y \in Releases : google[t][y] \in Eventful /\ google[t][y] # prev[y]}}]
  /\ pc' = [pc EXCEPT ![r] = "deliver"]
  /\ UNCHANGED <<google, kv, read, kept, idx, ghosts>>

\* pollEach: the poll throws (Play API error, timeout). Logged; `kept` keeps the loaded entry.
PlayListFails(r) ==
  /\ pc[r] = "poll"
  /\ idx[r] <= NTracks
  /\ idx' = [idx EXCEPT ![r] = idx[r] + 1]
  /\ UNCHANGED <<google, kv, pc, read, kept, polled, msgs, ghosts>>

\* router.ts deliver: each message, one at a time, through deliverOne, which gives one of
\*   "reached": some target got it ('ok'),
\*   "retry":   no target got it and one failed transiently ('retry'),
\*   "dropped": no target got it and none would on a resend: no route, 4xx, render error ('ok').
\* deliver is 'retry' when any message was. pollEach: `if (... === 'ok') kept[p.id] = next`.
\* One step: the awaits between messages touch no state that another run reads.
Delivered(r) ==
  /\ pc[r] = "deliver"
  /\ \E out \in [msgs[r] -> {"reached", "retry", "dropped"}] :
       LET t == TrackOrder[idx[r]]
           sent(x, s) == <<x, s>> \in msgs[r] /\ out[<<x, s>>] # "retry"
           got(x, s) == <<x, s>> \in msgs[r] /\ out[<<x, s>>] = "reached"
       IN /\ handled' = [handled EXCEPT ![t] = [x \in Releases |-> handled[t][x] \cup {s \in States : sent(x, s)}]]
          /\ posts' = [posts EXCEPT ![t] = [x \in Releases |-> [s \in States |->
               IF got(x, s) /\ posts[t][x][s] < 2 THEN posts[t][x][s] + 1 ELSE posts[t][x][s]]]]
          /\ kept' = IF \E m \in msgs[r] : out[m] = "retry" THEN kept
                     ELSE [kept EXCEPT ![r][t] = polled[r]]
  /\ idx' = [idx EXCEPT ![r] = idx[r] + 1]
  /\ polled' = [polled EXCEPT ![r] = None]
  /\ msgs' = [msgs EXCEPT ![r] = {}]
  /\ pc' = [pc EXCEPT ![r] = "poll"]
  /\ UNCHANGED <<google, kv, read, baseline>>

\* pollEach: `if (json !== raw) await store.put(key, json)`: the whole object, last writer wins.
StateSaves(r) ==
  /\ pc[r] = "poll"
  /\ idx[r] > NTracks
  /\ IF kept[r] # read[r]
     THEN /\ kv' = kept[r]
          /\ baseline' = [t \in Tracks |-> [x \in Releases |->
               baseline[t][x] \cup (IF read[r][t] = None /\ kept[r][t] # None /\ kv[t] = None
                                    THEN {kept[r][t][x]} ELSE {})]]
     ELSE UNCHANGED <<kv, baseline>>
  /\ Finish(r)
  /\ UNCHANGED <<google, polled, msgs, handled, posts>>

\* pollEach: store.put rejects. Logged; the next run sends the changes again.
StateSaveFails(r) ==
  /\ StoreFails
  /\ pc[r] = "poll"
  /\ idx[r] > NTracks
  /\ kept[r] # read[r]
  /\ Finish(r)
  /\ UNCHANGED <<google, kv, polled, msgs, ghosts>>

\* Every cron run has ended. Not a deadlock.
AllRunsDone ==
  /\ \A r \in Runs : pc[r] = "done"
  /\ UNCHANGED vars

Next ==
  \/ GoogleMovesRelease
  \/ \E r \in Runs : \/ CronStarts(r) \/ StateLoads(r) \/ StateLoadFails(r) \/ PlayListed(r)
                     \/ PlayListFails(r) \/ Delivered(r) \/ StateSaves(r) \/ StateSaveFails(r)
  \/ AllRunsDone

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ kv \in [Tracks -> Entry \cup {None}]
  /\ pc \in [Runs -> {"idle", "load", "poll", "deliver", "done"}]

(* Rule 1, nothing is skipped silently. Once the store records a release state, later polls
   stay quiet about it. So the store may hold only a state that some target got, that the
   router gave up on, that has no message, or that the first poll saved as its baseline. *)
NoSilentSkip ==
  \A t \in Tracks : kv[t] # None =>
    \A x \in Releases : kv[t][x] \in handled[t][x] \cup baseline[t][x] \cup (States \ Eventful)

(* Rule 2, no repeats: a release state reaches the targets at most once. Check it with
   StoreFails = FALSE and Overlap = FALSE: a failed KV put, and overlapping runs, resend by design. *)
NoDuplicate ==
  \A t \in Tracks, x \in Releases, s \in States : posts[t][x][s] <= 1
=============================================================================
