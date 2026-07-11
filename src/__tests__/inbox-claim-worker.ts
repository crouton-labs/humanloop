import { existsSync, writeFileSync } from 'node:fs';
import { claimTicket } from '../inbox/claim.js';

const [dir, barrier, ready, result, release] = process.argv.slice(2);
const spin = (path: string) => { while (!existsSync(path)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); };
writeFileSync(ready!, 'ready');
spin(barrier!);
const claim = claimTicket(dir!);
writeFileSync(result!, JSON.stringify(claim));
process.stdout.write(JSON.stringify(claim));
// Stay alive until the parent has read BOTH results and releases us. A same-host
// claim is reclaimable the instant its holder's pid dies, so a winner that exited
// early would legitimately free its claim for the peer — that is designed
// stale-recovery, not a double-claim. Blocking here keeps both pids live across
// the peer's attempt, so the assertion tests exclusion, not exit timing.
if (release !== undefined) spin(release);
