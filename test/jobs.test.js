import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/database.js';
import { retryable } from '../server/jobs.js';

const labId = '00000000-0000-4000-8000-000000000001';
const base = `/api/labs/${labId}`;

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for worker state.');
}

describe('durable local retry jobs', () => {
  let database;
  let app;
  let admin;
  let schema;
  before(async () => {
    let url = process.env.TEST_DATABASE_URL || null;
    if (url) {
      admin = await openDatabase({ url });
      schema = `jobs_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      const parsed = new URL(url);
      parsed.searchParams.set('options', `-c search_path=${schema}`);
      url = parsed.toString();
    }
    database = await openDatabase({ url, dataDir: ':memory:' });
    app = await createApp({
      database,
      deliveryWorker: false,
      rateLimiting: false,
      serveWeb: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });
  beforeEach(async () => {
    await database.query('DELETE FROM captured_requests');
    await database.query('DELETE FROM mock_receipts');
    await database.query('DELETE FROM mock_receivers');
    await database.query('DELETE FROM labs WHERE id <> $1', [labId]);
  });
  after(async () => {
    // All assertions are complete; discard unused keep-alive/preconnect sockets from aborted fetches.
    app.server.closeAllConnections();
    await app.close();
    await database.close();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  });
  async function capture(body = '{"id":"job_event"}') {
    return (
      await app.inject({
        method: 'POST',
        url: '/hooks/local-playground',
        payload: body,
        headers: { 'content-type': 'application/json' },
      })
    ).json().request_id;
  }
  async function config(failFirst = 0, delayMs = 0, guard = true) {
    return app.inject({
      method: 'PUT',
      url: `${base}/receiver`,
      payload: { fail_first: failFirst, delay_ms: delayMs, idempotency_enabled: guard },
    });
  }
  const path = (id) => `${base}/requests/${id}/jobs`;
  const enqueue = (id, settings = {}) =>
    app.inject({
      method: 'POST',
      url: path(id),
      payload: { timeout_ms: 1000, max_attempts: 3, retry_delay_ms: 250, ...settings },
    });
  const history = async (id) => (await app.inject(path(id))).json();
  async function due() {
    await database.query(
      "UPDATE delivery_jobs SET next_attempt_at = now() WHERE state = 'waiting_retry'",
    );
  }

  it('acknowledges a persisted job before HTTP delivery and retries 500 twice before success', async () => {
    await config(2);
    const id = await capture();
    const response = await enqueue(id);
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().state, 'queued');
    assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 0);
    assert.equal((await database.query('SELECT * FROM delivery_jobs')).rows.length, 1);
    await app.deliveryWorker.processOne();
    let job = (await history(id)).jobs[0];
    assert.equal(job.state, 'waiting_retry');
    assert.equal(job.attempt_count, 1);
    assert.equal(job.attempts[0].http_status, 500);
    assert.equal(await app.deliveryWorker.processOne(), false); // Backoff must be respected.
    await due();
    await app.deliveryWorker.processOne();
    job = (await history(id)).jobs[0];
    assert.equal(job.state, 'waiting_retry');
    assert.equal(job.attempt_count, 2);
    const remaining = new Date(job.next_attempt_at) - Date.now();
    assert.ok(remaining > 250 && remaining <= 550);
    await due();
    await app.deliveryWorker.processOne();
    job = (await history(id)).jobs[0];
    assert.equal(job.state, 'succeeded');
    assert.equal(job.attempt_count, 3);
    assert.deepEqual(
      job.attempts.map((run) => run.http_status),
      [500, 500, 200],
    );
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 1);
    assert.equal((await app.inject(`${base}/requests/${id}/replays`)).json().total, 0);
  });

  it('stops at the attempt limit and does not retry conflicts', async () => {
    await config(10);
    const id = await capture();
    await enqueue(id, { max_attempts: 2 });
    await app.deliveryWorker.processOne();
    await due();
    await app.deliveryWorker.processOne();
    let job = (await history(id)).jobs[0];
    assert.equal(job.state, 'failed');
    assert.equal(job.attempt_count, 2);
    assert.equal(await app.deliveryWorker.processOne(), false);
    await config();
    await app.inject({
      method: 'POST',
      url: '/mock/local-playground',
      payload: '{"id":"job_event","different":true}',
      headers: { 'content-type': 'application/json' },
    });
    await enqueue(id);
    await app.deliveryWorker.processOne();
    job = (await history(id)).jobs[0];
    assert.equal(job.state, 'failed');
    assert.equal(job.attempt_count, 1);
    assert.equal(job.attempts[0].http_status, 409);
  });

  it('records each timed-out attempt while the guarded receiver processes one action', async () => {
    await config(0, 300);
    const id = await capture();
    await enqueue(id, { timeout_ms: 150, max_attempts: 2 });
    await app.deliveryWorker.processOne();
    await due();
    await app.deliveryWorker.processOne();
    const job = (await history(id)).jobs[0];
    assert.equal(job.state, 'failed');
    assert.deepEqual(
      job.attempts.map((run) => run.state),
      ['timeout', 'timeout'],
    );
    const receiver = (await app.inject(`${base}/receiver`)).json();
    assert.equal(receiver.processed_count, 1);
    assert.equal(receiver.deduplicated_count, 1);
  });

  it('excludes duplicate jobs, manual replay, receiver reset and inbox clear while pending', async () => {
    const id = await capture();
    const job = (await enqueue(id)).json();
    assert.equal((await enqueue(id)).statusCode, 409);
    assert.equal(
      (await app.inject({ method: 'POST', url: `${base}/requests/${id}/replays`, payload: {} }))
        .statusCode,
      409,
    );
    assert.equal((await config()).statusCode, 409);
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/requests`,
          payload: { confirm: 'Payment playground' },
        })
      ).statusCode,
      409,
    );
    await app.inject({ method: 'POST', url: `${path(id)}/${job.id}/cancel`, payload: {} });
    assert.equal((await history(id)).jobs[0].state, 'cancelled');
    assert.equal(await app.deliveryWorker.processOne(), false);
    assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 0);
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/requests`,
          payload: { confirm: 'Payment playground' },
        })
      ).statusCode,
      200,
    );
    assert.equal((await database.query('SELECT * FROM delivery_jobs')).rows.length, 0);
  });

  it('cancels after an in-flight attempt and preserves what actually reached the receiver', async () => {
    await config(10, 250);
    const id = await capture();
    const job = (await enqueue(id)).json();
    const processing = app.deliveryWorker.processOne();
    await waitFor(async () => (await database.query('SELECT * FROM mock_receipts')).rows.length);
    const cancel = await app.inject({
      method: 'POST',
      url: `${path(id)}/${job.id}/cancel`,
      payload: {},
    });
    assert.equal(cancel.json().cancel_requested, true);
    assert.equal(cancel.json().state, 'running');
    await processing;
    const saved = (await history(id)).jobs[0];
    assert.equal(saved.state, 'cancelled');
    assert.equal(saved.attempt_count, 1);
    assert.equal(saved.attempts[0].http_status, 500);
    assert.equal(await app.deliveryWorker.processOne(), false);
  });

  it('recovers an expired running lease as an uncertain attempt without exceeding its budget', async () => {
    const id = await capture();
    const job = (await enqueue(id, { max_attempts: 2 })).json();
    await database.query(
      "UPDATE delivery_jobs SET state = 'running', attempt_count = 1, lease_started_at = now() - interval '1 minute' WHERE id = $1",
      [job.id],
    );
    await database.query(
      `INSERT INTO replay_runs (id, lab_id, capture_id, timeout_ms, delivery_job_id, attempt_number, started_at) VALUES ($1,$2,$3,1000,$4,1,now() - interval '1 minute')`,
      [randomUUID(), labId, id, job.id],
    );
    await app.deliveryWorker.processOne();
    const saved = (await history(id)).jobs[0];
    assert.equal(saved.state, 'succeeded');
    assert.equal(saved.attempt_count, 2);
    assert.deepEqual(
      saved.attempts.map((run) => run.state),
      ['interrupted', 'succeeded'],
    );
    const exhausted = (await enqueue(id, { max_attempts: 1 })).json();
    await database.query(
      "UPDATE delivery_jobs SET state = 'running', attempt_count = 1, lease_started_at = now() - interval '1 minute' WHERE id = $1",
      [exhausted.id],
    );
    await app.deliveryWorker.processOne();
    assert.equal((await history(id)).jobs[0].state, 'failed');
    assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 1);
  });

  it('rolls back a claimed attempt when its running state cannot be stored', async () => {
    const id = await capture();
    await enqueue(id);
    const original = database.transaction;
    database.transaction = (callback) =>
      original((tx) =>
        callback({
          query(sql, params) {
            if (sql.includes("UPDATE delivery_jobs SET state = 'running'"))
              throw new Error('Lease storage unavailable');
            return tx.query(sql, params);
          },
        }),
      );
    try {
      await assert.rejects(app.deliveryWorker.processOne(), /Lease storage unavailable/);
    } finally {
      database.transaction = original;
    }
    assert.equal((await history(id)).jobs[0].attempt_count, 0);
    assert.equal((await database.query('SELECT * FROM replay_runs')).rows.length, 0);
    assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 0);
    await app.deliveryWorker.processOne();
    assert.equal((await history(id)).jobs[0].state, 'succeeded');
  });

  it('recovers a result-commit failure after delivery without repeating a protected demo action', async () => {
    await config();
    const id = await capture();
    const job = (await enqueue(id)).json();
    const original = database.transaction;
    database.transaction = (callback) =>
      original((tx) =>
        callback({
          query(sql, params) {
            if (sql.includes('UPDATE delivery_jobs SET state = $2'))
              throw new Error('Result commit unavailable');
            return tx.query(sql, params);
          },
        }),
      );
    try {
      await assert.rejects(app.deliveryWorker.processOne(), /Result commit unavailable/);
    } finally {
      database.transaction = original;
    }
    assert.equal((await history(id)).jobs[0].state, 'running');
    assert.equal((await history(id)).jobs[0].attempts[0].state, 'running');
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 1);
    await database.query(
      "UPDATE delivery_jobs SET lease_started_at = now() - interval '1 minute' WHERE id = $1",
      [job.id],
    );
    await app.deliveryWorker.processOne();
    const saved = (await history(id)).jobs[0];
    assert.equal(saved.state, 'succeeded');
    assert.deepEqual(
      saved.attempts.map((run) => run.state),
      ['interrupted', 'succeeded'],
    );
    assert.equal(JSON.parse(saved.attempts[1].response_body).outcome, 'duplicate');
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 1);
  });

  it('does not acknowledge or deliver a job when its initial storage fails', async () => {
    const id = await capture();
    const original = database.transaction;
    database.transaction = (callback) =>
      original((tx) =>
        callback({
          query(sql, params) {
            if (sql.includes('INSERT INTO delivery_jobs'))
              throw new Error('Queue storage unavailable');
            return tx.query(sql, params);
          },
        }),
      );
    try {
      assert.equal((await enqueue(id)).statusCode, 500);
    } finally {
      database.transaction = original;
    }
    assert.equal((await database.query('SELECT * FROM delivery_jobs')).rows.length, 0);
    assert.equal(await app.deliveryWorker.processOne(), false);
    assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 0);
  });

  it('paginates jobs in stable order when timestamps tie', async () => {
    const id = await capture();
    for (let i = 0; i < 12; i++)
      await database.query(
        `INSERT INTO delivery_jobs (id,lab_id,capture_id,state,max_attempts,timeout_ms,retry_delay_ms,created_at) VALUES ($1,$2,$3,'cancelled',3,1000,250,'2026-10-06T12:00:00Z')`,
        [randomUUID(), labId, id],
      );
    const first = await history(id);
    const second = (await app.inject(`${path(id)}?offset=10`)).json();
    assert.equal(first.total, 12);
    assert.equal(first.jobs.length, 10);
    assert.equal(second.jobs.length, 2);
    assert.equal(new Set([...first.jobs, ...second.jobs].map((job) => job.id)).size, 12);
  });

  it('validates job settings and isolates other labs from job history and cancellation', async () => {
    const id = await capture();
    assert.equal((await enqueue(id, { max_attempts: 6 })).statusCode, 400);
    assert.equal((await enqueue(id, { retry_delay_ms: 249 })).statusCode, 400);
    const job = (await enqueue(id)).json();
    const other = (
      await app.inject({ method: 'POST', url: '/api/labs', payload: { name: 'Other jobs' } })
    ).json();
    const otherPath = `/api/labs/${other.id}/requests/${id}/jobs`;
    assert.equal((await app.inject(otherPath)).statusCode, 404);
    assert.equal(
      (await app.inject({ method: 'POST', url: otherPath, payload: {} })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: `${otherPath}/${job.id}/cancel`, payload: {} }))
        .statusCode,
      404,
    );
    const wrongCapture = await capture('{"id":"different_capture"}');
    assert.equal((await history(wrongCapture)).active_job.id, job.id);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${path(wrongCapture)}/${job.id}/cancel`,
          payload: {},
        })
      ).statusCode,
      404,
    );
  });
});

it('retries transient HTTP outcomes while terminal client errors remain terminal', () => {
  for (const status of [408, 429, 500, 503, null])
    assert.equal(retryable({ state: 'failed', http_status: status }), true);
  for (const status of [400, 401, 403, 404, 409, 302])
    assert.equal(retryable({ state: 'failed', http_status: status }), false);
  assert.equal(retryable({ state: 'timeout', http_status: 200 }), true);
  assert.equal(retryable({ state: 'succeeded', http_status: 200 }), false);
});

it('resumes a persisted queued job after an embedded restart with the live worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webhook-jobs-'));
  let database;
  let app;
  try {
    database = await openDatabase({ url: null, dataDir: directory });
    app = await createApp({
      database,
      deliveryWorker: false,
      rateLimiting: false,
      serveWeb: false,
    });
    await app.inject({
      method: 'PUT',
      url: `${base}/receiver`,
      payload: { fail_first: 1, delay_ms: 0, idempotency_enabled: true },
    });
    const id = (
      await app.inject({
        method: 'POST',
        url: '/hooks/local-playground',
        payload: '{"id":"resume_job"}',
      })
    ).json().request_id;
    const path = `${base}/requests/${id}/jobs`;
    const job = (
      await app.inject({ method: 'POST', url: path, payload: { retry_delay_ms: 250 } })
    ).json();
    await app.close();
    await database.close();
    database = await openDatabase({ url: null, dataDir: directory });
    app = await createApp({ database, rateLimiting: false, serveWeb: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const complete = await waitFor(async () => {
      const result = (await app.inject(path)).json().jobs.find((item) => item.id === job.id);
      return result?.state === 'succeeded' && result;
    });
    assert.equal(complete.attempt_count, 2);
    assert.deepEqual(
      complete.attempts.map((run) => run.http_status),
      [500, 200],
    );
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 1);
  } finally {
    await app?.close();
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
