import { parseMonitorConfig, type MonitorConfig } from './config';
import { parseOptionalNumber } from './util';

export interface Config {
  monitor: MonitorConfig; // brand, handles and keywords, from the private MONITOR_CONFIG secret
  mode: 'webhook' | 'app';
  xBase: string;
  xToken: string;
  larkBase: string;
  webhook: { url: string; secret: string | null } | null;
  app: { id: string; secret: string; chatId: string } | null;
  verificationToken: string | null;
  firstRunLookbackMs: number;
  lowCreditUsd: number | null;
  heartbeatHourUtc: number | null;
}

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

// Fails loudly at the start of a run if a required secret is missing. Names only, never values.
export function readConfig(env: Env): Config {
  const mode = env.LARK_MODE === 'app' ? 'app' : 'webhook';
  const missing: string[] = [];
  if (!present(env.X_BEARER_TOKEN)) missing.push('X_BEARER_TOKEN');
  if (!present(env.MONITOR_CONFIG)) missing.push('MONITOR_CONFIG');
  if (mode === 'webhook' && !present(env.LARK_WEBHOOK_URL)) missing.push('LARK_WEBHOOK_URL');
  if (mode === 'app') {
    for (const k of ['LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_CHAT_ID', 'LARK_VERIFICATION_TOKEN'] as const) {
      if (!present(env[k])) missing.push(k);
    }
  }
  if (missing.length > 0) throw new Error(`Missing required secrets: ${missing.join(', ')}`);

  const lookbackMin = parseOptionalNumber(env.FIRST_RUN_LOOKBACK_MINUTES) ?? 30;
  return {
    monitor: parseMonitorConfig(env.MONITOR_CONFIG),
    mode,
    xBase: env.X_API_BASE.replace(/\/+$/, ''),
    xToken: env.X_BEARER_TOKEN,
    larkBase: env.LARK_API_BASE.replace(/\/+$/, ''),
    webhook:
      mode === 'webhook'
        ? { url: env.LARK_WEBHOOK_URL, secret: present(env.LARK_WEBHOOK_SECRET) ? env.LARK_WEBHOOK_SECRET : null }
        : null,
    app:
      mode === 'app'
        ? { id: env.LARK_APP_ID, secret: env.LARK_APP_SECRET, chatId: env.LARK_CHAT_ID }
        : null,
    verificationToken: present(env.LARK_VERIFICATION_TOKEN) ? env.LARK_VERIFICATION_TOKEN : null,
    firstRunLookbackMs: Math.max(1, lookbackMin) * 60_000,
    lowCreditUsd: parseOptionalNumber(env.LOW_CREDIT_USD),
    heartbeatHourUtc: parseOptionalNumber(env.HEARTBEAT_HOUR_UTC),
  };
}
