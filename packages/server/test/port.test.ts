import { type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort } from '../src/port.js';
import { closeAll, listenOn } from './helpers.js';

const occupied: Server[] = [];

async function occupy(port: number): Promise<void> {
  occupied.push(await listenOn(port));
}

afterEach(async () => {
  await closeAll(occupied);
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
