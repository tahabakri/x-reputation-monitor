import { handleLarkCallback } from './callback';
import { runMonitor } from './monitor';

export default {
  // Cron Trigger: every 5 minutes (see wrangler.jsonc).
  async scheduled(_controller, env): Promise<void> {
    try {
      const summary = await runMonitor(env);
      console.log(JSON.stringify({ event: 'run', ...summary }));
    } catch (err) {
      console.error(JSON.stringify({ event: 'run_failed', error: err instanceof Error ? err.message : String(err) }));
      throw err;
    }
  },

  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/lark/callback') return handleLarkCallback(request, env);
    if (request.method === 'GET' && pathname === '/') return new Response('x-reputation-monitor: ok\n');
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
