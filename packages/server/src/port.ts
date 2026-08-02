import { createServer } from 'node:net';

export const BASE_PORT = 4700;

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export async function findFreePort(base: number): Promise<number> {
  for (let port = base; port < base + 100; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`no free port found in range ${base}-${base + 99}`);
}
