import { buildAppCard, buildWebhookCard } from './card';
import type { Case } from './cases';
import type { Config } from './env';

export interface Sender {
  sendCard(c: Case): Promise<void>;
  sendText(text: string): Promise<void>;
}

// Never carries the webhook URL, tokens or secrets: only Lark's own code and message.
export class LarkError extends Error {
  constructor(readonly code: number | string, message: string) {
    super(`Lark error ${code}: ${message}`);
  }
}

const TIMEOUT_MS = 10_000;

interface LarkReply {
  code?: number;
  msg?: string;
  StatusCode?: number;
  tenant_access_token?: string;
}

async function postJson(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<LarkReply> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LarkError('network', err instanceof Error ? err.message : 'request failed');
  }
  let reply: LarkReply | null = null;
  try {
    reply = (await res.json()) as LarkReply;
  } catch {
    // handled below
  }
  const code = reply?.code ?? reply?.StatusCode;
  if (!res.ok || code !== 0) throw new LarkError(code ?? res.status, reply?.msg ?? 'unexpected response');
  return reply ?? {};
}

// Custom-bot signature: HMAC-SHA256 keyed with "timestamp\nsecret" over an empty message, base64.
export async function webhookSign(timestamp: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${timestamp}\n${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array(0)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

function webhookSender(cfg: Config, fetchFn: typeof fetch, nowSec: () => number): Sender {
  const hook = cfg.webhook;
  if (!hook) throw new Error('webhook sender needs LARK_WEBHOOK_URL');
  const send = async (payload: Record<string, unknown>) => {
    const signed: Record<string, unknown> = { ...payload };
    if (hook.secret) {
      const timestamp = String(nowSec());
      signed.timestamp = timestamp;
      signed.sign = await webhookSign(timestamp, hook.secret);
    }
    await postJson(fetchFn, hook.url, signed);
  };
  return {
    sendCard: (c) => send({ msg_type: 'interactive', card: buildWebhookCard(c) }),
    sendText: (text) => send({ msg_type: 'text', content: { text } }),
  };
}

function appSender(cfg: Config, fetchFn: typeof fetch): Sender {
  const app = cfg.app;
  if (!app) throw new Error('app sender needs LARK_APP_ID, LARK_APP_SECRET and LARK_CHAT_ID');
  let token: string | null = null; // one token per run is plenty

  const getToken = async (): Promise<string> => {
    if (token) return token;
    const reply = await postJson(fetchFn, `${cfg.larkBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      app_id: app.id,
      app_secret: app.secret,
    });
    if (!reply.tenant_access_token) throw new LarkError('token', 'no tenant_access_token in response');
    token = reply.tenant_access_token;
    return token;
  };

  const send = async (msgType: 'interactive' | 'text', content: unknown, uuid?: string) => {
    const t = await getToken();
    await postJson(
      fetchFn,
      `${cfg.larkBase}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      { receive_id: app.chatId, msg_type: msgType, content: JSON.stringify(content), ...(uuid ? { uuid } : {}) },
      { authorization: `Bearer ${t}` },
    );
  };

  return {
    // uuid makes Lark drop a repeated send of the same post within an hour.
    sendCard: (c) => send('interactive', buildAppCard(c), `x-${c.id}`),
    sendText: (text) => send('text', { text }),
  };
}

export function makeSender(cfg: Config, fetchFn: typeof fetch, nowSec: () => number): Sender {
  return cfg.mode === 'app' ? appSender(cfg, fetchFn) : webhookSender(cfg, fetchFn, nowSec);
}
