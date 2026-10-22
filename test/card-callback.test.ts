import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAppCard, buildWebhookCard } from '../src/card';
import { applyUpdate, type Case } from '../src/cases';
import { handleLarkCallback } from '../src/callback';
import { getCase } from '../src/db';
import { webhookSign } from '../src/lark';
import { runMonitor } from '../src/monitor';
import { appEnv, World } from './helpers';

const NOW = Date.UTC(2026, 9, 22, 14, 0, 0);

const baseCase: Case = {
  id: '123',
  createdAt: NOW,
  postedAt: '2026-10-22T13:58:00.000Z',
  username: 'alice',
  followers: 1_200,
  likes: 3,
  reposts: 1,
  text: 'ExampleCo withdrawal stuck test',
  category: 'funds',
  priority: 'P2',
  suggested: 'Reply',
  status: 'New',
  action: '',
  history: [],
};

describe('applyUpdate', () => {
  it('records who changed the status and when', () => {
    const next = applyUpdate(baseCase, 'status', 'Replied', 'ou_abc', NOW)!;
    expect(next.status).toBe('Replied');
    expect(next.history).toEqual([{ by: 'ou_abc', at: NOW, field: 'status', to: 'Replied' }]);
  });
  it('Ignore also closes the case', () => {
    const next = applyUpdate(baseCase, 'action', 'Ignore', 'ou_abc', NOW)!;
    expect(next.action).toBe('Ignore');
    expect(next.status).toBe('Closed');
    expect(next.history.map((h) => h.to)).toEqual(['Ignore', 'Closed']);
  });
  it('returns null for no-ops and for values that are not real choices', () => {
    expect(applyUpdate(baseCase, 'status', 'New', 'ou_abc', NOW)).toBeNull();
    expect(applyUpdate(baseCase, 'status', 'Deleted', 'ou_abc', NOW)).toBeNull();
    expect(applyUpdate(baseCase, 'action', 'Fix', 'ou_abc', NOW)).toBeNull();
  });
  it('keeps only the last 8 history entries', () => {
    let c = baseCase;
    for (let i = 0; i < 12; i++) c = applyUpdate(c, 'status', i % 2 ? 'Waiting' : 'Replied', 'ou_abc', NOW + i)!;
    expect(c.history).toHaveLength(8);
  });
});

describe('card content', () => {
  it('shows who last set the status and the action, by name', () => {
    let c = applyUpdate(baseCase, 'status', 'Replied', 'ou_sara1', NOW)!;
    c = applyUpdate(c, 'action', 'Escalate', 'ou_ali22', NOW + 60_000)!;
    const body = JSON.stringify(buildAppCard(c));
    expect(body).toContain("**Status:** Replied — <person id='ou_sara1' show_name=true");
    expect(body).toContain("**Action:** Escalate — <person id='ou_ali22' show_name=true");
    expect(body).toContain('14:00 UTC');
  });

  it('has a callback button per action and status, carrying only ids and choices', () => {
    const buttons: any[] = [];
    const walk = (n: any) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        if (n.tag === 'button') buttons.push(n);
        Object.values(n).forEach(walk);
      }
    };
    walk(buildAppCard(baseCase));
    expect(buttons.map((b) => b.text.content)).toEqual([
      'Reply', 'Ignore', 'Escalate', 'Legal review', 'Replied', 'Waiting', 'Closed',
    ]);
    expect(buttons[0].behaviors[0]).toEqual({ type: 'callback', value: { c: '123', k: 'action', v: 'Reply' } });
  });

  it('keeps hostile post text out of markdown (no @all, no links)', () => {
    const hostile = { ...baseCase, text: '<at id=all></at> [click](https://evil.example) **hi**', username: 'a](https://evil.example)' };
    const card = buildAppCard(hostile) as any;
    const markdown = card.body.elements.filter((e: any) => e.tag === 'markdown').map((e: any) => e.content).join('\n');
    expect(markdown).not.toContain('evil.example');
    expect(markdown).not.toContain('<at');
    const plain = card.body.elements.find((e: any) => e.tag === 'div');
    expect(plain.text.tag).toBe('plain_text');
    expect(plain.text.content).toContain('<at id=all></at>'); // shown as text, never interpreted
    const legacy = buildWebhookCard(hostile) as any;
    expect(legacy.elements[0].text.content).not.toContain('evil.example');
  });

  it('webhook cards have no callback buttons, only a link to the post', () => {
    const card = buildWebhookCard(baseCase) as any;
    expect(JSON.stringify(card)).not.toContain('callback');
    expect(card.elements[2].actions[0].url).toBe('https://x.com/alice/status/123');
  });

  it('shows a different title and colour once closed', () => {
    const closed = applyUpdate(baseCase, 'status', 'Closed', 'ou_abc', NOW)!;
    const card = buildAppCard(closed) as any;
    expect(card.header.title.content).toBe('X MENTION · CLOSED · P2');
    expect(card.header.template).toBe('grey');
  });
});

// ---- the Lark callback endpoint ---------------------------------------------------------------

async function seededApp() {
  const env = appEnv();
  const world = new World();
  world.posts = [{ id: '9001', text: 'ExampleCo withdrawal stuck test' }];
  await runMonitor(env, { fetchFn: world.fetch, now: () => NOW });
  return env;
}

const click = (token: string, value: unknown, openId = 'ou_sara1') =>
  new Request('https://worker.test/lark/callback', {
    method: 'POST',
    body: JSON.stringify({
      schema: '2.0',
      header: { event_id: 'e1', token, event_type: 'card.action.trigger', app_id: 'cli_test' },
      event: { operator: { open_id: openId }, action: { value, tag: 'button' }, context: { open_message_id: 'om_1' } },
    }),
  });

describe('card button callback', () => {
  it('updates the case, and answers with the new card showing who did it', async () => {
    const env = await seededApp();
    const res = await handleLarkCallback(click('verify-me', { c: '9001', k: 'status', v: 'Replied' }), env, NOW + 1000);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.toast.type).toBe('success');
    expect(body.card.type).toBe('raw');
    expect(JSON.stringify(body.card.data)).toContain("<person id='ou_sara1'");
    const stored = await getCase(env.DB, '9001');
    expect(stored?.status).toBe('Replied');
    expect(stored?.history[0]?.by).toBe('ou_sara1');
  });

  it('rejects a wrong or missing verification token and changes nothing', async () => {
    const env = await seededApp();
    const bad = await handleLarkCallback(click('nope', { c: '9001', k: 'status', v: 'Closed' }), env);
    expect(bad.status).toBe(401);
    const none = await handleLarkCallback(new Request('https://worker.test/lark/callback', { method: 'POST', body: '{}' }), env);
    expect(none.status).toBe(401);
    expect((await getCase(env.DB, '9001'))?.status).toBe('New');
  });

  it('answers the one-time url_verification challenge', async () => {
    const env = await seededApp();
    const res = await handleLarkCallback(
      new Request('https://worker.test/lark/callback', {
        method: 'POST',
        body: JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 'verify-me' }),
      }),
      env,
    );
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('refuses garbage buttons and unknown cases without touching the store', async () => {
    const env = await seededApp();
    const bad = (await (await handleLarkCallback(click('verify-me', { c: '9001; DROP', k: 'status', v: 'Closed' }), env)).json()) as any;
    expect(bad.toast.type).toBe('error');
    const unknown = (await (await handleLarkCallback(click('verify-me', { c: '424242', k: 'status', v: 'Closed' }), env)).json()) as any;
    expect(unknown.toast.content).toContain('no longer tracked');
    const weird = (await (await handleLarkCallback(click('verify-me', { c: '9001', k: 'status', v: 'Banana' }), env)).json()) as any;
    expect(weird.toast.type).toBe('error');
    const same = (await (await handleLarkCallback(click('verify-me', { c: '9001', k: 'status', v: 'New' }), env)).json()) as any;
    expect(same.toast.content).toBe('Already set');
    expect((await getCase(env.DB, '9001'))?.status).toBe('New');
  });

  it('is off in webhook mode', async () => {
    const env = await seededApp();
    env.LARK_MODE = 'webhook';
    const res = await handleLarkCallback(click('verify-me', { c: '9001', k: 'status', v: 'Closed' }), env);
    expect(res.status).toBe(404);
  });
});

describe('webhook signature', () => {
  it('matches an independent HMAC-SHA256 of an empty message keyed with "timestamp\\nsecret"', async () => {
    const expected = createHmac('sha256', '1599360473\nmy-secret').update('').digest('base64');
    expect(await webhookSign('1599360473', 'my-secret')).toBe(expected);
  });
});
