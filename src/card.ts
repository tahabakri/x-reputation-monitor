import { ACTIONS, STATUSES, lastUpdate, type Case } from './cases';
import { CATEGORY_LABEL } from './config';
import { excerpt, fmtCount, fmtUtc, postUrl } from './util';

const OPEN_ID = /^ou_[A-Za-z0-9]+$/;
const HANDLE = /^\w{1,15}$/;

// Renders the person's name in the card (and does not notify them). Only well-formed open_ids are
// ever interpolated into card markdown.
const person = (openId: string): string =>
  OPEN_ID.test(openId) ? `<person id='${openId}' show_name=true show_avatar=false style='normal'></person>` : 'someone';

function stamp(c: Case, field: 'status' | 'action'): string {
  const u = lastUpdate(c, field);
  return u ? ` — ${person(u.by)} · ${fmtUtc(u.at)}` : '';
}

const title = (c: Case): string =>
  `${c.status === 'New' ? 'NEW X MENTION' : `X MENTION · ${c.status.toUpperCase()}`} · ${c.priority}`;

const template = (c: Case): string =>
  c.status === 'Closed' ? 'grey' : c.priority === 'P1' ? 'red' : c.priority === 'P2' ? 'orange' : 'blue';

// Post text and display names are untrusted: they only ever go into plain_text elements, never
// into markdown (markdown could carry <at id=all></at> or phishing links into the group).
function fields(c: Case): string {
  const url = postUrl(HANDLE.test(c.username) ? c.username : 'i', c.id);
  const user = HANDLE.test(c.username) ? `[@${c.username}](https://x.com/${c.username})` : 'unknown';
  const action = c.action
    ? `${c.action}${stamp(c, 'action')}`
    : `not chosen yet (suggested: ${c.suggested})`;
  return [
    `**Status:** ${c.status}${stamp(c, 'status')}`,
    `**Category:** ${CATEGORY_LABEL[c.category]}`,
    `**Priority:** ${c.priority}`,
    `**User:** ${user}`,
    `**Engagement:** ${fmtCount(c.followers)} followers · ${fmtCount(c.likes)} likes · ${fmtCount(c.reposts)} reposts`,
    `**Posted:** ${fmtUtc(c.postedAt)}`,
    `**Action:** ${action}`,
    `**Link:** [${url}](${url})`,
  ].join('\n');
}

function historyMarkdown(c: Case): string | null {
  if (c.history.length === 0) return null;
  const lines = c.history.slice(-5).map((h) => `• ${h.to} — ${person(h.by)} · ${fmtUtc(h.at)}`);
  return `**History**\n${lines.join('\n')}`;
}

function buttonRow(c: Case, field: 'status' | 'action', values: readonly string[]) {
  const current = field === 'status' ? c.status : c.action;
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: values.map((v) => ({
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: v },
          type: v === current ? 'primary_filled' : 'default',
          size: 'small',
          behaviors: [{ type: 'callback', value: { c: c.id, k: field, v } }],
          ...(v === 'Spam'
            ? {
                confirm: {
                  title: { tag: 'plain_text', content: 'Mark as spam?' },
                  text: { tag: 'plain_text', content: `Closes this case and stops all future alerts from @${c.username}.` },
                },
              }
            : {}),
        },
      ],
    })),
  };
}

// Lark app mode: card JSON 2.0 with callback buttons. The card is re-rendered from the stored case
// every time a button is clicked, so it always shows the latest status and who set it.
export function buildAppCard(c: Case): Record<string, unknown> {
  const history = historyMarkdown(c);
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: title(c) }, template: template(c) },
    body: {
      elements: [
        { tag: 'markdown', content: fields(c) },
        { tag: 'div', text: { tag: 'plain_text', content: excerpt(c.text) } },
        ...(history ? [{ tag: 'markdown', content: history }] : []),
        { tag: 'markdown', content: '**What to do**' },
        buttonRow(c, 'action', ACTIONS),
        { tag: 'markdown', content: '**Where it stands**' },
        buttonRow(c, 'status', STATUSES.filter((s) => s !== 'New')),
      ],
    },
  };
}

// Webhook mode: a plain card (custom bots cannot receive button clicks, only open links).
export function buildWebhookCard(c: Case): Record<string, unknown> {
  const url = postUrl(HANDLE.test(c.username) ? c.username : 'i', c.id);
  return {
    header: { title: { tag: 'plain_text', content: title(c) }, template: template(c) },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: fields(c) } },
      { tag: 'div', text: { tag: 'plain_text', content: excerpt(c.text) } },
      {
        tag: 'action',
        actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'Open post on X' }, url, type: 'primary' }],
      },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: 'Webhook mode: status is not tracked. Switch LARK_MODE to "app" for status buttons.' },
        ],
      },
    ],
  };
}
