import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { InboxController } from '../inbox/controller.js';

/** Run the inbox controller in a popup-owned TTY and accept graceful close requests. */
export async function openInboxPopup(controlSocket?: string, roots?: string[]): Promise<void> {
  const controller = new InboxController({ roots });
  const server = controlSocket === undefined ? undefined : createServer((connection) => {
    connection.once('data', (data) => {
      if (data.toString('utf8').trim() === 'close') controller.close();
      connection.end();
    });
  });
  if (server !== undefined && controlSocket !== undefined) {
    try { rmSync(controlSocket, { force: true }); } catch { /* socket ownership is established by listen */ }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(controlSocket, resolve);
    });
  }
  try { await controller.run(); }
  finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    if (controlSocket !== undefined) rmSync(controlSocket, { force: true });
  }
}
