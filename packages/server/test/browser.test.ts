import { describe, expect, it } from 'vitest';
import { openerCommand } from '../src/browser.js';

const URL = 'http://localhost:4700';

describe('openerCommand', () => {
  it('honors $BROWSER on every platform', () => {
    expect(openerCommand(URL, 'darwin', 'firefox')).toEqual({ cmd: 'firefox', args: [URL] });
    expect(openerCommand(URL, 'linux', 'firefox')).toEqual({ cmd: 'firefox', args: [URL] });
  });

  it('splits a $BROWSER that carries arguments', () => {
    expect(openerCommand(URL, 'darwin', 'open -a Firefox')).toEqual({
      cmd: 'open',
      args: ['-a', 'Firefox', URL],
    });
  });

  it('uses open on macOS', () => {
    expect(openerCommand(URL, 'darwin', undefined)).toEqual({ cmd: 'open', args: [URL] });
  });

  it('uses cmd /c start on Windows', () => {
    expect(openerCommand(URL, 'win32', undefined)).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', URL],
    });
  });

  it('uses xdg-open elsewhere', () => {
    expect(openerCommand(URL, 'linux', undefined)).toEqual({ cmd: 'xdg-open', args: [URL] });
  });

  it('treats an empty $BROWSER as unset', () => {
    expect(openerCommand(URL, 'darwin', '')).toEqual({ cmd: 'open', args: [URL] });
  });
});
