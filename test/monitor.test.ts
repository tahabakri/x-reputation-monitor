import { describe, expect, it } from 'vitest';
import { getMeta } from '../src/db';
import { runMonitor } from '../src/monitor';
import { appEnv, TEST_MONITOR, testEnv, World } from './helpers';

const T0 = Date.UTC(2026, 9, 22, 14, 0, 0);

function setup(env = testEnv()) {
  const world = new World();
  let now = T0;
  const run = () => runMonitor(env, { fetchFn: world.fetch, now: () => now });
  return { env, world, run, advance: (ms: number) => (now += ms) };
}

describe('a normal cycle', () => {
  it('first run looks back a short while only, posts new cases, and stores the cursor', async () => {
    const { env, world, run } = setup();
    world.posts = [
      { id: '1002', text: 'ExampleCo withdrawal stuck test', user: 'alice' },
      { id: '1001', text: 'ExampleCo scam, avoid', user: 'bob', followers: 20_000 },
    ];
    const summary = await run();

    const first = world.searchCalls[0]!;
    expect(first.searchParams.get('since_id')).toBeNull();
    expect(first.searchParams.get('start_time')).toBe('2026-10-22T13:30:00Z'); // 30 min before now
    expect(first.searchParams.get('query')).toContain('ExampleCo');
    expect(first.searchParams.get('max_results')).toBe('100');
    expect(first.searchParams.get('post.fields')).toContain('public_metrics');

    expect(summary.alerts).toBe(2);
    // oldest first
    expect(world.cards().map((c) => c.card!.header.title.content)).toEqual([
      'NEW X MENTION · P1', // bob: scam allegation from a 20k account
      'NEW X MENTION · P3', // alice: ordinary funds complaint
    ]);
    expect(await getMeta(env.DB, 'cursor')).toBe('1002');
  });

  it('later runs ask only for posts after the cursor, and never alert the same post twice', async () => {
    const { world, run } = setup();
    world.posts = [{ id: '2001', text: 'ExampleCo frozen account' }];
    await run();
    world.posts = [{ id: '2001', text: 'ExampleCo frozen account' }]; // X returns it again
    const again = await run();

    const second = world.searchCalls[1]!;
    expect(second.searchParams.get('since_id')).toBe('2001');
    expect(second.searchParams.get('start_time')).toBeNull();
    expect(again.alerts).toBe(0);
    expect(again.duplicates).toBe(1);
    expect(world.cards()).toHaveLength(1);
  });

  it('skips our own accounts and promo noise but still moves the cursor past them', async () => {
    const { env, world, run } = setup();
    world.posts = [
      { id: '3003', text: 'ExampleCo airdrop is live', user: 'spammer' },
      { id: '3002', text: 'ExampleCo frozen? we are on it', user: 'ExampleCoHelp' },
      { id: '3001', text: 'ExampleCo locked my account', user: 'carol' },
    ];
    const summary = await run();
    expect(summary.alerts).toBe(1);
    expect(summary.promoDropped).toBe(1);
    expect(world.cards()).toHaveLength(1);
    expect(await getMeta(env.DB, 'cursor')).toBe('3003');
  });

  it('drops posts X matched on the author handle or a link, not on the visible text', async () => {
    const { env, world, run } = setup();
    world.posts = [
      { id: '3203', text: 'Daily market news: BTC back above 80k https://t.co/abc', user: 'ExampleCo_Fans' }, // brand only in the handle
      { id: '3202', text: 'ExampleCo is great, see you at the event', user: 'dave' }, // brand, but no complaint word
      { id: '3201', text: 'Is this bot actually neutral? https://t.co/xyz', user: 'erin' }, // neither in the text
    ];
    const summary = await run();
    expect(summary.alerts).toBe(0);
    expect(summary.irrelevantDropped).toBe(3);
    expect(await getMeta(env.DB, 'cursor')).toBe('3203');
  });

  it('skips ignoreAccounts (affiliates) after the pull, without lengthening the X query', async () => {
    const env = testEnv({ MONITOR_CONFIG: JSON.stringify({ ...TEST_MONITOR, ignoreAccounts: ['@ExampleCo_Fans'] }) });
    const { world, run } = setup(env);
    world.posts = [
      { id: '3302', text: 'ExampleCo giveaway ended, nothing stuck here', user: 'ExampleCo_Fans' },
      { id: '3301', text: 'ExampleCo withdrawal stuck', user: 'frank' },
    ];
    const summary = await run();
    expect(summary.alerts).toBe(1);
    expect(world.searchCalls[0]!.searchParams.get('query')).not.toContain('ExampleCo_Fans');
  });

  it('alerts once for a templated campaign: same account again, or same text from other accounts', async () => {
    const { world, run } = setup();
    world.posts = [
      { id: '3406', text: 'ExampleCo #Scam warning: verify the domain first https://t.co/ddd', user: 'gina' }, // same text, 3rd account
      { id: '3405', text: '#ExampleCo #Scam warning: verify the domain first https://t.co/aaa', user: 'carol' }, // same account as 3404
      { id: '3404', text: '#ExampleCo #Scam help: file complaints with the FBI https://t.co/bbb', user: 'carol' },
      { id: '3403', text: '#ExampleCo #Scam warning: Verify the domain first! https://t.co/ccc', user: 'dave' },
      { id: '3402', text: 'ExampleCo withdrawal stuck for 3 days', user: 'erin' }, // a different, real complaint
    ];
    const summary = await run();
    expect(summary.alerts).toBe(3); // erin, dave, carol (first post)
    expect(summary.repeatsDropped).toBe(2); // carol again, gina
    expect(world.cards()).toHaveLength(3);
  });

  it('drops "recovery scam" bait as promo noise', async () => {
    const { world, run } = setup();
    world.posts = [{ id: '3501', text: 'ExampleCo scam. If you are a victim of this platform send a DM', user: 'frank' }];
    const summary = await run();
    expect(summary.alerts).toBe(0);
    expect(summary.promoDropped).toBe(1);
  });

  it('orders post ids as 64-bit numbers, not text (999.. is older than 1000..)', async () => {
    const { env, world, run } = setup();
    world.posts = [
      { id: '1000000000000000000', text: 'ExampleCo frozen withdrawal' },
      { id: '999999999999999999', text: 'ExampleCo stuck withdrawal' },
    ];
    world.larkOkCount = 1; // only the first card sent gets through
    await run();
    expect(JSON.stringify(world.cards()[0])).toContain('999999999999999999'); // the older post goes first
    expect(await getMeta(env.DB, 'cursor')).toBe('999999999999999999');
  });
});

describe('Lark problems', () => {
  it('a Lark failure leaves the cursor before the failed post, and the next run retries it', async () => {
    const { env, world, run } = setup();
    world.posts = [
      { id: '4002', text: 'ExampleCo stuck withdrawal two' },
      { id: '4001', text: 'ExampleCo stuck withdrawal one' },
    ];
    world.larkOkCount = 1; // first card goes through, the second fails
    const first = await run();
    expect(first.larkFailed).toBe(true);
    expect(first.alerts).toBe(1);
    expect(await getMeta(env.DB, 'cursor')).toBe('4001');

    world.larkOkCount = Infinity;
    world.posts = [{ id: '4002', text: 'ExampleCo stuck withdrawal two' }];
    const second = await run();
    expect(second.alerts).toBe(1);
    expect(await getMeta(env.DB, 'cursor')).toBe('4002');
    expect(world.cards()).toHaveLength(2);
  });

  it('a burst over the per-run limit posts the limit plus one notice, and the cursor still advances', async () => {
    const { env, world, run } = setup();
    world.posts = Array.from({ length: 35 }, (_, i) => ({ id: String(5000 + i), text: `ExampleCo stuck ${i}` }));
    const summary = await run();
    expect(summary.alerts).toBe(30);
    expect(summary.overflow).toBe(5);
    expect(world.texts().filter((t) => t.includes('burst'))).toHaveLength(1);
    expect(await getMeta(env.DB, 'cursor')).toBe('5034');
  });
});

describe('silent-failure alerts', () => {
  it('out of credits: warns immediately, once, then says when it recovers', async () => {
    const { world, run, advance } = setup();
    world.xStatus = 402;
    const first = await run();
    expect(first.xFailure?.kind).toBe('credits');
    expect(world.texts()).toHaveLength(1);
    expect(world.texts()[0]).toContain('X MONITOR WARNING');
    expect(world.texts()[0]).toContain('credits');
    expect(world.texts()[0]).not.toContain('x-token-secret');

    advance(5 * 60_000);
    await run(); // still down: no second warning
    expect(world.texts()).toHaveLength(1);

    world.xStatus = 200;
    world.posts = [];
    advance(5 * 60_000);
    await run();
    expect(world.texts()).toHaveLength(2);
    expect(world.texts()[1]).toContain('RECOVERED');

    advance(5 * 60_000);
    await run(); // healthy again: no more messages
    expect(world.texts()).toHaveLength(2);
  });

  it('rejected token warns immediately', async () => {
    const { world, run } = setup();
    world.xStatus = 401;
    world.xErrorBody = { title: 'Unauthorized', detail: 'Unauthorized', type: 'about:blank' };
    await run();
    expect(world.texts()[0]).toContain('rejected the access token');
  });

  it('a credit message from X on a 429 is treated as credits', async () => {
    const { world, run } = setup();
    world.xStatus = 429;
    world.xErrorBody = { title: 'UsageCapExceeded', detail: 'Usage cap exceeded', type: 'https://api.x.com/2/problems/usage-capped' };
    const s = await run();
    expect(s.xFailure?.kind).toBe('credits');
  });

  it('a short X outage stays quiet, a lasting one warns after 10 minutes', async () => {
    const { world, run, advance } = setup();
    world.xStatus = 503;
    world.xErrorBody = { title: 'Service Unavailable' };
    await run();
    expect(world.texts()).toHaveLength(0);
    advance(5 * 60_000);
    await run();
    expect(world.texts()).toHaveLength(0);
    advance(5 * 60_000);
    await run();
    expect(world.texts()).toHaveLength(1);
    expect(world.texts()[0]).toContain('failing for 10 min');
  });

  it('warns once when the credit balance is low, and does not re-check for 6 hours', async () => {
    const { world, run, advance } = setup();
    world.creditBalance = 3.5;
    await run();
    expect(world.texts().filter((t) => t.includes('credits are low'))).toHaveLength(1);
    expect(world.creditCalls).toBe(1);
    advance(60 * 60_000);
    await run();
    expect(world.creditCalls).toBe(1);
    expect(world.texts().filter((t) => t.includes('credits are low'))).toHaveLength(1);
  });

  it('a missing credit endpoint (403) never breaks the run', async () => {
    const { world, run } = setup();
    world.creditBalance = null;
    world.posts = [{ id: '6001', text: 'ExampleCo stuck' }];
    const s = await run();
    expect(s.alerts).toBe(1);
    expect(world.texts()).toHaveLength(0);
  });

  it('daily heartbeat is sent once per day at the chosen hour', async () => {
    const { world, run, advance } = setup(testEnv({ HEARTBEAT_HOUR_UTC: '14', LOW_CREDIT_USD: '' }));
    await run();
    advance(5 * 60_000);
    await run();
    const beats = world.texts().filter((t) => t.includes('X monitor is running'));
    expect(beats).toHaveLength(1);
  });
});

describe('configuration', () => {
  it('fails loudly, by name only, when a secret is missing', async () => {
    const { run } = setup(testEnv({ X_BEARER_TOKEN: '' }));
    await expect(run()).rejects.toThrow('Missing required secrets: X_BEARER_TOKEN');
  });

  it('refuses to run without a brand config, instead of watching the wrong thing', async () => {
    const { world, run } = setup(testEnv({ MONITOR_CONFIG: '' }));
    await expect(run()).rejects.toThrow('Missing required secrets: MONITOR_CONFIG');
    expect(world.searchCalls).toHaveLength(0); // never spends a cent on X
  });

  it('app mode needs the Lark app secrets', async () => {
    const { run } = setup(appEnv({ LARK_CHAT_ID: '' }));
    await expect(run()).rejects.toThrow('LARK_CHAT_ID');
  });
});

describe('app mode delivery', () => {
  it('gets a token once, sends interactive cards to the chat with a dedupe uuid', async () => {
    const { world, run } = setup(appEnv());
    world.posts = [
      { id: '7002', text: 'ExampleCo stuck two' },
      { id: '7001', text: 'ExampleCo stuck one' },
    ];
    await run();
    expect(world.larkTokenCalls).toBe(1);
    expect(world.cards()).toHaveLength(2);
    expect(world.cards()[0]!.raw.receive_id).toBe('oc_chat');
    expect(world.cards()[0]!.raw.uuid).toBe('x-7001');
    expect(world.cards()[0]!.card!.schema).toBe('2.0');
  });
});
