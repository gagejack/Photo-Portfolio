// An in-memory job queue with a bounded worker pool.
//
// Deliberately knows nothing about photos, sharp, or the database: the caller
// supplies `processJob`. That keeps this file testable with a fake and keeps
// database concerns out of `src/images/`.
//
// State is lost on restart. That is the accepted trade-off for a single-admin
// site — see the design doc; anything staged before a restart is swept on boot.
import { randomUUID } from 'node:crypto';
import os from 'node:os';

const DEFAULT_CONCURRENCY = Math.min(os.cpus().length, 4);

// Five minutes is long enough for a client to notice its batch finished and
// short enough that a long-lived process does not accumulate dead batches.
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;

export function createQueue({
  processJob,
  concurrency = DEFAULT_CONCURRENCY,
  retentionMs = DEFAULT_RETENTION_MS,
} = {}) {
  const jobs = [];
  const batches = new Map();
  let active = 0;

  function finish(batchId) {
    const batch = batches.get(batchId);
    if (!batch || batch.finished) return;
    if (batch.done + batch.failed.length < batch.total) return;

    batch.finished = true;
    const timer = setTimeout(() => batches.delete(batchId), retentionMs);
    // Do not hold the event loop open just to evict a finished batch.
    timer.unref?.();
  }

  async function runOne(entry) {
    const batch = batches.get(entry.batchId);
    try {
      await processJob(entry.job);
      if (batch) batch.done += 1;
    } catch (err) {
      if (batch) batch.failed.push({ name: entry.job.name, reason: err.message });
    } finally {
      finish(entry.batchId);
    }
  }

  function pump() {
    while (active < concurrency && jobs.length > 0) {
      const entry = jobs.shift();
      active += 1;
      runOne(entry).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  function addBatch(list) {
    const batchId = randomUUID();
    batches.set(batchId, {
      total: list.length,
      done: 0,
      failed: [],
      finished: false,
    });

    for (const job of list) jobs.push({ batchId, job });

    // An empty batch is finished the moment it is created.
    if (list.length === 0) finish(batchId);
    pump();

    return { batchId, total: list.length };
  }

  function getBatch(batchId) {
    const batch = batches.get(batchId);
    if (!batch) return undefined;
    return {
      total: batch.total,
      done: batch.done,
      failed: [...batch.failed],
      finished: batch.finished,
    };
  }

  return { addBatch, getBatch };
}
