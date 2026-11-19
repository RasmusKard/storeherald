#!/usr/bin/env node
// Sends one signed webhook to the local Worker of the run in $SH_RUN, the way EAS, App Store Connect or an /ingest
// caller would, and appends the request and reply to $SH_RUN/evidence/requests.jsonl.
// Usage:
//   node post.ts eas <app> <json | @file> [flags]
//   node post.ts asc <app> <json | @file> [flags]
//   node post.ts ingest <json | @file> [flags]
// Flags: --expect <status> exits 1 on another reply status; --bad-signature signs with a wrong secret;
//        --skew <seconds> shifts the /ingest timestamp (more than 300 is outside the accepted window).
import { createHmac, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Run { workerUrl: string; secrets: { eas: string; asc: string; ingest: string } }

const run = process.env.SH_RUN;
if (!run) throw new Error('SH_RUN is not set: run `control.sh launch` and export what it prints');
const cfg = JSON.parse(readFileSync(join(run, 'run.json'), 'utf8')) as Run;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, v] = args.splice(i, 2);
  return v;
};
const bad = args.includes('--bad-signature');
if (bad) args.splice(args.indexOf('--bad-signature'), 1);
const expect = flag('--expect');
const skew = Number(flag('--skew') ?? 0);

const [source, ...rest] = args;
const app = source === 'ingest' ? undefined : rest.shift();
const arg = rest[0];
if (!['eas', 'asc', 'ingest'].includes(source ?? '') || !arg || (source !== 'ingest' && !app)) {
  console.error('usage: node post.ts eas|asc <app> <json|@file> | ingest <json|@file> [--expect N] [--bad-signature] [--skew S]');
  process.exit(2);
}
const body = arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg;
const secret = (s: string) => (bad ? `${s}-wrong` : s);

let path: string;
let headers: Record<string, string>;
if (source === 'eas') {
  path = `/eas/${app}`;
  headers = { 'expo-signature': 'sha1=' + createHmac('sha1', secret(cfg.secrets.eas)).update(body).digest('hex') };
} else if (source === 'asc') {
  path = `/asc/${app}`;
  headers = { 'x-apple-signature': 'hmacsha256=' + createHmac('sha256', secret(cfg.secrets.asc)).update(body).digest('hex') };
} else {
  // Standard Webhooks, as in the README's post-event.mjs example.
  path = '/ingest';
  const id = `msg_${randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000) + skew);
  const key = Buffer.from(cfg.secrets.ingest.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', bad ? Buffer.concat([key, Buffer.from('x')]) : key).update(`${id}.${ts}.${body}`).digest('base64');
  headers = { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` };
}

const res = await fetch(cfg.workerUrl + path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
const text = await res.text();
let sent: unknown = body;
try {
  sent = JSON.parse(body);
} catch {
  // an invalid body is a valid test input: record it as text
}
appendFileSync(join(run, 'evidence', 'requests.jsonl'), JSON.stringify({
  at: new Date().toISOString(), source, path, badSignature: bad, skew, body: sent, status: res.status, reply: text,
}) + '\n');
console.log(`POST ${path} -> ${res.status} ${text}`);
if (expect && Number(expect) !== res.status) {
  console.error(`expected ${expect}, got ${res.status}`);
  process.exit(1);
}
