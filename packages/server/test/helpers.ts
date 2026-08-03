import { createServer, type Server } from 'node:net';

/** Occupy a port so the code under test sees it as taken. Caller closes the returned server. */
export function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

export function closeAll(servers: Server[]): Promise<unknown> {
  return Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}

export async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}
