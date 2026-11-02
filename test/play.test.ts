// One Google Play poll, against a stubbed Play API, a fake router and a fake KV store.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.ts';
import type { Outcome } from '../src/router.ts';
import { pollPlay } from '../src/sources/play.ts';

const app: AppConfig = { id: 'myapp', name: 'My App', play: { packageName: 'com.acme.myapp', tracks: ['production'] } };
// A real RSA key: the poll signs its token request with it.
const private_key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const cfg = { playApi: { serviceAccount: { client_email: 'poller@acme.iam', private_key } }, apps: new Map([[app.id, app]]) };
const stored = (state: string) => JSON.stringify({ 'com.acme.myapp/production': { '57|57': `RELEASE_LIFECYCLE_STATE_${state}` } });
const play = async (url: string) =>
  Response.json(url.includes('oauth2') ? { access_token: 't', expires_in: 3600 }
    : { releases: [{ releaseName: '57', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode: '57' }] }] });
const router = (outcome: Outcome, sent: string[] = []) => ({ deliver: async (msgs: { type: string }[]) => (sent.push(...msgs.map((m) => m.type)), outcome) });

void test('poll: a state change is delivered and the new state saved', async (t) => {
  t.mock.method(globalThis, 'fetch', play);
  const sent: string[] = [];
  const put = t.mock.fn(async (_k: string, _v: string) => {});
  await pollPlay(cfg, router('ok', sent), { get: async () => stored('IN_REVIEW'), put });
  assert.deepEqual(sent, ['release.live']);
  assert.deepEqual(put.mock.calls.map((c) => c.arguments), [['play-state', stored('PUBLISHED')]]);
});

void test('poll: nothing is saved when the state fails to load, is unchanged, or was not delivered', async (t) => {
  t.mock.method(globalThis, 'fetch', play);
  t.mock.method(console, 'log', () => {});
  const put = t.mock.fn(async () => {});
  // A save after a failed load would overwrite the good stored state with a fresh baseline.
  await pollPlay(cfg, router('ok'), { get: async () => { throw new Error('store down'); }, put });
  await pollPlay(cfg, router('ok'), { get: async () => stored('PUBLISHED'), put });
  // Not saved, so the next run sends it again.
  await pollPlay(cfg, router('retry'), { get: async () => stored('IN_REVIEW'), put });
  assert.equal(put.mock.callCount(), 0);
});
