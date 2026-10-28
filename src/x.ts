import { MAX_PAGES_PER_RUN } from './config';

export interface Candidate {
  id: string;
  text: string;
  createdAt: string;
  username: string;
  followers: number;
  likes: number;
  reposts: number;
}

export type XFailureKind = 'auth' | 'credits' | 'rate' | 'server' | 'network' | 'other';

export interface XFailure {
  kind: XFailureKind;
  status: number; // 0 = no HTTP response (network error / timeout)
  detail: string; // short, safe to show in Lark: never contains the token
}

export type SearchResult =
  | { ok: true; posts: Candidate[]; newestId: string | null; truncated: boolean }
  | { ok: false; failure: XFailure };

export interface SearchArgs {
  apiBase: string;
  token: string;
  query: string;
  sinceId: string | null;
  startTime: string | null; // used only when there is no cursor yet
  fetchFn: typeof fetch;
}

interface XSearchBody {
  data?: Array<{
    id: string;
    text?: string;
    created_at?: string;
    author_id?: string;
    public_metrics?: { like_count?: number; retweet_count?: number };
  }>;
  includes?: { users?: Array<{ id: string; username?: string; public_metrics?: { followers_count?: number } }> };
  meta?: { newest_id?: string; next_token?: string };
}

const TIMEOUT_MS = 10_000;

// X sends & < > as HTML entities; show them as typed.
export const decodeEntities = (t: string): string =>
  t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export function classifyFailure(status: number, bodyText: string): XFailure {
  let detail = bodyText;
  try {
    const j = JSON.parse(bodyText) as Record<string, unknown>;
    const first = Array.isArray(j.errors) ? (j.errors[0] as Record<string, unknown> | undefined) : undefined;
    detail = [j.title ?? first?.title, j.detail ?? first?.detail, j.type ?? first?.type]
      .filter((p): p is string => typeof p === 'string' && p !== '')
      .join(' - ');
  } catch {
    // body was not JSON: keep the raw text
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300) || `HTTP ${status}`;

  const lower = `${bodyText}`.toLowerCase();
  let kind: XFailureKind = 'other';
  if (status === 402 || /credit|usage-capped|usage cap|spend limit|payment required/.test(lower)) kind = 'credits';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429) kind = 'rate';
  else if (status >= 500) kind = 'server';
  return { kind, status, detail };
}

async function getJson(
  fetchFn: typeof fetch,
  url: string,
  token: string,
): Promise<{ ok: true; body: unknown } | { ok: false; failure: XFailure }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, failure: { kind: 'network', status: 0, detail: msg.slice(0, 200) } };
  }
  const text = await res.text(); // bounded: max 100 posts per page, or a small error body
  if (!res.ok) return { ok: false, failure: classifyFailure(res.status, text) };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, failure: { kind: 'other', status: res.status, detail: 'X returned a non-JSON response' } };
  }
}

export async function searchRecent(a: SearchArgs): Promise<SearchResult> {
  const posts: Candidate[] = [];
  const users = new Map<string, { username: string; followers: number }>();
  let newestId: string | null = null;
  let nextToken: string | null = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({
      query: a.query,
      max_results: '100',
      'post.fields': 'created_at,public_metrics,author_id',
      expansions: 'author_id',
      'user.fields': 'username,public_metrics',
    });
    if (a.sinceId) params.set('since_id', a.sinceId);
    else if (a.startTime) params.set('start_time', a.startTime);
    if (nextToken) params.set('next_token', nextToken);

    const res = await getJson(a.fetchFn, `${a.apiBase}/2/tweets/search/recent?${params}`, a.token);
    if (!res.ok) return res;

    const body = res.body as XSearchBody;
    for (const u of body.includes?.users ?? []) {
      users.set(u.id, { username: u.username ?? 'unknown', followers: u.public_metrics?.followers_count ?? 0 });
    }
    for (const p of body.data ?? []) {
      const author = p.author_id ? users.get(p.author_id) : undefined;
      posts.push({
        id: p.id,
        text: decodeEntities(p.text ?? ''),
        createdAt: p.created_at ?? new Date().toISOString(),
        username: author?.username ?? 'unknown',
        followers: author?.followers ?? 0,
        likes: p.public_metrics?.like_count ?? 0,
        reposts: p.public_metrics?.retweet_count ?? 0,
      });
    }
    newestId ??= body.meta?.newest_id ?? null;
    nextToken = body.meta?.next_token ?? null;
    pages++;
  } while (nextToken && pages < MAX_PAGES_PER_RUN);

  return { ok: true, posts, newestId, truncated: nextToken !== null };
}

export async function getCredits(
  apiBase: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<{ ok: true; totalUsd: number } | { ok: false; failure: XFailure }> {
  const res = await getJson(fetchFn, `${apiBase}/2/usage/credits`, token);
  if (!res.ok) return res;
  const total = (res.body as { data?: { total_balance?: unknown } }).data?.total_balance;
  if (typeof total !== 'number') {
    return { ok: false, failure: { kind: 'other', status: 200, detail: 'credit balance missing from response' } };
  }
  return { ok: true, totalUsd: total };
}
