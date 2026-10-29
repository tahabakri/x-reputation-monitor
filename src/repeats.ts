import { REPEAT_AUTHOR_MS, REPEAT_TEXT_MS } from './config';

// Spam campaigns post the same text from many accounts, and one account posts it again and again.
// The first post is worth an alert; the repeats are not.

const FINGERPRINT_CHARS = 80;

// The text with links, #hashtags, @mentions, punctuation and case removed, cut short, so small
// differences between copies (a different link, an extra hashtag) do not hide a repeat.
export function fingerprint(text: string, brandTerms: string[] = []): string {
  let t = text.toLowerCase();
  for (const b of brandTerms) t = t.split(b.replace(/^@/, '').toLowerCase()).join(' '); // brand word vs #brand
  return t
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@][\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, FINGERPRINT_CHARS);
}

export interface RecentPost {
  username: string;
  text: string;
  at: number; // epoch ms the alert was sent
}

export function makeRepeatFilter(recent: RecentPost[], now: number, brandTerms: string[] = []) {
  const seen = recent.map((r) => ({ user: r.username.toLowerCase(), fp: fingerprint(r.text, brandTerms), at: r.at }));
  return {
    // Same account alerted recently, or the same text already alerted from any account.
    isRepeat(username: string, text: string): boolean {
      const user = username.toLowerCase();
      const fp = fingerprint(text, brandTerms);
      return seen.some(
        (s) =>
          (s.user === user && now - s.at < REPEAT_AUTHOR_MS) ||
          (fp.length >= 20 && s.fp === fp && now - s.at < REPEAT_TEXT_MS),
      );
    },
    remember(username: string, text: string): void {
      seen.push({ user: username.toLowerCase(), fp: fingerprint(text, brandTerms), at: now });
    },
  };
}
