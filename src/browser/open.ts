import { spawn } from 'node:child_process';

/**
 * Best-effort open a URL in the user's default browser: `open` on macOS,
 * `xdg-open` on Linux. Never throws and never blocks the handoff — an
 * unsupported platform or a missing binary just prints the URL so the human
 * can open it by hand.
 */
export function openBrowser(url: string): void {
  const bin = process.platform === 'darwin' ? 'open'
    : process.platform === 'linux' ? 'xdg-open'
    : null;
  if (bin === null) {
    process.stderr.write(`humanloop: open this URL in a browser: ${url}\n`);
    return;
  }
  try {
    const child = spawn(bin, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      process.stderr.write(`humanloop: could not launch "${bin}" — open this URL manually: ${url}\n`);
    });
    child.unref();
  } catch {
    process.stderr.write(`humanloop: open this URL in a browser: ${url}\n`);
  }
}
