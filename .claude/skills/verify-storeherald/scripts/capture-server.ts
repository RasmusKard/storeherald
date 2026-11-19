#!/usr/bin/env node
// Stand-in for the Slack, Discord and Teams webhooks: logs every request as one JSON line, never forwards anything.
// Usage: node capture-server.ts <out.jsonl> <port>   (listens on 127.0.0.1:<port>)
// Replies like the real hosts: /teams/* 202, anything else 200 "ok".
// /status/<code>/... replies <code>, to stand in for a target that is down (5xx, 429) or rejects the post (4xx).
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [out, port] = process.argv.slice(2);
if (!out || !port) {
  console.error('usage: node capture-server.ts <out.jsonl> <port>');
  process.exit(2);
}

function parsed(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // not JSON: keep the text as captured
  }
}

const server = createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c: string) => (raw += c));
  req.on('end', () => {
    const path = req.url ?? '/';
    if (req.method === 'GET' && path === '/__health') return void res.end(JSON.stringify({ capture: true, pid: process.pid, out }));

    const forced = /^\/status\/(\d{3})\//.exec(path);
    const status = forced ? Number(forced[1]) : path.startsWith('/teams/') ? 202 : 200;
    appendFileSync(out, JSON.stringify({
      at: new Date().toISOString(), method: req.method, path, status,
      contentType: req.headers['content-type'], userAgent: req.headers['user-agent'], body: parsed(raw),
    }) + '\n');
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(status === 200 ? 'ok' : status < 300 ? '' : `capture: forced ${status}`);
  });
});

server.listen(Number(port), '127.0.0.1', () => {
  console.log(`capture listening on http://127.0.0.1:${port}, logging to ${out}`);
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)));
