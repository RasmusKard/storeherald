// App Store Connect API webhooks: https://developer.apple.com/documentation/appstoreconnectapi/webhook-events
import { createHmac } from 'node:crypto';
import type { AppConfig, AscApi, Config } from '../config.ts';
import { errText, log } from '../log.ts';
import type { Message } from '../message.ts';
import type { Router } from '../router.ts';
import { fetchJson, platformName, pollEach, reviewMessage, safeEq, signJwt, type StateEvent, type StateStore } from './shared.ts';

interface AscEvent {
  data: {
    type: string;
    id: string;
    attributes?: null | { oldValue?: string; newValue?: string; newState?: string; newExternalBuildState?: string; timestamp?: string };
    relationships?: { instance?: { data?: { type: string; id: string } } };
  };
}
/** Filled in by an extra API call, because webhook payloads carry no version or app info. */
interface AscDetails {
  version?: string; // "1.4.2" or "1.4.2 (57)"
  platform?: string; // IOS, MAC_OS, ...
  appleAppId?: string;
  feedback?: { comment?: string; email?: string; device?: string; os?: string; screenshots?: string[] };
}

export const verifyAsc = (raw: Buffer, header: string | undefined, secret: string) =>
  !!header && safeEq(header, 'hmacsha256=' + createHmac('sha256', secret).update(raw).digest('hex'));

const ascUrl = (appleAppId: string | undefined, page: string) => `https://appstoreconnect.apple.com/apps${appleAppId ? `/${appleAppId}/${page}` : ''}`;
const ascBase = (app: AppConfig, platform: string) => ({ source: 'App Store Connect', labels: { app: app.id, platform: platform.toLowerCase() } });

const REJECTED = ['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
// States a version can move to straight out of review when Apple accepts it (any release type: manual, automatic, scheduled).
const APPROVED_FROM_REVIEW = ['ACCEPTED', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'READY_FOR_DISTRIBUTION'];

/** Abstract events for one AppVersionState change. Most states (PREPARE_FOR_SUBMISSION, READY_FOR_REVIEW, ...) map to none. */
function versionEvents(oldValue: string | undefined, newValue: string): StateEvent[] {
  const out: StateEvent[] = [];
  if (newValue === 'WAITING_FOR_REVIEW') out.push({ type: 'appreview.submitted', severity: 'info', what: 'submitted for review' });
  if (newValue === 'IN_REVIEW') out.push({ type: 'appreview.in_review', severity: 'info', what: 'in review' });
  if (REJECTED.includes(newValue)) out.push({ type: 'appreview.rejected', severity: 'error', what: newValue === 'METADATA_REJECTED' ? 'metadata rejected' : newValue === 'INVALID_BINARY' ? 'binary rejected' : 'rejected' });
  if (newValue === 'DEVELOPER_REJECTED') out.push({ type: 'appreview.withdrawn', severity: 'info', what: 'removed from review' });
  if (oldValue === 'IN_REVIEW' && APPROVED_FROM_REVIEW.includes(newValue)) out.push({ type: 'appreview.approved', severity: 'success', what: 'approved' });
  if (newValue === 'READY_FOR_DISTRIBUTION') out.push({ type: 'release.live', severity: 'success', what: 'live on the App Store' });
  return out;
}

const BETA_REVIEW: Record<string, StateEvent> = {
  WAITING_FOR_BETA_REVIEW: { type: 'betareview.submitted', severity: 'info', what: 'submitted for TestFlight review' },
  IN_BETA_REVIEW: { type: 'betareview.in_review', severity: 'info', what: 'in TestFlight review' },
  BETA_REJECTED: { type: 'betareview.rejected', severity: 'error', what: 'rejected in TestFlight review' },
  BETA_APPROVED: { type: 'betareview.approved', severity: 'success', what: 'approved in TestFlight review' },
  IN_BETA_TESTING: { type: 'testing.build.available', severity: 'success', what: 'available to external testers in TestFlight' },
};

const FEEDBACK: Record<string, StateEvent> = {
  betaFeedbackScreenshotSubmissionCreated: { type: 'testing.feedback', severity: 'info', what: 'TestFlight feedback' },
  betaFeedbackCrashSubmissionCreated: { type: 'testing.crash', severity: 'warning', what: 'TestFlight crash report' },
};

export function ascToMessages(e: AscEvent, app: AppConfig, d: AscDetails = {}): Message[] {
  const { type, id } = e.data;
  const a = e.data.attributes ?? {}; // the undocumented test ping may have none, or null
  const platform = platformName(d.platform ?? 'IOS');
  const name = `${app.name}${d.version ? ` ${d.version}` : ''}`;
  const url = (page: string) => ascUrl(d.appleAppId ?? app.asc?.appId, page);
  const base = { ...ascBase(app, platform), time: a.timestamp };

  if (type === 'appStoreVersionAppVersionStateUpdated' && a.newValue) {
    return versionEvents(a.oldValue, a.newValue).map((ev) => ({
      ...base,
      id: `asc:${id}:${ev.type}`,
      type: ev.type,
      severity: ev.severity,
      title: `${platform} ${ev.what}: ${name}`,
      body: ev.type === 'appreview.rejected' ? 'Apple does not expose the reason via the API: see the App Review message in App Store Connect.' : undefined,
      links: [{ label: 'Open in App Store Connect', url: url('distribution') }],
    }));
  }
  if (type === 'buildUploadStateUpdated' && (a.newState === 'COMPLETE' || a.newState === 'FAILED')) {
    const ok = a.newState === 'COMPLETE';
    return [{
      ...base,
      id: `asc:${id}`,
      type: ok ? 'testing.build.available' : 'build.processing_failed',
      severity: ok ? 'success' : 'error',
      title: ok ? `${platform} build processed, available in TestFlight: ${name}` : `${platform} build failed App Store Connect processing: ${name}`,
      links: [{ label: 'Open TestFlight', url: url('testflight') }],
    }];
  }
  const beta = type === 'buildBetaDetailExternalBuildStateUpdated' && a.newExternalBuildState ? BETA_REVIEW[a.newExternalBuildState] : undefined;
  if (beta) {
    return [{
      ...base,
      id: `asc:${id}`,
      type: beta.type,
      severity: beta.severity,
      title: `${platform} build ${beta.what}: ${name}`,
      body: beta.type === 'betareview.rejected' ? 'Apple does not expose the reason via the API: see TestFlight in App Store Connect.' : undefined,
      links: [{ label: 'Open TestFlight', url: url('testflight') }],
    }];
  }
  const fb = FEEDBACK[type];
  if (fb) {
    const f = d.feedback ?? {};
    return [{
      ...base,
      id: `asc:${id}`,
      type: fb.type,
      severity: fb.severity,
      title: `${platform} ${fb.what}: ${name}`,
      body: f.comment || undefined,
      actor: f.email,
      fields: [{ label: 'Device', value: f.device ?? '' }, { label: 'OS', value: f.os ?? '' }],
      links: [
        { label: 'Open TestFlight', url: url('testflight') },
        ...(f.screenshots ?? []).map((url, i) => ({ label: `Screenshot ${i + 1}`, url })), // signed URLs that expire
      ],
    }];
  }
  return [];
}

export const isAscEvent = (e: any): e is AscEvent => typeof e?.data?.type === 'string' && typeof e.data.id === 'string';

/** The messages for a verified event, looked up with `api` only when the event isn't ignored. */
export async function ascMessages(e: AscEvent, app: AppConfig, api: AscApi | undefined): Promise<Message[]> {
  // First pass without details: ignored events must not cost an App Store Connect API call.
  if (!ascToMessages(e, app).length) {
    log('info', 'ASC event ignored', { app: app.id, type: e.data.type, newValue: e.data.attributes?.newValue ?? e.data.attributes?.newState });
    return [];
  }
  return ascToMessages(e, app, await ascDetails(e, api));
}

// ---- App Store Connect API (optional: version details)

let token: { value: string; until: number } | undefined;

/** ES256 JWT for a team API key: valid 19 min (Apple allows 20), reused for 15. */
function jwt(api: AscApi): string {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.until > now) return token.value;
  const claims = { iss: api.issuerId, iat: now, exp: now + 1140, aud: 'appstoreconnect-v1' };
  // JWS wants the raw r||s signature, not DER
  token = { value: signJwt({ alg: 'ES256', kid: api.keyId, typ: 'JWT' }, claims, { key: api.privateKey, dsaEncoding: 'ieee-p1363' }), until: now + 900 };
  return token.value;
}

// Short by default: the webhook reply waits on it.
const ascFetch = (api: AscApi, path: string, timeoutMs = 3000) =>
  fetchJson(`ASC API ${path.split('?')[0]}`, `https://api.appstoreconnect.apple.com${path}`,
    { headers: { authorization: `Bearer ${jwt(api)}`, 'content-type': 'application/json' } }, timeoutMs);

// The fields of the JSON:API responses read below.
type Linkage = { data: { id: string } };
interface BuildResponse {
  data: { attributes: { version: string }; relationships?: { app?: Linkage } };
  included?: { type: string; attributes: { version?: string; platform?: string } }[];
}
interface FeedbackResponse {
  data: {
    attributes: { comment?: string; email?: string; deviceModel?: string; osVersion?: string; screenshots?: { url: string }[] };
    relationships: { build: Linkage };
  };
}

async function buildDetails(api: AscApi, buildId: string): Promise<AscDetails> {
  const r = (await ascFetch(api, `/v1/builds/${encodeURIComponent(buildId)}?include=preReleaseVersion,app&fields[builds]=version,preReleaseVersion,app&fields[preReleaseVersions]=version,platform&fields[apps]=bundleId`)) as BuildResponse;
  const pre = r.included?.find((x) => x.type === 'preReleaseVersions')?.attributes;
  const build = r.data.attributes.version;
  return { version: pre ? `${pre.version} (${build})` : build, platform: pre?.platform, appleAppId: r.data.relationships?.app?.data?.id };
}

async function ascDetails(e: AscEvent, api: AscApi | undefined): Promise<AscDetails> {
  const inst = e.data.relationships?.instance?.data;
  if (!api || !inst) return {};
  try {
    if (inst.type === 'appStoreVersions') {
      const r = await ascFetch(api, `/v1/appStoreVersions/${encodeURIComponent(inst.id)}?fields[appStoreVersions]=versionString,platform,app&include=app&fields[apps]=bundleId`);
      return { version: r.data.attributes.versionString, platform: r.data.attributes.platform, appleAppId: r.data.relationships?.app?.data?.id };
    }
    if (inst.type === 'buildUploads') {
      const a = (await ascFetch(api, `/v1/buildUploads/${encodeURIComponent(inst.id)}`)).data.attributes;
      return { version: `${a.cfBundleShortVersionString} (${a.cfBundleVersion})`, platform: a.platform };
    }
    if (inst.type === 'buildBetaDetails') {
      const r = (await ascFetch(api, `/v1/buildBetaDetails/${encodeURIComponent(inst.id)}/relationships/build`)) as Linkage;
      return await buildDetails(api, r.data.id);
    }
    if (inst.type === 'betaFeedbackScreenshotSubmissions' || inst.type === 'betaFeedbackCrashSubmissions') {
      const r = (await ascFetch(api, `/v1/${inst.type}/${encodeURIComponent(inst.id)}?include=build&fields[builds]=version`)) as FeedbackResponse;
      const a = r.data.attributes;
      const feedback = { comment: a.comment, email: a.email, device: a.deviceModel, os: a.osVersion, screenshots: a.screenshots?.map((x) => x.url) };
      return { ...(await buildDetails(api, r.data.relationships.build.data.id)), feedback };
    }
  } catch (err) {
    log('warn', 'ASC details lookup failed, sending without them', { err: errText(err) });
  }
  return {};
}

// ---- Polled on the cron (optional: ConfigAsc.appId)

interface CustomerReview {
  id: string;
  attributes: { rating: number; title?: string; body?: string; reviewerNickname?: string; territory?: string; createdDate: string };
}

/** Reviews newer than `prev`, the latest `createdDate` seen (epoch ms). `prev === undefined` (first poll) records a baseline. */
export function ascReviewsDiff(prev: number | undefined, r: { data: CustomerReview[] }, app: AppConfig) {
  const items = r.data.map((r) => ({ r: r.attributes, id: r.id, t: Date.parse(r.attributes.createdDate) || 0 })); // has a UTC offset: compare as numbers
  const next = Math.max(prev ?? 0, ...items.map((x) => x.t));
  if (prev === undefined) return { next, messages: [] };
  const messages = items.filter((x) => x.t > prev).map(({ r, id, t }) => reviewMessage(app, {
    id: `asc:review:${id}`,
    source: 'App Store',
    platform: 'ios',
    rating: r.rating,
    text: [r.title, r.body].filter(Boolean).join('\n'),
    author: r.reviewerNickname,
    time: new Date(t).toISOString(),
    fields: [{ label: 'Country', value: r.territory ?? '' }],
    url: `https://appstoreconnect.apple.com/apps/${app.asc!.appId}`,
  }));
  return { next, messages };
}

interface LiveVersions {
  data: { id: string; attributes: { versionString: string; platform: string }; relationships?: { appStoreVersionPhasedRelease?: { data?: { id: string } | null } } }[];
  included?: { type: string; id: string; attributes: { phasedReleaseState: string; currentDayNumber?: number } }[];
}
/** appStoreVersion id -> `${phasedReleaseState}:${currentDayNumber}` */
type PhasedState = Record<string, string>;

const PHASED_PERCENT = [1, 2, 5, 10, 20, 50, 100]; // by day: Apple's fixed schedule

function phasedEvent(state: string, day: number): StateEvent | undefined {
  const pct = `${PHASED_PERCENT[Math.min(day, 7) - 1] ?? 0}%`;
  if (state === 'ACTIVE') return { type: 'rollout.updated', severity: 'info', what: `phased release at ${pct} (day ${day} of 7)` };
  if (state === 'PAUSED') return { type: 'rollout.paused', severity: 'warning', what: `phased release paused at ${pct}` };
  if (state === 'COMPLETE') return { type: 'rollout.completed', severity: 'success', what: 'phased release complete' };
  return undefined;
}

/** Phased release changes of the live versions. `prev === undefined` (first poll) records a baseline and notifies nothing. */
export function phasedDiff(prev: PhasedState | undefined, r: LiveVersions, app: AppConfig) {
  const next: PhasedState = {};
  const messages: Message[] = [];
  for (const v of r.data) {
    const pid = v.relationships?.appStoreVersionPhasedRelease?.data?.id;
    const p = r.included?.find((x) => x.type === 'appStoreVersionPhasedReleases' && x.id === pid)?.attributes;
    if (!p) continue; // released to everyone at once
    const day = p.currentDayNumber ?? 0;
    const state = `${p.phasedReleaseState}:${day}`;
    next[v.id] = state;
    if (!prev || prev[v.id] === state) continue;

    const ev = phasedEvent(p.phasedReleaseState, day);
    if (!ev) continue;
    const platform = platformName(v.attributes.platform);
    messages.push({
      id: `asc:${v.id}:${state}`,
      type: ev.type,
      ...ascBase(app, platform),
      severity: ev.severity,
      title: `${platform} ${ev.what}: ${app.name} ${v.attributes.versionString}`,
      links: [{ label: 'Open in App Store Connect', url: ascUrl(app.asc!.appId, 'distribution') }],
    });
  }
  return { next, messages };
}

interface UnresolvedSubmissions {
  data: { id: string; attributes: { platform?: string }; relationships?: { appStoreVersionForReview?: { data?: { id: string } | null } } }[];
  included?: { type: string; id: string; attributes: { versionString?: string; appVersionState?: string } }[];
}

/**
 * Submissions App Review sent back, such as for an in-app purchase or event, that no version webhook reports: those
 * whose version was rejected are skipped. `prev === undefined` (first poll) records a baseline and notifies nothing.
 */
export function unresolvedDiff(prev: string[] | undefined, r: UnresolvedSubmissions, app: AppConfig) {
  const next = r.data.map((s) => s.id);
  if (!prev) return { next, messages: [] };
  const messages = r.data.filter((s) => !prev.includes(s.id)).flatMap((s): Message[] => {
    const vid = s.relationships?.appStoreVersionForReview?.data?.id;
    const v = r.included?.find((x) => x.type === 'appStoreVersions' && x.id === vid)?.attributes;
    if (v?.appVersionState && REJECTED.includes(v.appVersionState)) return [];
    const platform = platformName(s.attributes.platform ?? 'IOS');
    return [{
      id: `asc:submission:${s.id}`,
      type: 'appreview.unresolved',
      ...ascBase(app, platform),
      severity: 'error',
      title: `${platform} App Review found unresolved issues: ${app.name}${v?.versionString ? ` ${v.versionString}` : ''}`,
      body: 'Apple does not expose the reason via the API: see the App Review message in App Store Connect.',
      links: [{ label: 'Open in App Store Connect', url: ascUrl(app.asc!.appId, 'distribution') }],
    }];
  });
  return { next, messages };
}

/** One poll of the App Store Connect API for every app with ConfigAsc.appId. */
export async function pollAsc(cfg: Pick<Config, 'ascApi' | 'apps'>, router: Router, store: StateStore | undefined) {
  const api = cfg.ascApi;
  const apps = [...cfg.apps.values()].filter((a) => a.asc?.appId);
  if (!api || !apps.length) return;
  if (!store) return log('error', 'no STATE KV binding: App Store Connect is not polled');

  const each = <S>(key: string, list: AppConfig[], path: string, diff: (prev: S | undefined, r: any, app: AppConfig) => { next: S; messages: Message[] }) =>
    pollEach<S>(store, key, router, list.map((app) => ({
      id: app.asc!.appId!,
      poll: async (prev) => diff(prev, await ascFetch(api, `/v1/apps/${encodeURIComponent(app.asc!.appId!)}/${path}`, 15_000), app),
    })));
  await each('asc-phased', apps, 'appStoreVersions?filter[appVersionState]=READY_FOR_DISTRIBUTION&include=appStoreVersionPhasedRelease'
    + '&fields[appStoreVersions]=versionString,platform,appStoreVersionPhasedRelease&fields[appStoreVersionPhasedReleases]=phasedReleaseState,currentDayNumber', phasedDiff);
  await each('asc-submissions', apps, 'reviewSubmissions?filter[state]=UNRESOLVED_ISSUES&include=appStoreVersionForReview'
    + '&fields[reviewSubmissions]=platform,appStoreVersionForReview&fields[appStoreVersions]=versionString,appVersionState', unresolvedDiff);
  await each('asc-reviews', apps.filter((a) => a.asc!.reviews), 'customerReviews?sort=-createdDate&limit=100&fields[customerReviews]=rating,title,body,reviewerNickname,territory,createdDate', ascReviewsDiff);
}
