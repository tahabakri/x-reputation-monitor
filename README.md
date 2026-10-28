# X Reputation Monitor

A small, read-only monitor for negative posts about **your brand** on X. Every 5 minutes a Cloudflare Worker asks X
for new posts that mention your brand **and** a negative keyword (scam, frozen, stuck, lawsuit, ...), and posts
each one to a Lark group as an alert card. It never posts or replies on X: a human decides what to do.

```
Cloudflare cron (*/5)  ->  X recent search (only matches)  ->  drop noise / own accounts / repeats
                                                           ->  Lark alert card  ->  team clicks status buttons
```

Runs on the Cloudflare Workers **Free** plan. The only cost is the X API itself.

## What costs money

| Part | Cost |
|---|---|
| Cloudflare Worker + cron + D1 database | $0 on the Free plan (1 of 5 cron triggers, ~300 runs/day of 100,000) |
| Lark webhook / app | $0 |
| **X API** | Pay per post returned. X has no free tier for new developers; you buy credits up front. Check X's current pricing page. |

The brand + keyword filter is inside the search query, so X only returns (and bills) matching posts.
Volume depends on how often people post negatively about you, not on how often the Worker runs.

## What an alert looks like

Status, Category (Legal / Funds / Reputation / Support), Priority (P1-P3), User, Engagement (followers, likes,
reposts), the post text, a link, post time (UTC) and a suggested action.

## Two Lark modes

| `LARK_MODE` | What you get | What you need |
|---|---|---|
| `webhook` (default) | Alert cards. A button opens the post on X. **No status tracking.** | Lark custom-bot webhook URL |
| `app` | Cards with **Reply / Ignore / Escalate / Legal review** and **Replied / Waiting / Closed** buttons. The card shows **who** set each status and when, plus a short history. Ignore also closes the case. | A small Lark app (App ID, App Secret, Verification Token, group chat id) |

Lark custom-bot webhooks cannot receive button clicks, so "who updated it" needs `app` mode.
Start in `webhook` mode to prove the pipeline, then switch.

## Your brand config (private, never committed)

Nothing about your brand is in this repo. You give it to the Worker as one secret, `MONITOR_CONFIG`:

```bash
cp monitor.config.example.json monitor.config.json   # git-ignored; edit it
```

| Field | Meaning |
|---|---|
| `brandName` | Shown in warnings, e.g. "ExampleCo mentions are NOT being checked" |
| `brandTerms` | A post must contain one of these (words or `@handles`) |
| `ownAccounts` | Your own handles: their posts never alert (also excluded in the X query) |
| `ignoreAccounts` | Optional. More handles to skip, e.g. affiliates or fan accounts. Filtered after the pull, so they do not use up query length (but are still billed) |
| `keywords` | Optional. Lists per category `legal`, `scam`, `funds`, `support`. Missing categories use generic defaults. |
| `caseSensitive` | Optional. Keywords that only count in this exact casing when labelling (default `["SEC"]`, since "5 sec" means seconds) |

The Worker refuses to run (and spends nothing on X) until `MONITOR_CONFIG` is set and valid.

## Setup (webhook mode)

1. **Lark group:** add a *Custom Bot* to the group and copy its webhook URL. If you turn on *custom keywords* for the bot,
   add `X` (every message contains it). If you turn on *signature verification*, keep the secret for step 3.
2. **Deploy once** (creates the Worker and its D1 database; it reports missing secrets until step 3, which is expected):
   ```bash
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
3. **Secrets.** Wrangler asks for each value in a prompt, so it never lands in shell history or a file:
   ```bash
   npx wrangler secret put X_BEARER_TOKEN
   npx wrangler secret put LARK_WEBHOOK_URL
   npx wrangler secret put LARK_WEBHOOK_SECRET   # only if signature verification is on
   ```
   And your brand config:
   ```bash
   # bash
   npx wrangler secret put MONITOR_CONFIG < monitor.config.json
   ```
   ```powershell
   # PowerShell
   Get-Content -Raw monitor.config.json | npx wrangler secret put MONITOR_CONFIG
   ```
4. **Test:** from a spare account post something that matches, e.g. `<your brand> withdrawal stuck test`. Within one
   5-minute cycle a card should appear: Category *Funds / account*, Priority *P3*. Watch it with `npx wrangler tail`.

## Switch on status buttons (app mode)

Do the steps in this order: the Worker only answers Lark's callback check once the secrets are set and the mode is `app`.

1. Lark developer console: create a custom app, enable **Bot**, grant `im:message:send_as_bot` (and `im:chat:readonly` to look up the chat id), publish a version, and add the bot to the alert group.
2. Copy the **App ID** and **App Secret** (Credentials & Basic Info) and the **Verification Token** (Events & Callbacks > Encryption Strategy). Leave **Encrypt Key** empty (encrypted callbacks are refused).
3. Get the group's chat id (`oc_...`): with a tenant token for the app, `GET https://open.larksuite.com/open-apis/im/v1/chats` lists the groups the bot is in.
4. Set the secrets, flip the mode, redeploy:
   ```bash
   npx wrangler secret put LARK_APP_ID
   npx wrangler secret put LARK_APP_SECRET
   npx wrangler secret put LARK_CHAT_ID
   npx wrangler secret put LARK_VERIFICATION_TOKEN
   # in wrangler.jsonc change  "LARK_MODE": "app"  then:
   npx wrangler deploy
   ```
5. Only now: Events & Callbacks > Callback Configuration, send callbacks to the developer's server:
   `https://x-reputation-monitor.<your-subdomain>.workers.dev/lark/callback` (the deploy output prints it). Add the card action callback (`card.action.trigger`). Lark sends a one-time challenge when you save it; the Worker answers it. Publish the app version again.

## When things go wrong (it tells Lark)

| Situation | What the group sees |
|---|---|
| X rejects the token, or credits / spend cap are used up | Warning **immediately**, once; repeats every 6 h while broken |
| X outage / rate limit / network | Warning after 10 minutes of failing; repeats every 6 h |
| Back to normal | "X MONITOR RECOVERED" |
| X credit balance below `LOW_CREDIT_USD` (default $10) | Low-credit warning, at most once a day (balance checked every 6 h) |
| Worker or cron itself stops | No daily "X monitor is running" message at `HEARTBEAT_HOUR_UTC` (default 06:00 UTC, empty = off) |
| Burst of matches in one cycle | One notice with an X search link; the first 30 are posted individually |

If Lark itself is unreachable nothing can be posted; the error is in `wrangler tail` / Workers Logs, and the cursor
does not move, so the missed posts are retried on the next run.

## Tuning

Keywords and handles: `MONITOR_CONFIG`. Everything else is in [`src/config.ts`](src/config.ts): promo-noise patterns,
P1/P2/P3 thresholds, alert limits. The priority and suggested-action rules are starting guesses: review them against
real cases after a couple of weeks. After editing, `npm test` then `npx wrangler deploy`. If you change `wrangler.jsonc`
(vars or bindings), run `npm run types`.

Known trade-offs:
- X also matches the brand in an author's handle and in link targets. A post only alerts if the brand and a keyword are in its visible text; the rest are dropped after the pull (and still billed).
- The promo filter runs after the pull, so a real user writing "my airdrop is stuck" is dropped, and the post is still billed.
- `SEC` is also how people write "seconds". X search is case-insensitive so such posts are still pulled (and billed);
  only an upper-case `SEC` is labelled legal.
- Alerts are de-duplicated by post id only, not by author or topic.

## Local checks (no keys, no spend)

```bash
npm run typecheck && npm test            # unit tests (fake X and Lark in memory)
node scripts/mock-servers.mjs            # fake X + Lark on :8799
npx wrangler dev --test-scheduled --var X_API_BASE:http://127.0.0.1:8799 --var LARK_API_BASE:http://127.0.0.1:8799
curl http://127.0.0.1:8787/__scheduled   # run one cycle; read what "Lark" got at http://127.0.0.1:8799/__sent
```
Local runs read `.dev.vars` (git-ignored; copy `.dev.vars.example`). Secrets are never in the repo.

## Status

Tested with unit tests and a local end-to-end run against mock X and Lark servers. **Not yet verified against live X or a
live Lark tenant.** Things to eyeball on first live use: how names render in `app`-mode cards, registering the callback URL,
and whether your X token can read `/2/usage/credits` (if not, the low-credit check is skipped and nothing else breaks).

Not affiliated with or endorsed by X or Lark. You are responsible for following the X developer terms.

## License

MIT, see [LICENSE](LICENSE).
