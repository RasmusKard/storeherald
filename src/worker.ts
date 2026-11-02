import { loadConfig, type Config } from './config.ts';
import { log } from './log.ts';
import { createRouter, type Router } from './router.ts';
import type { Message } from './message.ts';
import { ascMessages, isAscEvent, verifyAsc } from './sources/asc.ts';
import { easToMessages, isEasPayload, verifyEas } from './sources/eas.ts';
import { ingestToMessage, verifyIngest } from './sources/ingest.ts';
import { pollPlay, type StateStore } from './sources/play.ts';

const MAX_BODY = 1024 * 1024;

// Its own class, so only errors meant for the sender reach the response: delivery errors can quote a target's reply.
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const httpError = (status: number, message: string) => new HttpError(status, message);

/** Raw bytes, needed for HMAC checks. Capped well below the Workers platform limit, which is sized for uploads. */
async function readBody(req: Request): Promise<Buffer> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw httpError(413, 'body too large');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'body too large'); // chunked uploads have no content-length
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(raw: Buffer): any {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON');
  }
}

const header = (req: Request, name: string) => req.headers.get(name) ?? undefined;

function ingest(cfg: Config, req: Request, raw: Buffer): Message[] {
  if (!cfg.ingest) throw httpError(404, 'not found');
  const h = { id: header(req, 'webhook-id'), timestamp: header(req, 'webhook-timestamp'), signature: header(req, 'webhook-signature') };
  if (!verifyIngest(raw, h, cfg.ingest.secret)) throw httpError(401, 'bad signature');
  const m = ingestToMessage(h.id!, json(raw));
  if (typeof m === 'string') throw httpError(400, m);
  return [m];
}

/** Verify the signature on the raw bytes before parsing. */
async function handle(cfg: Config, req: Request, path: string[]): Promise<Message[]> {
  const [source, appId] = path;
  const raw = await readBody(req);
  if (source === 'ingest' && path.length === 1) return ingest(cfg, req, raw);

  const app = appId ? cfg.apps.get(appId) : undefined;
  if (path.length !== 2 || !app) throw httpError(404, 'not found');

  if (source === 'eas' && app.eas) {
    if (!verifyEas(raw, header(req, 'expo-signature'), app.eas.secret)) throw httpError(401, 'bad signature');
    const payload = json(raw);
    if (!isEasPayload(payload)) throw httpError(400, 'not an EAS build or submission webhook');
    return easToMessages(payload, app);
  }
  if (source === 'asc' && app.asc) {
    if (!verifyAsc(raw, header(req, 'x-apple-signature'), app.asc.secret)) throw httpError(401, 'bad signature');
    const event = json(raw);
    if (!isAscEvent(event)) throw httpError(400, 'not an App Store Connect event');
    return ascMessages(event, app, cfg.ascApi);
  }
  throw httpError(404, 'not found');
}

export interface Env {
  STOREHERALD_CONFIG: string;
  /** KV namespace for the Google Play states seen. Required when Play is polled. */
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname.split('/').filter(Boolean);
    let status = 200;
    let text = 'ok';
    try {
      const { cfg, router } = init(env); // also on health checks, so a broken config fails them
      if (req.method === 'POST') {
        if ((await router.deliver(await handle(cfg, req, path))) === 'retry') [status, text] = [503, 'delivery failed, please retry'];
      } else if (!(req.method === 'GET' && path.join('/') === 'health_check')) throw httpError(404, 'not found'); // not 405: keeps bot probes (GET /, /favicon.ico) out of the warn log
    } catch (err) {
      if (err instanceof HttpError) {
        [status, text] = [err.status, err.message];
        if (status !== 404) log('warn', 'request rejected', { path: path[0], status, reason: text });
      } else {
        [status, text] = [500, 'internal error'];
        log('error', 'request failed', { path: path[0], err: String(err) });
      }
    }
    return new Response(text, { status, headers: { 'content-type': 'text/plain' } });
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const { cfg, router } = init(env);
    if (cfg.playApi && !env.STATE) return log('error', 'no STATE KV binding: Google Play is not polled');
    await pollPlay(cfg, router, env.STATE!); // only read when playApi is set
  },
};
