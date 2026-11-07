import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { interpolate, loadConfig, parseConfig, type TargetInstance } from '../src/config.ts';
import type { Message } from '../src/message.ts';
import { createRouter, plan } from '../src/router.ts';
import { ascKey, serviceAccount } from './keys.ts';

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm1', type: 'build.failed', source: 'EAS', severity: 'error', time: '2026-10-08T12:00:00Z', title: 'T', labels: { platform: 'ios' }, ...over,
});

const baseConfig = {
  apps: { myapp: { name: 'My App', eas: { secret: 'x' } } },
  targets: [
    { id: 'a', type: 'slack', url: 'https://hooks.slack.com/services/a' },
    { id: 'b', type: 'discord', url: 'https://discord.com/api/webhooks/1/b' },
  ],
  routes: [
    { types: ['build.*'], targets: ['a'], mention: true },
    { types: ['*'], minSeverity: 'warning', labels: { platform: 'ios' }, targets: ['a', 'b'], silent: true },
  ],
};

void test('config: config.example.yaml parses', () => {
  const raw: unknown = parse(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8'));
  const env = {
    ASC_ISSUER_ID: 'issuer',
    ASC_KEY_ID: 'key',
    ASC_PRIVATE_KEY: ascKey,
    PLAY_SERVICE_ACCOUNT: JSON.stringify(serviceAccount),
    EAS_WEBHOOK_SECRET: 'sixteen-chars-secret',
    ASC_WEBHOOK_SECRET: 'asc-secret',
    INGEST_SECRET: 'whsec_' + Buffer.alloc(32, 7).toString('base64'),
    SLACK_RELEASES_WEBHOOK: 'https://hooks.slack.com/services/x',
    DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/1/x',
    TEAMS_WORKFLOW_URL: 'https://x.environment.api.powerplatform.com/y',
  };
  assert.equal(parseConfig(interpolate(raw, env)).routes.length, 4);
});

void test('config: loaded from STOREHERALD_CONFIG; a binding is not a value', () => {
  const yaml = 'apps: {}\ntargets: [{ id: a, type: slack, url: "${SLACK}" }]\nroutes: [{ types: ["*"], targets: [a] }]\n';
  const cfg = loadConfig({ STOREHERALD_CONFIG: yaml, SLACK: 'https://hooks.slack.com/services/x' });
  assert.deepEqual([...cfg.targets.keys()], ['a']);
  assert.throws(() => loadConfig({ STOREHERALD_CONFIG: yaml, SLACK: { get() {} } }), /SLACK is not set/);
  assert.throws(() => loadConfig({}), /STOREHERALD_CONFIG/);
});

void test('config: play settings without playApi fail loading', () => {
  const apps = { myapp: { name: 'My App', play: { packageName: 'com.acme.myapp', tracks: ['production'] } } };
  assert.throws(() => parseConfig({ ...baseConfig, apps }), /apps\.myapp\.play needs playApi/);
});

void test('config: an unknown key fails loading', () => {
  const routes = [{ types: ['*'], targets: ['a'], minseverity: 'error' }];
  assert.throws(() => parseConfig({ ...baseConfig, routes }), /unknown key\(s\) in routes\[0\]: minseverity/);
});

void test('config: errors never echo secrets', () => {
  const key = 'eyJ0eXBlIjoic2VydmljZV9hY2NvdW50IiwicHJpdmF0ZV9rZXkiOiJTRUNSRVQifQ';
  assert.throws(() => parseConfig({ ...baseConfig, playApi: { serviceAccount: key } }), (e: Error) => !e.message.includes(key));
  const pem = '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----';
  assert.throws(() => parseConfig({ ...baseConfig, ascApi: { issuerId: 'i', keyId: 'k', privateKey: pem } }),
    (e: Error) => e.message === 'config: ascApi.privateKey is not a usable private key');
  const url = 'hooks.slack.com/services/T/B/SECRET';
  assert.throws(() => parseConfig({ ...baseConfig, targets: [{ id: 'a', type: 'slack', url }] }), (e: Error) => !e.message.includes('SECRET'));
});

void test('plan: all matching routes fire; mention if any, silent only if all', () => {
  const { routes } = parseConfig(baseConfig);
  assert.deepEqual([...plan(msg(), routes)], [['a', { mention: true, silent: false }], ['b', { mention: false, silent: true }]]);
  assert.deepEqual([...plan(msg({ severity: 'success', type: 'build.succeeded' }), routes)], [['a', { mention: true, silent: false }]]);
});

void test('router: asks for a resend when no target got the message', async () => {
  let status: number | undefined = 503;
  const target: TargetInstance = {
    render: () => ({}),
    send: async () => {
      if (status) throw Object.assign(new Error('x'), { status });
    },
  };
  const { routes } = parseConfig({ ...baseConfig, routes: [{ types: ['*'], targets: ['a'] }] });
  const router = createRouter({ routes, targets: new Map([['a', target]]) });
  assert.equal(await router.deliver([msg()]), 'retry');
  status = undefined;
  assert.equal(await router.deliver([msg()]), 'ok');
});

void test('router: no resend once a target got the message, or when every failed target rejected it', async () => {
  const target = (status?: number): TargetInstance => ({
    render: () => ({}),
    send: async () => {
      if (status) throw Object.assign(new Error('x'), { status });
    },
  });
  const { routes } = parseConfig({ ...baseConfig, routes: [{ types: ['*'], targets: ['a', 'b'] }] });
  const deliver = (a: TargetInstance, b: TargetInstance) => createRouter({ routes, targets: new Map([['a', a], ['b', b]]) }).deliver([msg()]);
  // A resend would post it again where it landed.
  assert.equal(await deliver(target(503), target()), 'ok');
  // A resend can't fix a 4xx.
  assert.equal(await deliver(target(404), target(404)), 'ok');
  assert.equal(await deliver(target(503), target(404)), 'retry');
});
