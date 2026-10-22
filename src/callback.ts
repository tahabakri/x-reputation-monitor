import { buildAppCard } from './card';
import { applyUpdate, isAction, isStatus } from './cases';
import { getCase, saveCaseState } from './db';
import { safeEqual } from './util';

const MAX_BODY = 64 * 1024;
const CASE_ID = /^\d{1,25}$/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface CallbackBody {
  type?: string;
  challenge?: string;
  token?: string;
  encrypt?: string;
  header?: { token?: string; event_type?: string };
  event?: {
    operator?: { open_id?: string };
    action?: { value?: { c?: unknown; k?: unknown; v?: unknown } };
  };
}

// Lark calls this when someone clicks a status/action button on an alert card. It must answer
// within 3 seconds, and the answer is the new version of the card.
export async function handleLarkCallback(request: Request, env: Env, now = Date.now()): Promise<Response> {
  if (env.LARK_MODE !== 'app' || !env.LARK_VERIFICATION_TOKEN) return json({ error: 'not enabled' }, 404);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json({ error: 'too large' }, 413);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413);
  let body: CallbackBody;
  try {
    body = JSON.parse(raw) as CallbackBody;
  } catch {
    return json({ error: 'bad json' }, 400);
  }
  if (body.encrypt) {
    return json({ error: 'encrypted callbacks are not supported: clear the Encrypt Key in the Lark app' }, 400);
  }

  const token = body.header?.token ?? body.token;
  if (typeof token !== 'string' || !(await safeEqual(token, env.LARK_VERIFICATION_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  // Lark sends this once when the callback URL is saved in the developer console.
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return json({ challenge: body.challenge });
  }
  if (body.header?.event_type !== 'card.action.trigger') return json({});

  const value = body.event?.action?.value;
  const by = body.event?.operator?.open_id;
  if (
    !value ||
    typeof value.c !== 'string' ||
    !CASE_ID.test(value.c) ||
    (value.k !== 'status' && value.k !== 'action') ||
    typeof value.v !== 'string' ||
    !(value.k === 'status' ? isStatus(value.v) : isAction(value.v)) ||
    typeof by !== 'string'
  ) {
    return json({ toast: { type: 'error', content: 'Unrecognised button' } });
  }

  const current = await getCase(env.DB, value.c);
  if (!current) return json({ toast: { type: 'error', content: 'This case is no longer tracked' } });

  const next = applyUpdate(current, value.k, value.v, by, now);
  if (!next) return json({ toast: { type: 'info', content: 'Already set' } });

  await saveCaseState(env.DB, next);
  return json({
    toast: { type: 'success', content: `Marked ${value.v}` },
    card: { type: 'raw', data: buildAppCard(next) },
  });
}
