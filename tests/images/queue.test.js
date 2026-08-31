import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../../src/images/queue.js';

const tick = ms => new Promise(r => setTimeout(r, ms));

async function settle(queue, batchId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const b = queue.getBatch(batchId);
    if (b?.finished) return b;
    await tick(10);
  }
  throw new Error('batch did not finish in time');
}

test('every job runs and the batch reports finished', async () => {
  const seen = [];
  const queue = createQueue({ processJob: async job => { seen.push(job.name); } });
  const { batchId, total } = queue.addBatch([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);

  assert.equal(total, 3);
  const batch = await settle(queue, batchId);
  assert.equal(batch.done, 3);
  assert.equal(batch.failed.length, 0);
  assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
});

test('no more jobs run at once than the concurrency limit', async () => {
  let running = 0;
  let peak = 0;
  const queue = createQueue({
    concurrency: 2,
    processJob: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick(20);
      running -= 1;
    },
  });
  const { batchId } = queue.addBatch(Array.from({ length: 8 }, (_, i) => ({ name: `p${i}` })));
  await settle(queue, batchId);
  assert.equal(peak, 2);
});

test('one failing job does not stop the rest of the batch', async () => {
  const queue = createQueue({
    processJob: async job => {
      if (job.name === 'bad') throw new Error('unsupported file type');
    },
  });
  const { batchId } = queue.addBatch([{ name: 'ok1' }, { name: 'bad' }, { name: 'ok2' }]);

  const batch = await settle(queue, batchId);
  assert.equal(batch.finished, true);
  assert.equal(batch.done, 2);
  assert.equal(batch.failed.length, 1);
  assert.equal(batch.failed[0].name, 'bad');
  assert.match(batch.failed[0].reason, /unsupported file type/);
});

test('progress is observable while the batch is still running', async () => {
  const queue = createQueue({ concurrency: 1, processJob: async () => tick(40) });
  const { batchId } = queue.addBatch([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);

  await tick(10);
  const mid = queue.getBatch(batchId);
  assert.equal(mid.finished, false);
  assert.ok(mid.done < 3, 'batch should not be complete yet');

  await settle(queue, batchId);
});

test('job objects reach processJob untouched', async () => {
  // The route layer passes { path, name, categoryId }; the queue must not
  // care about or mangle fields it does not understand.
  const received = [];
  const queue = createQueue({ processJob: async job => { received.push(job); } });
  const { batchId } = queue.addBatch([
    { path: '/tmp/staged-abc', name: 'shot.jpg', categoryId: '7' },
  ]);

  await settle(queue, batchId);
  assert.deepEqual(received, [
    { path: '/tmp/staged-abc', name: 'shot.jpg', categoryId: '7' },
  ]);
});

test('an unknown batch id returns undefined', () => {
  const queue = createQueue({ processJob: async () => {} });
  assert.equal(queue.getBatch('nope'), undefined);
});

test('a finished batch is evicted after its retention window', async () => {
  const queue = createQueue({ processJob: async () => {}, retentionMs: 50 });
  const { batchId } = queue.addBatch([{ name: 'a' }]);
  await settle(queue, batchId);
  assert.ok(queue.getBatch(batchId), 'batch is readable immediately after finishing');

  await tick(120);
  assert.equal(queue.getBatch(batchId), undefined);
});

test('batches submitted concurrently do not mix their progress', async () => {
  const queue = createQueue({ concurrency: 2, processJob: async () => tick(5) });
  const first = queue.addBatch([{ name: 'a' }, { name: 'b' }]);
  const second = queue.addBatch([{ name: 'c' }]);

  await settle(queue, first.batchId);
  await settle(queue, second.batchId);

  assert.equal(queue.getBatch(first.batchId).total, 2);
  assert.equal(queue.getBatch(second.batchId).total, 1);
});
