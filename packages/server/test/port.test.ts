import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort } from '../src/port.js';

const occupied: Server[] = [];

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => {
      occupied.push(srv);
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(occupied.map((s) => new Promise((r) => s.close(r))));
  occupied.length = 0;
});

describe('findFreePort', () => {
  it('returns the base port when it is free', async () => {
    expect(await findFreePort(24700)).toBe(24700);
  });

  it('scans upward past occupied ports', async () => {
    await occupy(24710);
    await occupy(24711);
    expect(await findFreePort(24710)).toBe(24712);
  });
});
