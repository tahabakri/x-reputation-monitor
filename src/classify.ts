import { CATEGORY_ORDER, PRIORITY, PROMO_HANDLE, PROMO_PATTERNS, type Category, type MonitorConfig } from './config';

export type Priority = 'P1' | 'P2' | 'P3';
export type Action = 'Reply' | 'Ignore' | 'Escalate' | 'Legal review';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-word match; multi-word keywords tolerate any run of whitespace between the words.
function keywordRegex(keyword: string, caseSensitive: boolean): RegExp {
  const body = keyword.split(/\s+/).map(escapeRe).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, caseSensitive ? 'gu' : 'giu');
}

// "never been hacked", "isn't a scam", "hasn't been frozen": the keyword is there but the post says the opposite.
const NEGATED = /(?:\b(?:never|not|no|without)|n['’]t|\bcannot)\s+(?:[\p{L}\p{N}'’]+\s+)?$/iu;

// True when the keyword appears at least once without a negation right before it.
function hasPositiveMatch(re: RegExp, text: string): boolean {
  for (const m of text.matchAll(re)) {
    if (!NEGATED.test(text.slice(Math.max(0, m.index - 30), m.index))) return true;
  }
  return false;
}

// Labels a post with one of the plan's keyword categories. First match wins (legal > scam > funds > support).
export function makeClassifier(m: MonitorConfig): { categorize(text: string): Category; mentionsBrand(text: string): boolean } {
  const sensitive = new Set(m.caseSensitive);
  const matchers = CATEGORY_ORDER.map((c) => [c, m.keywords[c].map((k) => keywordRegex(k, sensitive.has(k)))] as const);
  // X also matches the brand in the author's handle and in link targets. A real mention has it in the text.
  const brands = m.brandTerms.map((t) => t.replace(/^@/, '').toLowerCase());
  return {
    mentionsBrand(text) {
      const lower = text.toLowerCase();
      return brands.some((b) => lower.includes(b));
    },
    categorize(text) {
      for (const [category, regexes] of matchers) {
        if (regexes.some((re) => hasPositiveMatch(re, text))) return category;
      }
      return 'other';
    },
  };
}

export function isPromoNoise(text: string, username = ''): boolean {
  return PROMO_HANDLE.test(username) || PROMO_PATTERNS.some((re) => re.test(text));
}

export function priorityFor(category: Category, followers: number, likes: number, reposts: number): Priority {
  const engagement = likes + reposts;
  if (category === 'legal') return 'P1';
  if (followers >= PRIORITY.anyP1Followers || engagement >= PRIORITY.anyP1Engagement) return 'P1';
  if (category === 'scam') {
    return followers >= PRIORITY.p1Followers || engagement >= PRIORITY.p1Engagement ? 'P1' : 'P2';
  }
  if (followers >= PRIORITY.p2Followers || engagement >= PRIORITY.p2Engagement) return 'P2';
  return 'P3';
}

export function suggestedAction(category: Category, priority: Priority): Action {
  if (category === 'legal') return 'Legal review';
  if (priority === 'P1') return 'Escalate';
  return 'Reply';
}
