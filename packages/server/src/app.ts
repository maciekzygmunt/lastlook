import { Hono } from 'hono';

export interface AppContext {
  repoPath: string;
  version: string;
}

export interface HealthResponse {
  ok: boolean;
  repoPath: string;
  version: string;
}

export function createApp({ repoPath, version }: AppContext): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true, repoPath, version }));

  return app;
}
