import { createRequire } from 'node:module';

// node:sqlite is loaded through require so Vite does not try to bundle the built-in.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// Just enough of D1's API (prepare/bind/first/run/all/batch) on top of an in-memory SQLite.
export function makeD1(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt;
      },
      async first() {
        return (sqlite.prepare(sql).get(...(params as never[])) as unknown) ?? null;
      },
      async run() {
        sqlite.prepare(sql).run(...(params as never[]));
        return { success: true, meta: {} };
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...(params as never[])), success: true, meta: {} };
      },
    };
    return stmt;
  };
  const db = {
    prepare,
    async batch(stmts: Array<{ run(): Promise<unknown> }>) {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
  return db as unknown as D1Database;
}

// A made-up brand: the real one only ever lives in the private MONITOR_CONFIG secret.
export const TEST_MONITOR = {
  brandName: 'ExampleCo',
  brandTerms: ['ExampleCo', '@ExampleCo', '@ExampleCoHelp'],
  ownAccounts: ['ExampleCo', 'ExampleCoHelp'],
};

export function testEnv(over: Record<string, string> = {}): Env {
  return {
    DB: makeD1(),
    MONITOR_CONFIG: JSON.stringify(TEST_MONITOR),
    LARK_MODE: 'webhook',
    X_API_BASE: 'https://x.test',
    LARK_API_BASE: 'https://lark.test',
    FIRST_RUN_LOOKBACK_MINUTES: '30',
    LOW_CREDIT_USD: '10',
    HEARTBEAT_HOUR_UTC: '',
    X_BEARER_TOKEN: 'x-token-secret',
    LARK_WEBHOOK_URL: 'https://lark.test/hook/abc',
    LARK_WEBHOOK_SECRET: '',
    LARK_APP_ID: '',
    LARK_APP_SECRET: '',
    LARK_CHAT_ID: '',
    LARK_VERIFICATION_TOKEN: '',
    ...over,
  } as Env;
}

export const appEnv = (over: Record<string, string> = {}): Env =>
  testEnv({
    LARK_MODE: 'app',
    LARK_APP_ID: 'cli_test',
    LARK_APP_SECRET: 'app-secret',
    LARK_CHAT_ID: 'oc_chat',
    LARK_VERIFICATION_TOKEN: 'verify-me',
    ...over,
  });

export interface TestPost {
  id: string;
  text: string;
  user?: string;
  followers?: number;
  likes?: number;
  reposts?: number;
}

export function searchBody(posts: TestPost[]) {
  const users = new Map<string, { id: string; username: string; public_metrics: { followers_count: number } }>();
  for (const p of posts) {
    const username = p.user ?? 'alice';
    users.set(username, { id: `u_${username}`, username, public_metrics: { followers_count: p.followers ?? 100 } });
  }
  const newest = posts.reduce<string | null>((m, p) => (m === null || BigInt(p.id) > BigInt(m) ? p.id : m), null);
  return {
    data: posts.map((p) => ({
      id: p.id,
      text: p.text,
      created_at: '2026-10-22T13:58:00.000Z',
      author_id: `u_${p.user ?? 'alice'}`,
      public_metrics: { like_count: p.likes ?? 0, retweet_count: p.reposts ?? 0 },
    })),
    includes: { users: [...users.values()] },
    meta: { newest_id: newest ?? undefined, result_count: posts.length },
  };
}

export interface SentToLark {
  kind: 'card' | 'text';
  card?: Record<string, any>;
  text?: string;
  raw: Record<string, any>;
}

// A fake internet: X and Lark in one place, with knobs to make either of them misbehave.
export class World {
  searchCalls: URL[] = [];
  creditCalls = 0;
  sent: SentToLark[] = [];
  larkCalls = 0;
  posts: TestPost[] = [];
  xStatus = 200;
  xErrorBody: unknown = { title: 'Payment Required', detail: 'Your credits are depleted', type: 'about:blank' };
  creditBalance: number | null = 50;
  larkOkCount = Infinity; // how many Lark sends succeed before every later one fails
  larkTokenCalls = 0;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

    if (url.hostname === 'x.test') {
      if (url.pathname === '/2/tweets/search/recent') {
        this.searchCalls.push(url);
        if (this.xStatus !== 200) return json(this.xErrorBody, this.xStatus);
        return json(searchBody(this.posts));
      }
      if (url.pathname === '/2/usage/credits') {
        this.creditCalls++;
        if (this.creditBalance === null) return json({ title: 'Forbidden' }, 403);
        return json({ data: { total_balance: this.creditBalance, prepaid_balance: this.creditBalance, free_balance: 0, free_grants: [] } });
      }
    }
    if (url.hostname === 'lark.test') {
      if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
        this.larkTokenCalls++;
        return json({ code: 0, msg: 'ok', tenant_access_token: 't-abc', expire: 7200 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
      const isHook = url.pathname.startsWith('/hook/');
      const isMessage = url.pathname === '/open-apis/im/v1/messages';
      if (isHook || isMessage) {
        this.larkCalls++;
        if (this.larkCalls > this.larkOkCount) return json({ code: 19021, msg: 'sign match fail' }, 400);
        if (isMessage) {
          const content = JSON.parse(body.content as string) as Record<string, any>;
          this.sent.push(
            body.msg_type === 'interactive'
              ? { kind: 'card', card: content, raw: body }
              : { kind: 'text', text: content.text as string, raw: body },
          );
        } else {
          this.sent.push(
            body.msg_type === 'interactive'
              ? { kind: 'card', card: body.card as Record<string, any>, raw: body }
              : { kind: 'text', text: (body.content as { text: string }).text, raw: body },
          );
        }
        return json({ code: 0, msg: 'success' });
      }
    }
    return json({ error: `unexpected request ${url.href}` }, 500);
  };

  cards = () => this.sent.filter((s) => s.kind === 'card');
  texts = () => this.sent.filter((s) => s.kind === 'text').map((s) => s.text ?? '');
}
