import { describe, expect, it } from 'vitest';
import { isPromoNoise, makeClassifier, priorityFor, suggestedAction } from '../src/classify';
import { parseMonitorConfig } from '../src/config';
import { buildQuery } from '../src/query';
import { TEST_MONITOR } from './helpers';

const monitor = parseMonitorConfig(JSON.stringify(TEST_MONITOR));
const { categorize } = makeClassifier(monitor);

describe('X query', () => {
  it('is brand AND a negative keyword, no reposts, none of our own accounts', () => {
    expect(buildQuery(monitor)).toBe(
      '(ExampleCo OR @ExampleCo OR @ExampleCoHelp) ' +
        '(lawsuit OR SEC OR regulator OR police OR sanctions OR MiCa OR scam OR fraud OR stolen OR hacked OR avoid OR ' +
        'frozen OR locked OR "not received" OR missing OR stuck OR "no reply" OR "no response") ' +
        '-is:retweet -from:ExampleCo -from:ExampleCoHelp',
    );
  });

  it('uses the keyword lists from the config when it has its own', () => {
    const custom = parseMonitorConfig(
      JSON.stringify({ ...TEST_MONITOR, keywords: { scam: ['rugpull'], funds: ['can not withdraw'], legal: [], support: [] } }),
    );
    expect(buildQuery(custom)).toContain('(rugpull OR "can not withdraw")');
    expect(makeClassifier(custom).categorize('ExampleCo rugpull')).toBe('scam');
  });
});

describe('MONITOR_CONFIG', () => {
  it('needs a brand name and brand terms, and accepts @ on own accounts', () => {
    const m = parseMonitorConfig(JSON.stringify({ ...TEST_MONITOR, ownAccounts: ['@ExampleCo', 'Support_Team'] }));
    expect(m.ownAccounts).toEqual(['ExampleCo', 'Support_Team']);
    expect(m.keywords.scam).toContain('scam'); // generic defaults fill the gaps
  });

  it.each([
    ['missing', undefined, 'not set'],
    ['empty', '   ', 'not set'],
    ['not json', '{nope', 'not valid JSON'],
    ['an array', '[]', 'must be a JSON object'],
    ['no brand name', JSON.stringify({ brandTerms: ['ExampleCo'] }), 'brandName'],
    ['no brand terms', JSON.stringify({ brandName: 'ExampleCo', brandTerms: [] }), 'brandTerms'],
    ['a quote in a term (would break the X query)', JSON.stringify({ ...TEST_MONITOR, brandTerms: ['Example"Co'] }), 'brandTerms'],
    ['a bad own account', JSON.stringify({ ...TEST_MONITOR, ownAccounts: ['not a handle!'] }), 'ownAccounts'],
    ['every keyword list empty', JSON.stringify({ ...TEST_MONITOR, keywords: { legal: [], scam: [], funds: [], support: [] } }), 'at least one keyword'],
  ])('refuses %s', (_name, raw, message) => {
    expect(() => parseMonitorConfig(raw as string | undefined)).toThrow(message);
  });

  it('never echoes config values in an error message', () => {
    let message = '';
    try {
      parseMonitorConfig(JSON.stringify({ ...TEST_MONITOR, brandTerms: ['Secret"Brand'] }));
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('brandTerms');
    expect(message).not.toContain('Secret');
  });
});

describe('categorize', () => {
  it.each([
    ['ExampleCo withdrawal stuck test', 'funds'],
    ['my account is frozen @ExampleCoHelp', 'funds'],
    ['funds NOT   received after 5 days ExampleCo', 'funds'],
    ['ExampleCo no response from support', 'support'],
    ['ExampleCo is a scam', 'scam'],
    ['ExampleCo not good scam', 'scam'],
    ['ExampleCo not good, scam', 'scam'],
    ['not sure if ExampleCo is a scam', 'scam'],
    ['ExampleCo no scam here', 'other'],
    ['avoid ExampleCo', 'scam'],
    ['filing a lawsuit against ExampleCo', 'legal'],
    ['ExampleCo and MiCa compliance', 'legal'],
    ['ExampleCo hacked and stuck: SEC should look', 'legal'], // legal outranks scam and funds
    ['ExampleCo hacked my funds, withdrawal stuck', 'scam'], // scam outranks funds
    ['love ExampleCo', 'other'],
  ])('%s -> %s', (text, expected) => {
    expect(categorize(text)).toBe(expected);
  });

  it('only counts upper-case SEC, not "5 sec"', () => {
    expect(categorize('ExampleCo took 5 sec to load')).toBe('other');
    expect(categorize('ExampleCo and the SEC')).toBe('legal');
  });

  it('does not match inside other words', () => {
    expect(categorize('ExampleCo amica')).toBe('other'); // contains "mica" but is not the word
    expect(categorize('sanctionsbot ExampleCo')).toBe('other');
  });
});

describe('promo noise', () => {
  it.each([
    'Join ExampleCo with my referral code ABC123',
    'ExampleCo AIRDROP is live, claim now',
    'Giveaway: win 100 USDT, ExampleCo',
    'ExampleCo VIP signals, join my telegram',
  ])('drops: %s', (text) => expect(isPromoNoise(text)).toBe(true));

  it('keeps a normal complaint', () => {
    expect(isPromoNoise('ExampleCo has frozen my withdrawal for 9 days')).toBe(false);
  });
});

describe('priority and suggested action', () => {
  it('legal is always P1 and goes to legal review', () => {
    expect(priorityFor('legal', 5, 0, 0)).toBe('P1');
    expect(suggestedAction('legal', 'P1')).toBe('Legal review');
  });
  it('scam: P2 for a small account, P1 with reach', () => {
    expect(priorityFor('scam', 200, 1, 0)).toBe('P2');
    expect(priorityFor('scam', 6_000, 0, 0)).toBe('P1');
    expect(priorityFor('scam', 200, 20, 10)).toBe('P1');
  });
  it('funds: P3 for an ordinary user, P2 with some reach, P1 when viral', () => {
    expect(priorityFor('funds', 80, 0, 0)).toBe('P3');
    expect(priorityFor('funds', 1_500, 0, 0)).toBe('P2');
    expect(priorityFor('funds', 80, 60, 50)).toBe('P1');
  });
  it('P1 non-legal is escalated, the rest are replies', () => {
    expect(suggestedAction('scam', 'P1')).toBe('Escalate');
    expect(suggestedAction('funds', 'P3')).toBe('Reply');
  });
});

describe('X text', () => {
  it('shows HTML entities as typed', async () => {
    const { decodeEntities } = await import('../src/x');
    expect(decodeEntities('Q&amp;A &lt;3 &amp;lt; it&#39;s')).toBe("Q&A <3 &lt; it's");
  });
});

describe('negated keywords and affiliate pitches', () => {
  it.each([
    ['ExampleCo has never been hacked', 'other'],
    ['my partner @ExampleCo hasn\'t been hacked', 'other'],
    ['ExampleCo is not a scam', 'other'],
    ['ExampleCo is a scam', 'scam'],
    ['ExampleCo not good scam', 'scam'],
    ['ExampleCo not good, scam', 'scam'],
    ['not sure if ExampleCo is a scam', 'scam'],
    ['ExampleCo no scam here', 'other'],
    ['Binance was hacked, ExampleCo has never been hacked', 'scam'], // another, un-negated mention remains
    ['I can\'t believe ExampleCo withdrawal is frozen', 'funds'],
  ])('%s -> %s', (text, expected) => expect(categorize(text)).toBe(expected));

  it.each([
    'Could be a good time to move over to ExampleCo. NEW user rewards: https://t.co/x',
    'use my link for a sign-up bonus on ExampleCo',
  ])('drops pitch: %s', (text) => expect(isPromoNoise(text)).toBe(true));

  it('drops accounts that sell "recovery"', () => {
    expect(isPromoNoise('ExampleCo freeze warning', 'RecoverwithErik')).toBe(true);
    expect(isPromoNoise('ExampleCo freeze warning', 'alice')).toBe(false);
  });
});
