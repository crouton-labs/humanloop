import { writeFileSync } from 'node:fs';
import { claimTicket } from '../inbox/claim.js';

// Writes a genuine claim from a SEPARATE process, as a remote host whose
// heartbeat is already older than the remote-stale window, then exits. The
// parent process then recovers the ticket, proving cross-process stale recovery.
const [dir, ready] = process.argv.slice(2);
const claim = claimTicket(dir!, { host: 'other-host', pid: 1, now: new Date(Date.now() - 31_000) });
writeFileSync(ready!, JSON.stringify(claim));
