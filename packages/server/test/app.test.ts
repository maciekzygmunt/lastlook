import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('GET /api/health', () => {
  it('returns liveness plus repoPath and version', async () => {
    const app = createApp({
      repoPath: '/tmp/some-repo',
      version: '0.1.0',
      dataDir: join(tmpdir(), 'lastlook-unused-data'),
    });
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      repoPath: '/tmp/some-repo',
      version: '0.1.0',
    });
  });
});
