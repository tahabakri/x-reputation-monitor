import { CATEGORY_ORDER, PRIORITY, PROMO_PATTERNS, type Category, type MonitorConfig } from './config';

export type Priority = 'P1' | 'P2' | 'P3';
export type Action = 'Reply' | 'Ignore' | 'Escalate' | 'Legal review';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-word match; multi-word keywords tolerate any run of whitespace between the words.
function keywordRegex(keyword: string, caseSensitive: boolean): RegExp {
  const body = keyword.split(/\s+/).map(escapeRe).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, caseSensitive ? 'u' : 'iu');
}

// Labels a post with one of the plan's keyword categories. First match wins (legal > scam > funds > support).
export function makeClassifier(m: MonitorConfig): { categorize(text: string): Category } {
  const sensitive = new Set(m.caseSensitive);
  const matchers = CATEGORY_ORDER.map((c) => [c, m.keywords[c].map((k) => keywordRegex(k, sensitive.has(k)))] as const);
  return {
    categorize(text) {
      for (const [category, regexes] of matchers) {
        if (regexes.some((re) => re.test(text))) return category;
      }
      return 'other';
    },
  };
}

export function isPromoNoise(text: string): boolean {
  return PROMO_PATTERNS.some((re) => re.test(text));
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
