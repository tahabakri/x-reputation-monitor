import { maybeCheckCredits, maybeHeartbeat, onXFailure, onXSuccess } from './alerts';
import type { Case } from './cases';
import { isPromoNoise, makeClassifier, priorityFor, suggestedAction } from './classify';
import { MAX_ALERTS_PER_RUN, MAX_PAGES_PER_RUN, REPEAT_TEXT_MS, type Category } from './config';
import { caseExists, ensureSchema, getMeta, insertCase, recentCases, setMeta } from './db';
import { readConfig } from './env';
import { makeSender } from './lark';
import { buildQuery } from './query';
import { makeRepeatFilter } from './repeats';
import { compareIds } from './util';
import { searchRecent, type Candidate, type XFailure } from './x';

export interface Deps {
  fetchFn: typeof fetch;
  now: () => number;
}

export const defaultDeps = (): Deps => ({
  fetchFn: (input, init) => fetch(input, init),
  now: () => Date.now(),
});

export interface RunSummary {
  alerts: number;
  promoDropped: number;
  irrelevantDropped: number;
  repeatsDropped: number;
  duplicates: number;
  overflow: number;
  truncated: boolean;
  xFailure: XFailure | null;
  larkFailed: boolean;
}

const toXTime = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function makeCase(p: Candidate, now: number, category: Category): Case {
  const priority = priorityFor(category, p.followers, p.likes, p.reposts);
  return {
    id: p.id,
    createdAt: now,
    postedAt: p.createdAt,
    username: p.username,
    followers: p.followers,
    likes: p.likes,
    reposts: p.reposts,
    text: p.text,
    category,
    priority,
    suggested: suggestedAction(category, priority),
    status: 'New',
    action: '',
    history: [],
  };
}

// One 5-minute cycle: search X, drop noise, post each new case to Lark, move the cursor.
export async function runMonitor(env: Env, deps: Deps = defaultDeps()): Promise<RunSummary> {
  const cfg = readConfig(env);
  const db = env.DB;
  await ensureSchema(db);

  const now = deps.now();
  const sender = makeSender(cfg, deps.fetchFn, () => Math.floor(deps.now() / 1000));
  const summary: RunSummary = {
    alerts: 0,
    promoDropped: 0,
    irrelevantDropped: 0,
    repeatsDropped: 0,
    duplicates: 0,
    overflow: 0,
    truncated: false,
    xFailure: null,
    larkFailed: false,
  };

  const own = new Set([...cfg.monitor.ownAccounts, ...cfg.monitor.ignoreAccounts].map((a) => a.toLowerCase()));
  const { categorize, mentionsBrand } = makeClassifier(cfg.monitor);
  const repeats = makeRepeatFilter(await recentCases(db, now - REPEAT_TEXT_MS), now, cfg.monitor.brandTerms);
  const cursor = await getMeta(db, 'cursor');
  const query = buildQuery(cfg.monitor);
  const result = await searchRecent({
    apiBase: cfg.xBase,
    token: cfg.xToken,
    query,
    sinceId: cursor,
    // No cursor yet (first run): look back a short while only, never the 7-day backlog.
    startTime: cursor ? null : toXTime(now - cfg.firstRunLookbackMs),
    fetchFn: deps.fetchFn,
  });

  if (!result.ok) {
    summary.xFailure = result.failure;
    console.error(JSON.stringify({ event: 'x_failure', ...result.failure }));
    await onXFailure(db, sender, result.failure, now, cfg.monitor.brandName);
    return summary;
  }
  await onXSuccess(db, sender);
  summary.truncated = result.truncated;

  // Oldest first, so a Lark failure halfway never skips a post: the cursor stops just before it.
  const posts = [...result.posts].sort((a, b) => compareIds(a.id, b.id));
  let handled = cursor;
  let overflow = 0;

  for (const p of posts) {
    if (own.has(p.username.toLowerCase())) {
      handled = p.id;
      continue;
    }
    if (isPromoNoise(p.text, p.username)) {
      summary.promoDropped++;
      handled = p.id;
      continue;
    }
    // X matched on something other than the visible text (author handle, link target): not a complaint.
    const category = categorize(p.text);
    if (!mentionsBrand(p.text) || category === 'other') {
      summary.irrelevantDropped++;
      handled = p.id;
      continue;
    }
    if (await caseExists(db, p.id)) {
      summary.duplicates++;
      handled = p.id;
      continue;
    }
    if (repeats.isRepeat(p.username, p.text)) {
      summary.repeatsDropped++;
      handled = p.id;
      continue;
    }
    if (summary.alerts >= MAX_ALERTS_PER_RUN) {
      overflow++;
      continue;
    }
    const c = makeCase(p, now, category);
    try {
      await sender.sendCard(c);
    } catch (err) {
      summary.larkFailed = true;
      console.error(JSON.stringify({ event: 'lark_send_failed', post: p.id, error: errText(err) }));
      break; // keep the cursor before this post; the next run retries it
    }
    await insertCase(db, c);
    repeats.remember(p.username, p.text);
    summary.alerts++;
    handled = p.id;
  }
  summary.overflow = overflow;

  if (!summary.larkFailed) {
    if (overflow > 0 || result.truncated) {
      const looked = MAX_PAGES_PER_RUN * 100;
      const why = result.truncated ? `more than ${looked} matches in one cycle` : `${overflow} matches over the limit of ${MAX_ALERTS_PER_RUN} per cycle`;
      try {
        await sender.sendText(
          `X MONITOR: a burst of negative posts (${why}). Not every post was posted individually. Review them on X: https://x.com/search?q=${encodeURIComponent(query)}&f=live`,
        );
      } catch (err) {
        console.error(JSON.stringify({ event: 'burst_notice_not_sent', error: errText(err) }));
      }
    }
    handled = result.newestId ?? handled;
  }
  if (handled && handled !== cursor) await setMeta(db, 'cursor', handled);

  for (const step of [
    () => maybeCheckCredits(db, sender, cfg, deps.fetchFn, now),
    () => maybeHeartbeat(db, sender, cfg, now),
  ]) {
    try {
      await step();
    } catch (err) {
      console.error(JSON.stringify({ event: 'housekeeping_failed', error: errText(err) }));
    }
  }
  return summary;
}
