import { existsSync, writeFileSync } from 'node:fs';
import { claimTicket } from '../inbox/claim.js';

const [dir, barrier, ready] = process.argv.slice(2);
writeFileSync(ready!, 'ready');
while (!existsSync(barrier!)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
process.stdout.write(JSON.stringify(claimTicket(dir!)));
