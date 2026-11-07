import { loadConfig, type Config, type ConfigIngest } from './config.ts';
import { log } from './log.ts';
import { createRouter, type Router } from './router.ts';
import type { Message } from './message.ts';
import { ascMessages, isAscEvent, pollAsc, verifyAsc } from './sources/asc.ts';
import { easToMessages, isEasPayload, verifyEas } from './sources/eas.ts';
import { ingestToMessage, verifyIngest } from './sources/ingest.ts';
import { pollPlay } from './sources/play.ts';
import type { StateStore } from './sources/shared.ts';

const MAX_BODY = 1024 * 1024;

// Its own class, so only errors meant for the sender reach the response: delivery errors can quote a target's reply.
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Raw bytes, needed for HMAC checks. Capped well below the Workers platform limit, which is sized for uploads. */
async function readBody(req: Request): Promise<Buffer> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw new HttpError(413, 'body too large');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large'); // chunked uploads have no content-length
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const header = (req: Request, name: string) => req.headers.get(name) ?? undefined;

function ingest(ing: ConfigIngest, req: Request, raw: Buffer): Message[] {
  const h = { id: header(req, 'webhook-id'), timestamp: header(req, 'webhook-timestamp'), signature: header(req, 'webhook-signature') };
  if (!verifyIngest(raw, h, ing.secret)) throw new HttpError(401, 'bad signature');
  const m = ingestToMessage(h.id!, json(raw));
  if (typeof m === 'string') throw new HttpError(400, m);
  return [m];
}

/** Verify the signature on the raw bytes before parsing. */
async function handle(cfg: Config, req: Request, path: string[]): Promise<Message[]> {
  const [source, appId] = path;
  if (source === 'ingest' && path.length === 1 && cfg.ingest) return ingest(cfg.ingest, req, await readBody(req));

  const app = appId ? cfg.apps.get(appId) : undefined;
  if (path.length !== 2 || !app) throw new HttpError(404, 'not found');

  if (source === 'eas' && app.eas) {
    const raw = await readBody(req);
    if (!verifyEas(raw, header(req, 'expo-signature'), app.eas.secret)) throw new HttpError(401, 'bad signature');
    const payload = json(raw);
    if (!isEasPayload(payload)) throw new HttpError(400, 'not an EAS build or submission webhook');
    return easToMessages(payload, app);
  }
  if (source === 'asc' && app.asc) {
    const raw = await readBody(req);
    if (!verifyAsc(raw, header(req, 'x-apple-signature'), app.asc.secret)) throw new HttpError(401, 'bad signature');
    const event = json(raw);
    if (!isAscEvent(event)) throw new HttpError(400, 'not an App Store Connect event');
    return await ascMessages(event, app, cfg.ascApi);
  }
  throw new HttpError(404, 'not found');
}

export interface Env {
  STOREHERALD_CONFIG: string;
  /** KV namespace for what the pollers have seen. Required when Google Play or App Store Connect is polled. */
  STATE?: StateStore;
  [name: string]: unknown; // the variables and secrets the config references
}

// Parsed once per isolate; env doesn't change within one.
let app: { cfg: Config; router: Router } | undefined;
function init(env: Env) {
  if (!app) {
    const cfg = loadConfig(env);
    app = { cfg, router: createRouter(cfg) };
  }
  return app;
}

const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname.split('/').filter(Boolean);
    try {
      const { cfg, router } = init(env); // also on health checks, so a broken config fails them
      if (req.method === 'GET' && path.join('/') === 'health_check') return text('ok');
      if (req.method !== 'POST') throw new HttpError(404, 'not found'); // not 405: keeps bot probes (GET /, /favicon.ico) out of the warn log
      return (await router.deliver(await handle(cfg, req, path))) === 'retry' ? text('delivery failed, please retry', 503) : text('ok');
    } catch (err) {
      if (!(err instanceof HttpError)) {
        log('error', 'request failed', { path: path[0], err: String(err) });
        return text('internal error', 500);
      }
      if (err.status !== 404) log('warn', 'request rejected', { path: path[0], status: err.status, reason: err.message });
      return text(err.message, err.status);
    }
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    try {
      const { cfg, router } = init(env);
      await pollPlay(cfg, router, env.STATE);
      await pollAsc(cfg, router, env.STATE);
    } catch (err) {
      log('error', 'cron run failed', { err: String(err) }); // as a log line, so error alerts see a broken config here too
    }
  },
};
