// Google Play has no webhooks for releases: poll tracks.releases.list for releaseLifecycleState.
// https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases
import type { AppConfig, Config, PlayApi } from '../config.ts';
import { errText, log } from '../log.ts';
import type { Message } from '../message.ts';
import type { Router } from '../router.ts';
import { fetchJson, signJwt, type StateEvent } from './shared.ts';

export interface PlayRelease {
  releaseName?: string;
  releaseLifecycleState?: string;
  activeArtifacts?: { versionCode?: string | number }[];
}
/** `${packageName}/${track}` -> releaseKey -> lifecycle state */
export type PlayState = Record<string, Record<string, string>>;

const EVENTS: Record<string, StateEvent> = {
  RELEASE_LIFECYCLE_STATE_IN_REVIEW: { type: 'appreview.in_review', severity: 'info', what: 'in review' },
  RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: { type: 'appreview.approved', severity: 'success', what: 'approved, not yet published' },
  RELEASE_LIFECYCLE_STATE_NOT_APPROVED: { type: 'appreview.rejected', severity: 'error', what: 'rejected' },
};

/**
 * Compare one track's releases with what we saw last time. `prev === undefined` (first poll of this track) records a
 * baseline and notifies nothing, so existing releases don't flood the channels.
 */
export function playDiff(prev: Record<string, string> | undefined, releases: PlayRelease[], app: AppConfig, track: string) {
  const next: Record<string, string> = {};
  const messages: Message[] = [];
  for (const r of releases) {
    const state = r.releaseLifecycleState;
    if (!state) continue;
    const codes = (r.activeArtifacts ?? []).map((a) => String(a.versionCode)).join(',');
    const key = `${r.releaseName ?? ''}|${codes}`;
    next[key] = state;
    if (!prev || prev[key] === state) continue;

    const ev: StateEvent | undefined =
      state === 'RELEASE_LIFECYCLE_STATE_PUBLISHED'
        ? track === 'production'
          ? { type: 'release.live', severity: 'success', what: 'live on Google Play' }
          : { type: 'testing.build.available', severity: 'success', what: `available on the ${track} track` }
        : EVENTS[state];
    if (!ev) continue; // DRAFT, NOT_SENT_FOR_REVIEW, UNSPECIFIED
    const pkg = app.play!.packageName;
    messages.push({
      id: `play:${pkg}:${track}:${key}:${state}`,
      type: ev.type,
      source: 'Google Play',
      severity: ev.severity,
      title: `Android ${ev.what}: ${app.name} ${r.releaseName ?? codes}`.trim(),
      body: ev.type === 'appreview.rejected' ? 'Google sends the reason by email and in the Play Console inbox.' : undefined,
      fields: [{ label: 'Track', value: track }, ...(codes ? [{ label: 'Version code', value: codes }] : [])],
      links: [{ label: 'Open Play Console', url: 'https://play.google.com/console' }],
      labels: { app: app.id, platform: 'android', track },
    });
  }
  return { next, messages };
}

let token: { value: string; until: number } | undefined;

/** Service-account JWT exchanged for an OAuth token, cached until 5 min before expiry. */
async function accessToken(api: PlayApi): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.until > now) return token.value;
  const sa = api.serviceAccount;
  const claims = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const assertion = signJwt({ alg: 'RS256', typ: 'JWT' }, claims, sa.private_key);
  const t: { access_token: string; expires_in: number } = await fetchJson('Google token', 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  token = { value: t.access_token, until: now + t.expires_in - 300 };
  return token.value;
}

async function listReleases(api: PlayApi, pkg: string, track: string): Promise<PlayRelease[]> {
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}/tracks/${encodeURIComponent(track)}/releases`;
  const r: { releases?: PlayRelease[] } = await fetchJson(`Play releases ${pkg}/${track}`, url, { headers: { authorization: `Bearer ${await accessToken(api)}` } }, 15_000);
  return r.releases ?? [];
}

/** Where the Play states seen are kept between cron runs: a KV namespace binding. */
export interface StateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** One poll of every track. A track whose change no target got isn't saved, so the next run sends it again. */
export async function pollPlay(cfg: Pick<Config, 'playApi' | 'apps'>, router: Router, store: StateStore) {
  const api = cfg.playApi;
  const apps = [...cfg.apps.values()].filter((a) => a.play);
  if (!api) for (const a of apps) log('warn', 'app has play settings but there is no playApi: Google Play is not polled', { app: a.id });
  if (!api || !apps.length) return;

  let raw: string | null;
  try {
    raw = await store.get('play-state');
  } catch (err) {
    // Not "no state": the save below would overwrite good state with a baseline.
    return log('error', 'could not load Play state, skipping this poll', { err: String(err) });
  }
  let state: PlayState;
  try {
    state = JSON.parse(raw ?? '{}') as PlayState;
  } catch {
    return log('error', 'stored Play state is not JSON (fix or delete the play-state key), skipping this poll');
  }
  for (const app of apps)
    for (const track of app.play!.tracks) {
      const key = `${app.play!.packageName}/${track}`;
      try {
        const { next, messages } = playDiff(state[key], await listReleases(api, app.play!.packageName, track), app, track);
        if ((await router.deliver(messages)) === 'ok') state[key] = next;
      } catch (err) {
        log('error', 'Play poll failed', { track: key, err: errText(err) });
      }
    }
  const json = JSON.stringify(state);
  // KV's free plan allows 1,000 writes a day: write only on a change.
  if (json !== raw) await store.put('play-state', json).catch((err) => log('error', 'could not save Play state', { err: String(err) }));
}
