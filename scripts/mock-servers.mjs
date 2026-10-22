// Local stand-in for X and Lark, so the Worker can be run end to end with no real keys and no spend.
//   node scripts/mock-servers.mjs            (listens on 127.0.0.1:8799)
// Control it with plain HTTP:
//   POST /__set    {"status":200,"posts":[{"id":"1","text":"...","user":"alice","followers":100}]}
//   GET  /__sent   everything "Lark" received (webhook posts and app messages)
//   GET  /__calls  the X search URLs the Worker called
//   POST /__reset
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8799);
let state = { status: 200, posts: [], credits: 50 };
let sent = [];
let calls = [];

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

function searchBody(posts) {
  const users = new Map();
  for (const p of posts) {
    const username = p.user ?? 'alice';
    users.set(username, { id: `u_${username}`, username, public_metrics: { followers_count: p.followers ?? 100 } });
  }
  const newest = posts.reduce((m, p) => (m === null || BigInt(p.id) > BigInt(m) ? p.id : m), null);
  return {
    data: posts.map((p) => ({
      id: p.id,
      text: p.text,
      created_at: new Date().toISOString(),
      author_id: `u_${p.user ?? 'alice'}`,
      public_metrics: { like_count: p.likes ?? 0, retweet_count: p.reposts ?? 0 },
    })),
    includes: { users: [...users.values()] },
    meta: { ...(newest ? { newest_id: newest } : {}), result_count: posts.length },
  };
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const body = await readBody(req);
    const json = () => (body ? JSON.parse(body) : {});

    if (url.pathname === '/2/tweets/search/recent') {
      calls.push(url.search);
      if (state.status !== 200) {
        return send(res, state.status, { title: 'Payment Required', detail: 'Your credits are depleted', type: 'about:blank' });
      }
      return send(res, 200, searchBody(state.posts));
    }
    if (url.pathname === '/2/usage/credits') {
      return send(res, 200, { data: { total_balance: state.credits, prepaid_balance: state.credits, free_balance: 0, free_grants: [] } });
    }
    if (url.pathname.startsWith('/hook')) {
      const b = json();
      sent.push({ via: 'webhook', msg_type: b.msg_type, title: b.card?.header?.title?.content, text: b.content?.text, signed: Boolean(b.sign), body: b });
      return send(res, 200, { code: 0, msg: 'success' });
    }
    if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
      return send(res, 200, { code: 0, msg: 'ok', tenant_access_token: 't-local', expire: 7200 });
    }
    if (url.pathname === '/open-apis/im/v1/messages') {
      const b = json();
      const content = JSON.parse(b.content);
      sent.push({
        via: 'app', msg_type: b.msg_type, chat: b.receive_id, uuid: b.uuid, auth: req.headers.authorization,
        title: content.header?.title?.content, text: content.text, body: content,
      });
      return send(res, 200, { code: 0, msg: 'success', data: { message_id: 'om_local' } });
    }
    if (url.pathname === '/__set') {
      state = { ...state, ...json() };
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__sent') return send(res, 200, sent);
    if (url.pathname === '/__calls') return send(res, 200, calls);
    if (url.pathname === '/__reset') {
      state = { status: 200, posts: [], credits: 50 };
      sent = [];
      calls = [];
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: `no mock for ${url.pathname}` });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock X + Lark on http://127.0.0.1:${PORT}`));
