import { createPrivateKey } from 'node:crypto';
import { signJwt } from './sources/shared.ts';
import { parse } from 'yaml';
import { SEVERITIES, type Message, type Severity } from './message.ts';
import type { IngestEvent } from './sources/ingest.ts';
import { keysOf, obj, optStr, str, type Delivery, type Obj, type Target } from './targets/shared.ts';
import { slack, type SlackTarget } from './targets/slack.ts';
import { discord, type DiscordTarget } from './targets/discord.ts';
import { teams, type TeamsTarget } from './targets/teams.ts';
import { DEFAULTS } from './config.defaults.ts';

const TARGET_TYPES: Record<string, Target<any>> = { slack, discord, teams };

/**
 * The config: YAML in the Worker's `STOREHERALD_CONFIG` variable, read on the first request or cron run. An unknown key
 * fails it.
 *
 * `"${VAR}"` in a string value is replaced with the Worker variable or secret `VAR`, and loading fails when it's unset.
 * Quote it: inside `{ ... }` an unquoted `${VAR}` is a YAML syntax error. Numbers and booleans may be strings, so they
 * can come from `"${VAR}"` too.
 */
export interface ConfigFile {
  /**
   * The apps, by id. The id may contain a-z, 0-9 and `-`. It is in the webhook URLs (`/eas/<id>`, `/asc/<id>`) and is
   * the `app` label routes match on.
   */
  apps: Record<string, ConfigApp>;
  /**
   * Adds the version number and the platform to App Store Connect messages, a link to the app to App Review, TestFlight
   * and release messages, and the tester's comment, email, device and screenshots to TestFlight feedback. Without it, or when the lookup fails, the message is sent without them and says iOS, with the
   * `platform: ios` label, whatever the app's platform.
   */
  ascApi?: ConfigAscApi;
  /** The Google Play API credentials for every {@link ConfigApp.play}. */
  playApi?: ConfigPlayApi;
  /** Enables `/ingest`. */
  ingest?: ConfigIngest;
  /** Where messages are posted. At least one. */
  targets: (SlackTarget | DiscordTarget | TeamsTarget)[];
  /** Which events go to which targets. At least one. */
  routes: ConfigRoute[];
}

/** An app in {@link ConfigFile.apps}. */
export interface ConfigApp {
  /** The name shown in messages. */
  name: string;
  /** Receives EAS build and submission webhooks at `/eas/<id>`. */
  eas?: ConfigWebhook;
  /** Receives App Store Connect webhooks at `/asc/<id>`. */
  asc?: ConfigAsc;
  /** Polls Google Play, which has no release webhooks. Needs {@link ConfigFile.playApi}. */
  play?: ConfigPlay;
}

/** A webhook source of a {@link ConfigApp}. */
export interface ConfigWebhook {
  /**
   * The secret the webhook is signed with. For EAS, the one passed to `eas webhook:create --secret` (16 or more
   * characters). For App Store Connect, the one set when creating the webhook.
   */
  secret: string;
}

/** The App Store Connect source of a {@link ConfigApp}. */
export interface ConfigAsc extends ConfigWebhook {
  /**
   * The app's Apple ID, the number in its App Store Connect URL. With it, the Worker polls the App Store Connect API
   * with {@link ConfigFile.ascApi} on its cron schedule, in `wrangler.jsonc`, and posts phased release changes:
   * `rollout.updated` for each day's new percentage or a resume, `rollout.paused` and `rollout.completed`. It also posts
   * `appreview.unresolved` when App Review sends back a submission whose version wasn't rejected, such as one for an
   * in-app purchase or event. The first poll only records the current state. It also makes every App Store Connect
   * message link to the app.
   */
  appId?: string;
  /**
   * Posts App Store reviews written since the last poll, as `userreview.posted`. The first poll only records the
   * current ones.
   * @default `false`
   */
  reviews?: boolean;
}

/** The Google Play source of a {@link ConfigApp}. */
export interface ConfigPlay {
  /** The app's package name, such as `com.acme.myapp`. */
  packageName: string;
  /**
   * The tracks to watch, such as `[internal, production]`. A release published on `production` is a `release.live`
   * event, on any other track a `testing.build.available` event. The first poll only records the current state.
   */
  tracks: string[];
  /**
   * Also posts Android vitals alerts: `vitals.anomaly` when Google flags a vitals rate, such as the crash or ANR rate, as
   * unexpectedly high, and `vitals.issue` for a crash or ANR issue the Worker hasn't seen before. The first poll only
   * records the current ones. Needs the *Google Play Developer Reporting API* enabled in the service account's Google
   * Cloud project.
   * @default `false`
   */
  vitals?: boolean;
  /**
   * Also posts reviews written or edited since the last poll, as `userreview.posted`. Google's API only returns reviews
   * with text, on production. The service account needs the *Reply to reviews* permission in Play Console.
   * @default `false`
   */
  reviews?: boolean;
}

/** An App Store Connect API team key, from App Store Connect › Users and Access › Integrations › Team keys. The Developer role is enough. */
export interface ConfigAscApi {
  /** The Issuer ID shown above the keys list. */
  issuerId: string;
  /** The key's Key ID. */
  keyId: string;
  /** The `.p8` key's PEM. */
  privateKey: string;
}

/** A Google Cloud service account with read-only access to the apps in Play Console. */
export interface ConfigPlayApi {
  /** The service account's JSON key. Play is polled on the Worker's cron schedule, in `wrangler.jsonc`. */
  serviceAccount: string;
}

/** Settings for `POST /ingest`. The body is an {@link IngestEvent}. */
export interface ConfigIngest {
  /** The Standard Webhooks signing key: `whsec_` followed by at least 24 random bytes in base64. */
  secret: string;
}

/**
 * Sends the events that match it to targets. Every matching route fires. A target matched by several routes gets one
 * message, with a mention if any of them asks and silent only if all do.
 */
export interface ConfigRoute {
  /**
   * Event types: exact names, or a prefix ending in `*` such as `appreview.*` or `*`. An {@link IngestEvent} brings its
   * own, such as `update.published`. The built-in types:
   *
   * | Type | Severity | Source |
   * | --- | --- | --- |
   * | `build.succeeded`, `submit.succeeded` | `success` | EAS |
   * | `build.failed`, `submit.failed` | `error` | EAS |
   * | `build.canceled`, `submit.canceled` | `info` | EAS |
   * | `build.processing_failed` | `error` | App Store Connect |
   * | `testing.build.available` | `success` | App Store Connect, Google Play |
   * | `betareview.submitted`, `betareview.in_review` | `info` | App Store Connect (TestFlight external testing) |
   * | `betareview.approved` | `success` | App Store Connect (TestFlight external testing) |
   * | `betareview.rejected` | `error` | App Store Connect (TestFlight external testing) |
   * | `testing.feedback` | `info` | App Store Connect (TestFlight feedback with a screenshot) |
   * | `testing.crash` | `warning` | App Store Connect (TestFlight feedback on a crash) |
   * | `appreview.submitted` | `info` | App Store Connect |
   * | `appreview.in_review` | `info` | App Store Connect, Google Play |
   * | `appreview.approved` | `success` | App Store Connect, Google Play |
   * | `appreview.rejected` | `error` | App Store Connect, Google Play |
   * | `appreview.withdrawn` | `info` | App Store Connect |
   * | `appreview.unresolved` | `error` | App Store Connect ({@link ConfigAsc.appId}) |
   * | `release.live` | `success` | App Store Connect, Google Play |
   * | `vitals.anomaly`, `vitals.issue` | `warning` | Google Play ({@link ConfigPlay.vitals}) |
   * | `rollout.updated` | `info` | App Store Connect ({@link ConfigAsc.appId}) |
   * | `rollout.paused` | `warning` | App Store Connect ({@link ConfigAsc.appId}) |
   * | `rollout.completed` | `success` | App Store Connect ({@link ConfigAsc.appId}) |
   * | `userreview.posted` | `warning` for 1 or 2 stars, `info` for 3, `success` for 4 or 5 | App Store Connect ({@link ConfigAsc.reviews}), Google Play ({@link ConfigPlay.reviews}) |
   *
   * EAS sends no event when a build or submission starts.
   */
  types: string[];
  /**
   * Labels the event must have, matched exactly: `app` (the app id), `platform` (`ios`, `macos`, `tvos`, `visionos` or `android`; App Store Connect events need
   * {@link ConfigFile.ascApi} for any but `ios`), `profile` (the
   * EAS build profile), `track` (the Google Play track), or those of an {@link IngestEvent}.
   */
  labels?: Record<string, string>;
  /**
   * Drops events less severe than this, in the order `info`, `success`, `warning`, `error`.
   * @default `'info'`
   */
  minSeverity?: Severity;
  /** The ids of the targets to post to. */
  targets: string[];
  /**
   * Pings the target's `mention`.
   * @default `false`
   */
  mention?: boolean;
  /**
   * Posts without a push notification, on targets that support it ({@link DiscordTarget}).
   * @default `false`
   */
  silent?: boolean;
}

export interface AppConfig extends ConfigApp {
  id: string; // its key in ConfigFile.apps
}
export type Route = Required<ConfigRoute>;
/** A target bound to its parsed config. */
export interface TargetInstance {
  render(msg: Message, d: Delivery): unknown;
  send(payload: unknown): Promise<void>;
}
export interface PlayApi {
  serviceAccount: { client_email: string; private_key: string };
}
export interface Config {
  apps: Map<string, AppConfig>;
  ascApi?: ConfigAscApi;
  playApi?: PlayApi;
  ingest?: ConfigIngest;
  targets: Map<string, TargetInstance>;
  routes: Route[];
}

function strList(o: Obj, k: string, where: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string' && x)) throw new Error(`config: ${where}.${k} must be a non-empty list of strings`);
  return v;
}
// Errors never echo the value: it's a secret.
function inline(v: string, start: string, where: string): string {
  if (v.trimStart().startsWith(start)) return v;
  throw new Error(`config: ${where} must be inline, starting with ${start}`);
}
// node:crypto's error names no field, and must not be replaced by one that quotes the key.
function checkKey(where: string, check: () => unknown) {
  try {
    check();
  } catch {
    throw new Error(`config: ${where} is not a usable private key`);
  }
}
function bool(o: Obj, k: string, where: string, fallback: boolean): boolean {
  const v = o[k] ?? fallback;
  if (v === false || v === 'false') return false;
  if (v === true || v === 'true') return true; // "true" too: ${VAR} interpolation always yields strings
  throw new Error(`config: ${where}.${k} must be true or false`);
}

/** Replace ${VAR} in string values only, after YAML parsing, so secrets containing : # or quotes can't break the YAML. */
export function interpolate(v: unknown, env: Record<string, unknown>): unknown {
  if (typeof v === 'string')
    return v.replace(/\$\{(\w+)\}/g, (_, name: string) => {
      const value = env[name];
      if (typeof value !== 'string') throw new Error(`config: variable ${name} is not set`); // a binding (KV) isn't a value
      return value;
    });
  if (Array.isArray(v)) return v.map((x) => interpolate(x, env));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x, env)]));
  return v;
}

function parseApps(v: unknown): Map<string, AppConfig> {
  const apps = new Map<string, AppConfig>();
  for (const [id, raw] of Object.entries(obj(v, 'apps'))) {
    const w = `apps.${id}`;
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`config: app id "${id}" may only contain a-z, 0-9 and -`);
    const a = obj(raw, w, keysOf<ConfigApp>({ name: true, eas: true, asc: true, play: true }));
    const eas = a.eas == null ? undefined : obj(a.eas, `${w}.eas`, keysOf<ConfigWebhook>({ secret: true }));
    const asc = a.asc == null ? undefined : obj(a.asc, `${w}.asc`, keysOf<ConfigAsc>({ secret: true, appId: true, reviews: true }));
    const play = a.play == null ? undefined : obj(a.play, `${w}.play`, keysOf<ConfigPlay>({ packageName: true, tracks: true, vitals: true, reviews: true }));
    apps.set(id, {
      id,
      name: str(a, 'name', w),
      eas: eas && { secret: str(eas, 'secret', `${w}.eas`) },
      asc: asc && {
        secret: str(asc, 'secret', `${w}.asc`),
        appId: optStr(asc, 'appId', `${w}.asc`),
        reviews: bool(asc, 'reviews', `${w}.asc`, DEFAULTS.ConfigAsc.reviews),
      },
      play: play && {
        packageName: str(play, 'packageName', `${w}.play`),
        tracks: strList(play, 'tracks', `${w}.play`),
        vitals: bool(play, 'vitals', `${w}.play`, DEFAULTS.ConfigPlay.vitals),
        reviews: bool(play, 'reviews', `${w}.play`, DEFAULTS.ConfigPlay.reviews),
      },
    });
  }
  return apps;
}

function parseAscApi(v: unknown): ConfigAscApi {
  const a = obj(v, 'ascApi', keysOf<ConfigAscApi>({ issuerId: true, keyId: true, privateKey: true }));
  const pem = inline(str(a, 'privateKey', 'ascApi'), '-----BEGIN', 'ascApi.privateKey');
  // Signs rather than parses: workerd rejects the KeyObject form here, and only signing shows it.
  checkKey('ascApi.privateKey', () => signJwt({}, {}, { key: pem, dsaEncoding: 'ieee-p1363' }));
  return { issuerId: str(a, 'issuerId', 'ascApi'), keyId: str(a, 'keyId', 'ascApi'), privateKey: pem }; // PEM, not a KeyObject: workerd's sign() rejects a KeyObject with dsaEncoding
}

function parsePlayApi(v: unknown): PlayApi {
  const p = obj(v, 'playApi', keysOf<ConfigPlayApi>({ serviceAccount: true }));
  const text = inline(str(p, 'serviceAccount', 'playApi'), '{', 'playApi.serviceAccount');
  let sa: { client_email?: unknown; private_key?: unknown } | null;
  try {
    sa = JSON.parse(text);
  } catch {
    throw new Error('config: playApi.serviceAccount is not valid JSON'); // not err.message: it quotes the private key
  }
  if (typeof sa?.client_email !== 'string' || typeof sa.private_key !== 'string') throw new Error('config: playApi.serviceAccount is not a service-account key JSON');
  checkKey('playApi.serviceAccount private_key', () => createPrivateKey(sa.private_key as string)); // fail at load, not on every poll
  return { serviceAccount: { client_email: sa.client_email, private_key: sa.private_key } };
}

function parseIngest(v: unknown): ConfigIngest {
  const secret = str(obj(v, 'ingest', keysOf<ConfigIngest>({ secret: true })), 'secret', 'ingest');
  // An empty or non-base64 key would make every signature forgeable.
  const b64 = secret.replace(/^whsec_/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || Buffer.from(b64, 'base64').length < 24)
    throw new Error('config: ingest.secret must be whsec_ followed by at least 24 base64-encoded random bytes (see README)');
  return { secret };
}

function parseTargets(v: unknown): Map<string, TargetInstance> {
  const targets = new Map<string, TargetInstance>();
  if (!Array.isArray(v) || !v.length) throw new Error('config: targets must be a non-empty list');
  for (const [i, raw] of v.entries()) {
    const t = obj(raw, `targets[${i}]`);
    const id = str(t, 'id', `targets[${i}]`);
    const type = str(t, 'type', `targets.${id}`);
    const target = Object.hasOwn(TARGET_TYPES, type) ? TARGET_TYPES[type] : undefined;
    if (!target) throw new Error(`config: targets.${id}.type must be one of ${Object.keys(TARGET_TYPES).join(', ')}`);
    obj(raw, `targets.${id}`, ['id', 'type', ...target.keys]);
    if (targets.has(id)) throw new Error(`config: duplicate target id ${id}`);
    const c = target.parseConfig(t, `targets.${id}`);
    targets.set(id, { render: (m, d) => target.render(m, c, d), send: (payload) => target.send(payload, c) });
  }
  return targets;
}

function parseRoutes(v: unknown, targets: Map<string, TargetInstance>): Route[] {
  if (!Array.isArray(v) || !v.length) throw new Error('config: routes must be a non-empty list');
  return v.map((raw, i): Route => {
    const w = `routes[${i}]`;
    const r = obj(raw, w, keysOf<ConfigRoute>({ types: true, labels: true, minSeverity: true, targets: true, mention: true, silent: true }));
    const types = strList(r, 'types', w);
    for (const t of types) if (t.slice(0, -1).includes('*')) throw new Error(`config: ${w}.types: "*" is only allowed at the end ("${t}")`);
    const ids = strList(r, 'targets', w);
    for (const id of ids) if (!targets.has(id)) throw new Error(`config: ${w}.targets: unknown target "${id}"`);
    const minSeverity = (r.minSeverity ?? DEFAULTS.ConfigRoute.minSeverity) as Severity;
    if (!(SEVERITIES as readonly string[]).includes(minSeverity)) throw new Error(`config: ${w}.minSeverity must be one of ${SEVERITIES.join(', ')}`);
    const labels = r.labels == null ? {} : obj(r.labels, `${w}.labels`);
    for (const k of Object.keys(labels)) str(labels, k, `${w}.labels`);
    return { types, labels: labels as Record<string, string>, minSeverity, targets: ids, mention: bool(r, 'mention', w, DEFAULTS.ConfigRoute.mention), silent: bool(r, 'silent', w, DEFAULTS.ConfigRoute.silent) };
  });
}

export function parseConfig(raw: unknown): Config {
  const root = obj(raw, 'root', keysOf<ConfigFile>({ apps: true, ascApi: true, playApi: true, ingest: true, targets: true, routes: true }));
  const targets = parseTargets(root.targets);
  const apps = parseApps(root.apps);
  const playApi = root.playApi == null ? undefined : parsePlayApi(root.playApi);
  const unpolled = [...apps.values()].find((a) => a.play && !playApi);
  if (unpolled) throw new Error(`config: apps.${unpolled.id}.play needs playApi`);
  const ascApi = root.ascApi == null ? undefined : parseAscApi(root.ascApi);
  for (const a of apps.values()) {
    if (a.asc?.reviews && !a.asc.appId) throw new Error(`config: apps.${a.id}.asc.reviews needs asc.appId`);
    if (a.asc?.appId && !ascApi) throw new Error(`config: apps.${a.id}.asc.appId needs ascApi`);
  }
  return {
    apps,
    ascApi,
    playApi,
    ingest: root.ingest == null ? undefined : parseIngest(root.ingest),
    targets,
    routes: parseRoutes(root.routes, targets),
  };
}

export function loadConfig(env: Record<string, unknown>): Config {
  if (typeof env.STOREHERALD_CONFIG !== 'string') throw new Error('config: the STOREHERALD_CONFIG variable is not set');
  return parseConfig(interpolate(parse(env.STOREHERALD_CONFIG), env));
}
