#!/usr/bin/env node
// Writes and checks a verification run's config. Called by control.sh; see SKILL.md.
//   node run-config.ts prepare <run-dir>  picks free ports and test secrets, writes <run-dir>/dev.env and run.json
//   node run-config.ts check <run-dir>    exits 1 unless every target in dev.env posts to the run's capture server
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';

const skill = join(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, run] = process.argv.slice(2);
if (!run || (mode !== 'prepare' && mode !== 'check')) {
  console.error('usage: node run-config.ts prepare|check <run-dir>');
  process.exit(2);
}

/** Throws unless the config can only post to the capture server and calls no Apple or Google API. */
function assertLocal(yamlText: string, captureUrl: string) {
  const cfg = parse(yamlText) as { targets?: { id?: string; url?: unknown }[]; ascApi?: unknown; playApi?: unknown; apps?: Record<string, { play?: unknown; asc?: { appId?: unknown } }> };
  if (cfg.ascApi || cfg.playApi) throw new Error('config has ascApi or playApi: the Worker would call Apple or Google');
  for (const [id, app] of Object.entries(cfg.apps ?? {}))
    if (app.play || app.asc?.appId) throw new Error(`apps.${id} is polled (play or asc.appId): the poller would call Apple or Google`);
  const targets = cfg.targets ?? [];
  if (!targets.length) throw new Error('config has no targets');
  for (const t of targets)
    if (typeof t.url !== 'string' || !t.url.startsWith(`${captureUrl}/`)) throw new Error(`target ${t.id} does not post to ${captureUrl}/`);
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

if (mode === 'prepare') {
  const [capturePort, workerPort, inspectorPort] = [await freePort(), await freePort(), await freePort()];
  const captureUrl = `http://127.0.0.1:${capturePort}`;
  const secrets = {
    eas: randomBytes(16).toString('hex'),
    asc: randomBytes(16).toString('hex'),
    ingest: `whsec_${randomBytes(32).toString('base64')}`,
  };
  const yamlText = readFileSync(join(skill, 'fixtures', 'config.yaml'), 'utf8').replaceAll('@CAPTURE@', captureUrl);
  assertLocal(yamlText, captureUrl);
  if (yamlText.includes('`')) throw new Error('fixtures/config.yaml must not contain a backtick: dev.env quotes it with backticks');
  // Wrangler expands ${VAR} in env files itself, so escape it to leave the Worker's own interpolation to the Worker (README).
  writeFileSync(join(run, 'dev.env'), [
    `STOREHERALD_CONFIG=\`${yamlText.replaceAll('${', '\\${')}\``,
    `EAS_WEBHOOK_SECRET=${secrets.eas}`,
    `ASC_WEBHOOK_SECRET=${secrets.asc}`,
    `INGEST_SECRET=${secrets.ingest}`,
    '',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(join(run, 'evidence', 'config.yaml'), yamlText); // what the run posted with: ${VAR} refs only, no secret values
  writeFileSync(join(run, 'run.json'), JSON.stringify({
    run, captureUrl, capturePort, workerUrl: `http://127.0.0.1:${workerPort}`, workerPort, inspectorPort, secrets,
  }, null, 2) + '\n', { mode: 0o600 });
  console.log(`prepared ${run}`);
} else {
  const { captureUrl } = JSON.parse(readFileSync(join(run, 'run.json'), 'utf8')) as { captureUrl: string };
  const envFile = join(run, 'dev.env');
  if (!existsSync(envFile)) throw new Error(`${envFile} is gone: the run was cleaned up`);
  const cfg = parseEnv(readFileSync(envFile, 'utf8')).STOREHERALD_CONFIG;
  if (!cfg) throw new Error('dev.env has no STOREHERALD_CONFIG');
  assertLocal(cfg.replaceAll('\\${', '${'), captureUrl);
  console.log(`ok   config: every target posts to ${captureUrl}/, no Apple or Google API configured`);
}
