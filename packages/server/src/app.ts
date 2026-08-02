import { Hono } from 'hono';
import { DIFF_MODES, DiffError, computeDiff, type DiffMode } from './diff.js';

export interface AppContext {
  repoPath: string;
  version: string;
}

export interface HealthResponse {
  ok: boolean;
  repoPath: string;
  version: string;
}

function isDiffMode(mode: string | undefined): mode is DiffMode {
  return DIFF_MODES.includes(mode as DiffMode);
}

export function createApp({ repoPath, version }: AppContext): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true, repoPath, version }));

  app.get('/api/diff', async (c) => {
    const mode = c.req.query('mode');
    if (!isDiffMode(mode)) {
      return c.json({ error: `mode must be one of: ${DIFF_MODES.join(', ')}` }, 400);
    }
    try {
      return c.json(await computeDiff(repoPath, mode));
    } catch (error) {
      if (error instanceof DiffError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  return app;
}
