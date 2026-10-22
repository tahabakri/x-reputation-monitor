// Tunables that are the same for everyone. What is specific to YOUR brand (its name, the handles to
// search for, our own accounts, and optionally the keyword lists) is NOT in this file or in the repo:
// it comes from the private MONITOR_CONFIG secret. See README.md and monitor.config.example.json.

export type Category = 'legal' | 'scam' | 'funds' | 'support' | 'other';

// First match wins when labelling a post: legal > scam > funds > support.
export const CATEGORY_ORDER = ['legal', 'scam', 'funds', 'support'] as const;
export type KeywordCategory = (typeof CATEGORY_ORDER)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  legal: 'Legal / regulatory',
  scam: 'Reputation / scam',
  funds: 'Funds / account',
  support: 'Support',
  other: 'Other',
};

export interface MonitorConfig {
  brandName: string; // shown in warnings: "<brand> mentions are NOT being checked"
  brandTerms: string[]; // words / @handles that must appear in a post, e.g. "ExampleCo", "@ExampleCo"
  ownAccounts: string[]; // handles whose own posts are never alerted on
  keywords: Record<KeywordCategory, string[]>; // a post must contain at least one of these
  caseSensitive: string[]; // keywords that only count in exactly this casing when labelling
}

// Generic complaint words, used when MONITOR_CONFIG does not list its own.
export const DEFAULT_KEYWORDS: Record<KeywordCategory, string[]> = {
  legal: ['lawsuit', 'SEC', 'regulator', 'police', 'sanctions', 'MiCa'],
  scam: ['scam', 'fraud', 'stolen', 'hacked', 'avoid'],
  funds: ['frozen', 'locked', 'not received', 'missing', 'stuck'],
  support: ['no reply', 'no response'],
};

// "SEC" is also how people write "seconds". X search is case-insensitive so such posts are still
// pulled, but only the upper-case form counts as a legal/regulatory signal.
export const DEFAULT_CASE_SENSITIVE = ['SEC'];

// Quotes and parentheses would break the X search query, so they are refused in terms.
const TERM = /^[^"()\r\n]{1,60}$/;
const HANDLE = /^@?(\w{1,15})$/;

function stringList(v: unknown, field: string, min: number, test: (s: string) => boolean): string[] {
  if (!Array.isArray(v) || v.length < min || v.some((s) => typeof s !== 'string' || !test(s.trim()))) {
    throw new Error(`MONITOR_CONFIG: "${field}" must be a list of ${min > 0 ? 'one or more ' : ''}valid strings`);
  }
  return v.map((s: string) => s.trim());
}

export function parseMonitorConfig(raw: string | undefined): MonitorConfig {
  if (raw === undefined || raw.trim() === '') throw new Error('MONITOR_CONFIG is not set');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('MONITOR_CONFIG is not valid JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('MONITOR_CONFIG must be a JSON object');
  }
  const o = json as Record<string, unknown>;

  const brandName = typeof o.brandName === 'string' ? o.brandName.trim() : '';
  if (brandName === '' || brandName.length > 60) {
    throw new Error('MONITOR_CONFIG: "brandName" must be a short text');
  }
  const brandTerms = stringList(o.brandTerms, 'brandTerms', 1, (s) => TERM.test(s));
  const ownAccounts =
    o.ownAccounts === undefined
      ? []
      : stringList(o.ownAccounts, 'ownAccounts', 0, (s) => HANDLE.test(s)).map((s) => s.replace(/^@/, ''));

  const kw = (o.keywords ?? {}) as Record<string, unknown>;
  const keywords = {} as Record<KeywordCategory, string[]>;
  for (const c of CATEGORY_ORDER) {
    keywords[c] = kw[c] === undefined ? DEFAULT_KEYWORDS[c] : stringList(kw[c], `keywords.${c}`, 0, (s) => TERM.test(s));
  }
  if (CATEGORY_ORDER.every((c) => keywords[c].length === 0)) {
    throw new Error('MONITOR_CONFIG: at least one keyword is needed');
  }
  const caseSensitive =
    o.caseSensitive === undefined ? DEFAULT_CASE_SENSITIVE : stringList(o.caseSensitive, 'caseSensitive', 0, (s) => TERM.test(s));

  return { brandName, brandTerms, ownAccounts, keywords, caseSensitive };
}

// Obvious promo noise is dropped after the pull (referral codes, airdrop, giveaway, signal-group
// spam). Trade-off: a real user writing "my airdrop is stuck" is dropped too.
export const PROMO_PATTERNS: readonly RegExp[] = [
  /\b(referral|referrals|invite code|promo code|use my code|my code|ref code)\b/i,
  /\bair-?drops?\b/i,
  /\bgive-?aways?\b/i,
  /\b(signals? (group|channel)|vip signals?|free signals?|join (my|our) (telegram|channel|group))\b/i,
];

// Priority rules. These are starting guesses to be reviewed with real cases after two weeks.
//   P1: legal/regulatory, or a scam allegation / any complaint with high reach.
//   P2: scam allegations, or funds/support complaints with some reach.
//   P3: everything else (normal single-user complaint).
export const PRIORITY = {
  p1Followers: 5_000,
  p1Engagement: 25, // likes + reposts, for scam allegations
  anyP1Followers: 50_000,
  anyP1Engagement: 100,
  p2Followers: 1_000,
  p2Engagement: 5,
} as const;

// Safety limits per 5-minute run. The Workers Free plan allows 50 outgoing requests per run.
export const MAX_PAGES_PER_RUN = 3; // x 100 posts; a full 300 is a pile-on worth knowing about
export const MAX_ALERTS_PER_RUN = 30;

// Failure alerts (the "silent failure" guard).
export const FAIL_ALERT_AFTER_MS = 10 * 60_000; // transient errors must persist this long
export const FAIL_REPEAT_MS = 6 * 3_600_000; // re-warn while it keeps failing
export const CREDIT_CHECK_EVERY_MS = 6 * 3_600_000;
export const LOW_CREDIT_REPEAT_MS = 24 * 3_600_000;
