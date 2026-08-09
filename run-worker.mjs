// Download/ingest queue drainer — a separate process from the web server so that
// fetching + R2 uploads never block the request event loop (same design as Sound).
import './server/net.js';
import 'dotenv/config';
import { claimNextJob, updateJob, requeueStuckJobs, getJob } from './server/catalog.js';
import { runJob } from './server/ingest.js';

const CONCURRENCY = parseInt(process.env.INGEST_CONCURRENCY || '2', 10);
let active = 0;

async function tick() {
  requeueStuckJobs();
  while (active < CONCURRENCY) {
    const job = claimNextJob();
    if (!job) break;
    active++;
    (async () => {
      console.log(`[worker] start ${job.kind} ${job.id}`);
      try {
        await runJob(job, { updateJob });
        console.log(`[worker] done ${job.id}`);
      } catch (e) {
        console.error(`[worker] fail ${job.id}:`, e.message);
        updateJob(job.id, { status: 'error', error: e.message });
      } finally {
        active--;
      }
    })();
  }
}

console.log(`[worker] radical-books ingest worker up (concurrency ${CONCURRENCY})`);
setInterval(tick, 3000);
tick();
