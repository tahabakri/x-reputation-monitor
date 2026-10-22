import { CATEGORY_ORDER, type MonitorConfig } from './config';

const term = (t: string) => (/\s/.test(t) ? `"${t}"` : t);

// Brand AND at least one negative keyword, no reposts, none of our own accounts.
// This filter is what keeps the bill low: X charges per post returned.
export function buildQuery(m: MonitorConfig): string {
  const brand = `(${m.brandTerms.map(term).join(' OR ')})`;
  const negative = `(${CATEGORY_ORDER.flatMap((c) => m.keywords[c]).map(term).join(' OR ')})`;
  const own = m.ownAccounts.map((a) => `-from:${a}`);
  return [brand, negative, '-is:retweet', ...own].join(' ');
}
