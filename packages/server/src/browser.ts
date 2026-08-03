import { spawn } from 'node:child_process';

export interface OpenerCommand {
  cmd: string;
  args: string[];
}

/** Platform browser opener; a non-empty $BROWSER wins everywhere. */
export function openerCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  browserEnv: string | undefined = process.env.BROWSER
): OpenerCommand {
  if (browserEnv) {
    // $BROWSER may carry arguments ("open -a Firefox") per the loose env convention
    const [cmd = browserEnv, ...args] = browserEnv.trim().split(/\s+/);
    return { cmd, args: [...args, url] };
  }
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  // the empty string is start's window-title argument — without it, start eats the URL as the title
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/** Fire-and-forget browser launch; a failure is one stderr line, never fatal. */
export function openBrowser(url: string): void {
  const { cmd, args } = openerCommand(url);
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', (err) => {
    console.error(`reviewd: could not open browser (${cmd}): ${err.message}`);
  });
  child.unref();
}
