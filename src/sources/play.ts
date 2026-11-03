// Google Play has no webhooks for releases: poll tracks.releases.list for releaseLifecycleState.
// https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases
import type { AppConfig, Config, PlayApi } from '../config.ts';
import { log } from '../log.ts';
import type { Message } from '../message.ts';
import type { Router } from '../router.ts';
import { fetchJson, pollEach, signJwt, type StateEvent, type StateStore } from './shared.ts';

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
  const scope = 'https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting';
  const claims = { iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
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

/**
 * One poll of every track, and of vitals for the apps that ask for them. A change no target got
 * isn't saved, so the next run sends it again.
 */
export async function pollPlay(cfg: Pick<Config, 'playApi' | 'apps'>, router: Router, store: StateStore | undefined) {
  const api = cfg.playApi;
  const apps = [...cfg.apps.values()].filter((a) => a.play);
  if (!api || !apps.length) return;
  if (!store) return log('error', 'no STATE KV binding: Google Play is not polled');

  await pollEach<PlayState[string]>(store, 'play-state', router, apps.flatMap((app) => app.play!.tracks.map((track) => ({
    id: `${app.play!.packageName}/${track}`,
    poll: async (prev) => playDiff(prev, await listReleases(api, app.play!.packageName, track), app, track),
  }))));
  // One state entry per app, for the apps with the option on.
  const perApp = <S>(key: string, on: 'vitals', poll: (app: AppConfig, pkg: string, prev: S | undefined) => Promise<{ next: S; messages: Message[] }>) =>
    pollEach<S>(store, key, router, apps.filter((a) => a.play![on]).map((app) => ({ id: app.play!.packageName, poll: (prev) => poll(app, app.play!.packageName, prev) })));
  await perApp<VitalsState[string]>('play-vitals', 'vitals', async (app, pkg, prev) => {
    const { anomalies, issues } = await listVitals(api, pkg);
    return vitalsDiff(prev, anomalies, issues, app);
  });
}

// ---- Android vitals (optional: ConfigPlay.vitals)
// https://developers.google.com/play/developer/reporting/reference/rest

export interface Anomaly {
  name: string;
  metricSet: string; // apps/{app}/crashRateMetricSet
  dimensions?: { dimension: string; valueLabel?: string; stringValue?: string; int64Value?: string }[];
  metric?: { metric: string; decimalValue?: { value: string } };
}
export interface ErrorIssue {
  name: string;
  type: string; // CRASH, APPLICATION_NOT_RESPONDING
  cause?: string; // the exception or signal, or the kind of ANR
  location?: string;
  errorReportCount?: string;
  distinctUsers?: string;
  issueUri?: string;
  firstAppVersion?: { versionCode?: string };
  lastAppVersion?: { versionCode?: string };
}
/** packageName -> the anomaly and issue names seen */
export type VitalsState = Record<string, { anomalies: string[]; issues: string[] }>;

// Issues drop out of the 24-hour search when they stop happening, so remember them longer than that, within reason.
const ISSUES_KEPT = 500;
const REPORTING = 'https://playdeveloperreporting.googleapis.com/v1beta1';

/** apps/x/anrRateMetricSet -> ANR rate */
const metricSetName = (s: string) =>
  (s.split('/').pop() ?? s).replace(/MetricSet$/, '').replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`).replace(/^(anr|lmk)\b/, (w) => w.toUpperCase());

function metricValue(m: Anomaly['metric']): string {
  const v = m?.decimalValue?.value;
  if (!v) return '';
  return /rate/i.test(m.metric) ? `${(Number(v) * 100).toFixed(2)}%` : v; // rates are fractions
}

/** New anomalies and issues since last time. `prev === undefined` (first poll) records a baseline and notifies nothing. */
export function vitalsDiff(prev: VitalsState[string] | undefined, anomalies: Anomaly[], issues: ErrorIssue[], app: AppConfig) {
  const next = { anomalies: anomalies.map((a) => a.name), issues: [...new Set([...issues.map((i) => i.name), ...(prev?.issues ?? [])])].slice(0, ISSUES_KEPT) };
  if (!prev) return { next, messages: [] };
  const base = { source: 'Google Play', labels: { app: app.id, platform: 'android' } };
  const messages: Message[] = [
    ...anomalies.filter((a) => !prev.anomalies.includes(a.name)).map((a): Message => ({
      ...base,
      id: `play:${a.name}`,
      type: 'vitals.anomaly',
      severity: 'warning',
      title: `Android ${metricSetName(a.metricSet)} above normal: ${app.name}`,
      fields: [{ label: 'Value', value: metricValue(a.metric) }, ...(a.dimensions ?? []).map((d) => ({ label: d.dimension, value: d.valueLabel ?? d.stringValue ?? d.int64Value ?? '' }))],
      links: [{ label: 'Open Play Console', url: 'https://play.google.com/console' }],
    })),
    ...issues.filter((i) => !prev.issues.includes(i.name)).map((i): Message => {
      const [first, last] = [i.firstAppVersion?.versionCode, i.lastAppVersion?.versionCode];
      return {
        ...base,
        id: `play:${i.name}`,
        type: 'vitals.issue',
        severity: 'warning',
        title: `New Android ${i.type === 'APPLICATION_NOT_RESPONDING' ? 'ANR' : 'crash'} in ${app.name}${i.cause ? `: ${i.cause}` : ''}`,
        body: i.location,
        fields: [
          { label: 'Users', value: i.distinctUsers ?? '' },
          { label: 'Reports', value: i.errorReportCount ?? '' },
          { label: 'Version code', value: first && last && first !== last ? `${first}–${last}` : (first ?? '') },
        ],
        links: [{ label: 'Open in Android vitals', url: i.issueUri ?? 'https://play.google.com/console' }],
      };
    }),
  ];
  return { next, messages };
}

async function listVitals(api: PlayApi, pkg: string) {
  const init = { headers: { authorization: `Bearer ${await accessToken(api)}` } };
  const app = `${REPORTING}/apps/${encodeURIComponent(pkg)}`;
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const a = (await fetchJson(`Play anomalies ${pkg}`, `${app}/anomalies?pageSize=100&filter=${encodeURIComponent(`activeBetween("${since}", UNBOUNDED)`)}`, init, 15_000)) as { anomalies?: Anomaly[] };
  // The last 24 hours, most users first.
  const filter = encodeURIComponent('errorIssueType = CRASH OR errorIssueType = ANR');
  const i = (await fetchJson(`Play error issues ${pkg}`, `${app}/errorIssues:search?pageSize=100&orderBy=distinctUsers%20desc&filter=${filter}`, init, 15_000)) as { errorIssues?: ErrorIssue[] };
  return { anomalies: a.anomalies ?? [], issues: i.errorIssues ?? [] };
}
