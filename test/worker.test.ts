// End to end: run the Worker in local workerd with a config pointing a Slack target at a local fake, then post signed webhooks.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { unstable_dev } from 'wrangler';

void test('worker in workerd: health check, signed webhooks are delivered, bad signatures rejected', async (t) => {
  const posts: { text: string }[] = [];
  const slack = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    posts.push(JSON.parse(body) as { text: string });
    res.end('ok');
  });
  await new Promise<void>((r) => slack.listen(0, r));
  t.after(() => slack.close());

  const dir = mkdtempSync(join(tmpdir(), 'ews-'));
  const ingestKey = randomBytes(32);
  const worker = await unstable_dev('src/worker.ts', {
    config: 'wrangler.jsonc',
    logLevel: 'none',
    experimental: { disableExperimentalWarning: true },
    vars: {
      EAS_SECRET: 'sixteen-chars-secret',
      STOREHERALD_CONFIG: `
apps:
  myapp:
    name: My App
    eas: { secret: "\${EAS_SECRET}" }
    asc: { secret: asc-secret }
ingest: { secret: "whsec_${ingestKey.toString('base64')}" }
targets:
  - { id: releases, type: slack, url: "http://127.0.0.1:${(slack.address() as any).port}/hook" }
routes:
  - { types: ["build.*", "update.published"], targets: [releases] }
`,
    },
  });
  t.after(() => worker.stop());
  const base = `http://${worker.address}:${worker.port}`;
  const post = (path: string, body: string, headers: Record<string, string>) =>
    fetch(`${base}${path}`, { method: 'POST', body, headers }).then((r) => r.status);

  assert.equal((await fetch(`${base}/health_check`)).status, 200);

  const eas = JSON.stringify({ id: 'b1', buildDetailsPageUrl: 'https://expo.dev/b1', platform: 'ios', status: 'finished', metadata: { appVersion: '1.0.0' } });
  assert.equal(await post('/eas/myapp', eas, { 'expo-signature': 'sha1=bad' }), 401);
  assert.equal(await post('/eas/myapp', eas, { 'expo-signature': 'sha1=' + createHmac('sha1', 'sixteen-chars-secret').update(eas).digest('hex') }), 200);
  assert.match(posts[0].text, /iOS build succeeded: My App 1\.0\.0/);

  // App Store Connect "Test" button: body undocumented, so assume the bare minimum and expect a quiet 200.
  const ping = JSON.stringify({ data: { type: 'webhookPingCreated', id: 'p1' } });
  assert.equal(await post('/asc/myapp', ping, { 'x-apple-signature': 'hmacsha256=' + createHmac('sha256', 'asc-secret').update(ping).digest('hex') }), 200);
  assert.equal(posts.length, 1);

  // The post-event.mjs example from README.md, verbatim. Async: a sync spawn would block the fake Slack above.
  const example = readFileSync('README.md', 'utf8').match(/```js\n(\/\/ post-event\.mjs:[\s\S]*?)```/)![1];
  writeFileSync(join(dir, 'post-event.mjs'), example);
  const update = JSON.stringify({ type: 'update.published', title: 'OTA update published' });
  await promisify(execFile)(process.execPath, [join(dir, 'post-event.mjs'), update], {
    env: { ...process.env, INGEST_URL: `${base}/ingest`, INGEST_SECRET: `whsec_${ingestKey.toString('base64')}` },
  });
  assert.match(posts[1].text, /OTA update published/);
});
