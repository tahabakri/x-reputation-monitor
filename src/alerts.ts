import {
  CREDIT_CHECK_EVERY_MS,
  FAIL_ALERT_AFTER_MS,
  FAIL_REPEAT_MS,
  LOW_CREDIT_REPEAT_MS,
} from './config';
import { countCasesSince, countOpenCases, deleteMeta, getMeta, getMetaJson, setMeta, setMetaJson } from './db';
import type { Config } from './env';
import type { Sender } from './lark';
import { fmtUtc } from './util';
import { getCredits, type XFailure, type XFailureKind } from './x';

// The "silent failure" guard: a monitor that quietly stops is worse than none.

interface FailState {
  since: number;
  alertedAt: number | null;
  kind: XFailureKind;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function failureText(f: XFailure, since: number, now: number, brand: string): string {
  const mins = Math.max(1, Math.round((now - since) / 60_000));
  const http = f.status ? `HTTP ${f.status}` : 'no response';
  const tail = `(${http}: ${f.detail})`;
  switch (f.kind) {
    case 'credits':
      return `X MONITOR WARNING: X refused the request. The API credits are probably used up or the spend limit was reached. ${brand} mentions are NOT being checked until credits are added in the X Developer Console. ${tail}`;
    case 'auth':
      return `X MONITOR WARNING: X rejected the access token. The Bearer token may have been regenerated, or the app lost access. ${brand} mentions are NOT being checked until this is fixed. ${tail}`;
    default:
      return `X MONITOR WARNING: the X API has been failing for ${mins} min. ${brand} mentions are NOT being checked. It retries every 5 min and will say when it recovers. ${tail}`;
  }
}

// Wrong token / out of credits will not fix themselves, so those warn at once. Anything else
// (X outage, rate limit, network) must persist for FAIL_ALERT_AFTER_MS first, then repeats rarely.
export async function onXFailure(
  db: D1Database,
  sender: Sender,
  failure: XFailure,
  now: number,
  brand: string,
): Promise<void> {
  const state: FailState = (await getMetaJson<FailState>(db, 'x_fail')) ?? {
    since: now,
    alertedAt: null,
    kind: failure.kind,
  };
  state.kind = failure.kind;
  const immediate = failure.kind === 'auth' || failure.kind === 'credits';
  const due =
    state.alertedAt === null
      ? immediate || now - state.since >= FAIL_ALERT_AFTER_MS
      : now - state.alertedAt >= FAIL_REPEAT_MS;
  if (due) {
    try {
      await sender.sendText(failureText(failure, state.since, now, brand));
      state.alertedAt = now;
    } catch (err) {
      console.error(JSON.stringify({ event: 'warning_not_sent', error: errText(err) }));
    }
  }
  await setMetaJson(db, 'x_fail', state);
}

export async function onXSuccess(db: D1Database, sender: Sender): Promise<void> {
  const state = await getMetaJson<FailState>(db, 'x_fail');
  if (!state) return;
  if (state.alertedAt !== null) {
    try {
      await sender.sendText(
        `X MONITOR RECOVERED: the X API is answering again (down since ${fmtUtc(state.since)}). Posts that appeared meanwhile are picked up now.`,
      );
    } catch (err) {
      console.error(JSON.stringify({ event: 'recovery_not_sent', error: errText(err) }));
      return; // keep the state, try to tell the team on the next run
    }
  }
  await deleteMeta(db, 'x_fail');
}

// Looks at the X credit balance a few times a day and warns before it runs out.
export async function maybeCheckCredits(
  db: D1Database,
  sender: Sender,
  cfg: Config,
  fetchFn: typeof fetch,
  now: number,
): Promise<void> {
  if (cfg.lowCreditUsd === null) return;
  const last = Number((await getMeta(db, 'credits_checked_at')) ?? 0);
  if (now - last < CREDIT_CHECK_EVERY_MS) return;
  await setMeta(db, 'credits_checked_at', String(now)); // set first: a broken endpoint is not hammered

  const res = await getCredits(cfg.xBase, cfg.xToken, fetchFn);
  if (!res.ok) {
    console.warn(JSON.stringify({ event: 'credit_check_failed', ...res.failure }));
    return;
  }
  await setMetaJson(db, 'credits_balance', { usd: res.totalUsd, at: now });
  if (res.totalUsd >= cfg.lowCreditUsd) return;

  const lastWarn = Number((await getMeta(db, 'credits_low_at')) ?? 0);
  if (now - lastWarn < LOW_CREDIT_REPEAT_MS) return;
  try {
    await sender.sendText(
      `X MONITOR WARNING: X credits are low: $${res.totalUsd.toFixed(2)} left (alert level $${cfg.lowCreditUsd}). Add credits in the X Developer Console before they run out.`,
    );
    await setMeta(db, 'credits_low_at', String(now));
  } catch (err) {
    console.error(JSON.stringify({ event: 'low_credit_not_sent', error: errText(err) }));
  }
}

// One "I am alive" message a day. If the team stops seeing it, the Worker itself has stopped.
export async function maybeHeartbeat(db: D1Database, sender: Sender, cfg: Config, now: number): Promise<void> {
  if (cfg.heartbeatHourUtc === null) return;
  const d = new Date(now);
  if (d.getUTCHours() !== cfg.heartbeatHourUtc) return;
  const day = d.toISOString().slice(0, 10);
  if ((await getMeta(db, 'heartbeat_day')) === day) return;

  const [recent, open, balance] = await Promise.all([
    countCasesSince(db, now - 86_400_000),
    countOpenCases(db),
    getMetaJson<{ usd: number }>(db, 'credits_balance'),
  ]);
  const credits = balance ? ` X credits: $${balance.usd.toFixed(2)}.` : '';
  try {
    await sender.sendText(
      `X monitor is running. Last 24 h: ${recent} new alert(s). Cases still open (New or Waiting): ${open}.${credits}`,
    );
    await setMeta(db, 'heartbeat_day', day);
  } catch (err) {
    console.error(JSON.stringify({ event: 'heartbeat_not_sent', error: errText(err) }));
  }
}
