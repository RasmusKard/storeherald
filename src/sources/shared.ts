import { sign, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.ts';
import { errText, log } from '../log.ts';
import type { Message, Severity } from '../message.ts';
import type { Router } from '../router.ts';

/** Constant-time string compare. timingSafeEqual throws on a byte-length mismatch (non-ASCII headers), so compare buffers. */
export function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What a source's state change means: the message type, its severity and the title's verb phrase. */
export interface StateEvent {
  type: string;
  severity: Severity;
  what: string;
}

// EAS sends ios/android, App Store Connect IOS, MAC_OS, TV_OS, VISION_OS.
const PLATFORM: Record<string, string> = { ios: 'iOS', mac_os: 'macOS', tv_os: 'tvOS', vision_os: 'visionOS', android: 'Android' };
export const platformName = (p: string) => PLATFORM[p.toLowerCase()] ?? p;

/** GET/POST returning parsed JSON; throws with the status and the start of the body on non-2xx. */
export async function fetchJson(what: string, url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${what}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? undefined : res.json();
}

/** Where pollers keep what they have seen between cron runs: a KV namespace binding. */
export interface StateStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** One thing a poller watches: `poll` turns its last state (undefined on the first run) into messages and its new state. */
export interface Poll<S> {
  id: string;
  poll(prev: S | undefined): Promise<{ next: S; messages: Message[] }>;
}

/**
 * Runs each poll against its entry in the JSON object stored under `key`. An entry is saved only once a target got its
 * messages, so the next run sends them again. Skips the run when the state can't be loaded.
 */
export async function pollEach<S>(store: StateStore, key: string, router: Router, polls: Poll<S>[]) {
  let raw: string | null;
  try {
    raw = await store.get(key);
  } catch (err) {
    // Not "no state": the save below would overwrite good state with a baseline.
    return log('error', 'could not load poller state, skipping this poll', { key, err: String(err) });
  }
  let state: Record<string, S>;
  try {
    state = JSON.parse(raw ?? '{}') as Record<string, S>;
  } catch {
    return log('error', 'stored poller state is not JSON (fix or delete the key), skipping this poll', { key });
  }
  for (const p of polls) {
    try {
      const { next, messages } = await p.poll(state[p.id]);
      if ((await router.deliver(messages)) === 'ok') state[p.id] = next;
    } catch (err) {
      log('error', 'poll failed', { key, id: p.id, err: errText(err) });
    }
  }
  const json = JSON.stringify(state);
  // KV's free plan allows 1,000 writes a day: write only on a change.
  if (json !== raw) await store.put(key, json).catch((err) => log('error', 'could not save poller state', { key, err: String(err) }));
}

/** A store review. Its severity follows the rating, so a route's `minSeverity: warning` keeps 1 and 2 stars only. */
export function reviewMessage(app: AppConfig, r: {
  id: string; source: string; platform: string; rating: number; text: string; author?: string; time: string;
  fields: { label: string; value: string }[]; url: string;
}): Message {
  const stars = Math.min(5, Math.max(1, Math.round(r.rating)));
  return {
    id: r.id,
    type: 'userreview.posted',
    source: r.source,
    severity: stars <= 2 ? 'warning' : stars === 3 ? 'info' : 'success',
    time: r.time,
    title: `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)} ${r.source} review: ${app.name}`,
    body: r.text || undefined,
    actor: r.author,
    fields: r.fields,
    links: [{ label: 'Open reviews', url: r.url }],
    labels: { app: app.id, platform: r.platform },
  };
}

const b64u = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
/** Compact JWS signed with SHA-256. */
export function signJwt(header: object, claims: object, key: Parameters<typeof sign>[2]): string {
  const input = `${b64u(header)}.${b64u(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
}
