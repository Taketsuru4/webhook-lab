import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/database.js';
import { deliver } from '../server/replay.js';

const labId = '00000000-0000-4000-8000-000000000001';
const base = `/api/labs/${labId}`;

describe('manual replay over real HTTP', () => {
  let database;
  let app;
  let admin;
  let schema;
  before(async () => {
    let url = process.env.TEST_DATABASE_URL || null;
    if (url) {
      admin = await openDatabase({ url });
      schema = `replay_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      const parsed = new URL(url);
      parsed.searchParams.set('options', `-c search_path=${schema}`);
      url = parsed.toString();
    }
    database = await openDatabase({ url, dataDir: ':memory:' });
    app = await createApp({ database, rateLimiting: false, serveWeb: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });
  beforeEach(async () => {
    await database.query('DELETE FROM captured_requests');
    await database.query('DELETE FROM mock_receipts');
    await database.query('DELETE FROM mock_receivers');
    await database.query('DELETE FROM labs WHERE id <> $1', [labId]);
  });
  after(async () => {
    await app.close();
    await database.close();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  });
  async function capture(body, contentType = 'application/json') {
    const result = await app.inject({
      method: 'POST',
      url: '/hooks/local-playground',
      payload: body,
      headers: { 'content-type': contentType, authorization: 'Bearer secret' },
    });
    assert.equal(result.statusCode, 202);
    return result.json().request_id;
  }
  const replay = (id, timeout = 2000) =>
    app.inject({
      method: 'POST',
      url: `${base}/requests/${id}/replays`,
      payload: { timeout_ms: timeout },
    });
  const config = (failFirst = 0, delayMs = 0, idempotency) =>
    app.inject({
      method: 'PUT',
      url: `${base}/receiver`,
      payload: {
        fail_first: failFirst,
        delay_ms: delayMs,
        ...(idempotency === undefined ? {} : { idempotency_enabled: idempotency }),
      },
    });

  it('delivers unchanged JSON, malformed JSON, binary and empty bytes without another capture', async () => {
    for (const [body, contentType] of [
      [Buffer.from(' {"id":"evt_1", "name":"Φοίβος ☕"}\n'), 'application/json'],
      [Buffer.from('{broken'), 'application/json'],
      [Buffer.from([0, 255, 192, 128, 13, 10]), 'application/octet-stream'],
      [Buffer.alloc(0), 'text/plain'],
    ]) {
      const id = await capture(body, contentType);
      const result = await replay(id);
      assert.equal(result.statusCode, 201);
      const run = result.json();
      assert.equal(run.state, 'succeeded');
      assert.equal(run.http_status, 200);
      assert.ok(run.duration_ms >= 0);
      const receipt = (
        await database.query('SELECT * FROM mock_receipts WHERE run_id = $1', [run.id])
      ).rows[0];
      assert.deepEqual(Buffer.from(receipt.raw_body_base64, 'base64'), body);
      assert.equal(receipt.content_type, contentType);
      const original = (await app.inject(`${base}/requests/${id}`)).json();
      assert.deepEqual(Buffer.from(original.raw_body_base64, 'base64'), body);
    }
    assert.equal((await app.inject(`${base}/stats`)).json().total, 4);
  });

  it('records independent failed and successful attempts in history and resets receiver counters', async () => {
    assert.equal((await config(1)).statusCode, 200);
    const id = await capture('{}');
    const first = (await replay(id)).json();
    const second = (await replay(id)).json();
    assert.equal(first.state, 'failed');
    assert.equal(first.http_status, 500);
    assert.equal(second.state, 'succeeded');
    assert.notEqual(first.id, second.id);
    const history = (await app.inject(`${base}/requests/${id}/replays`)).json();
    assert.equal(history.total, 2);
    assert.deepEqual(
      history.runs.map((run) => run.http_status),
      [200, 500],
    );
    assert.ok(first.response_body.includes('Configured mock failure'));
    assert.equal((await app.inject(`${base}/receiver`)).json().received_count, 2);
    assert.equal((await config(1)).json().received_count, 0);
    assert.equal((await replay(id)).json().http_status, 500);
  });

  it('records timeout even though receiver has stored the body; excludes concurrent replay and clear', async () => {
    await config(0, 300);
    const id = await capture('{}');
    const pending = replay(id, 150);
    // Wait for persistent running state instead of relying on a timer race.
    for (let i = 0; i < 100; i++) {
      const rows = await database.query("SELECT id FROM replay_runs WHERE state = 'running'");
      if (rows.rows.length) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal((await replay(id)).statusCode, 409);
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
    const run = (await pending).json();
    assert.equal(run.state, 'timeout');
    assert.equal(run.http_status, null);
    assert.match(run.error, /may have received/);
    assert.equal(
      (await database.query('SELECT * FROM mock_receipts WHERE run_id = $1', [run.id])).rows.length,
      1,
    );
  });

  it('protects one demo action across concurrent identical HTTP requests', async () => {
    await config(0, 0, true);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.inject({
          method: 'POST',
          url: '/mock/local-playground',
          payload: '{"id":"same_event","data":{"amount":100}}',
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    assert.ok(responses.every((response) => response.statusCode === 200));
    assert.equal(responses.filter((response) => response.json().outcome === 'processed').length, 1);
    assert.equal(responses.filter((response) => response.json().outcome === 'duplicate').length, 5);
    assert.equal(new Set(responses.map((response) => response.json().effect_id)).size, 1);
    const receiver = (await app.inject(`${base}/receiver`)).json();
    assert.equal(receiver.processed_count, 1);
    assert.equal(receiver.deduplicated_count, 5);
    assert.equal(receiver.received_count, 6);
    assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 6);
  });

  it('does not reserve keys on 500 and rejects a reused ID with changed bytes', async () => {
    await config(1, 0, true);
    const id = await capture('{"id":"bound_event","amount":100}');
    assert.equal((await replay(id)).json().http_status, 500);
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 0);
    const success = (await replay(id)).json();
    assert.equal(JSON.parse(success.response_body).outcome, 'processed');
    const duplicate = (await replay(id)).json();
    assert.equal(JSON.parse(duplicate.response_body).outcome, 'duplicate');
    const changed = await capture('{"id":"bound_event","amount":200}');
    const conflict = (await replay(changed)).json();
    assert.equal(conflict.http_status, 409);
    assert.equal(conflict.state, 'failed');
    assert.equal(JSON.parse(conflict.response_body).outcome, 'conflict');
    const receiver = (await app.inject(`${base}/receiver`)).json();
    assert.equal(receiver.processed_count, 1);
    assert.equal(receiver.conflict_count, 1);
    await config(0, 0, true);
    assert.equal(JSON.parse((await replay(id)).json().response_body).outcome, 'duplicate');
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 1);
  });

  it('prevents repeated demo actions after a timed-out acknowledgement', async () => {
    await config(0, 300, true);
    const id = await capture('{"id":"timeout_event"}');
    const timeout = (await replay(id, 150)).json();
    assert.equal(timeout.state, 'timeout');
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 1);
    await config(0, 0, true);
    const retry = (await replay(id)).json();
    assert.equal(retry.state, 'succeeded');
    assert.equal(JSON.parse(retry.response_body).outcome, 'duplicate');
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 1);
  });

  it('processes unguarded deliveries individually and explains missing keys', async () => {
    const id = await capture('{"id":"unguarded"}');
    await replay(id);
    await replay(id);
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 2);
    await config(0, 0, true);
    for (const body of ['{}', '{broken', '{"id":""}', '{"id":42}', '{"id":"nul\\u0000key"}']) {
      const missing = await capture(body);
      assert.equal(
        JSON.parse((await replay(missing)).json().response_body).outcome,
        'processed_without_key',
      );
    }
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 7);
  });

  it('preserves complete large keys and scopes them to the receiver lab', async () => {
    await config(0, 0, true);
    const prefix = 'a'.repeat(16000);
    const first = await capture(JSON.stringify({ id: `${prefix}1` }));
    const second = await capture(JSON.stringify({ id: `${prefix}2` }));
    await replay(first);
    await replay(second);
    assert.equal(JSON.parse((await replay(first)).json().response_body).outcome, 'duplicate');
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 2);
    const other = (
      await app.inject({ method: 'POST', url: '/api/labs', payload: { name: 'Separate demo' } })
    ).json();
    await app.inject({
      method: 'PUT',
      url: `/api/labs/${other.id}/receiver`,
      payload: { fail_first: 0, delay_ms: 0, idempotency_enabled: true },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/mock/${other.token}`,
      payload: JSON.stringify({ id: `${prefix}1` }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(response.json().outcome, 'processed');
    assert.equal((await app.inject(`/api/labs/${other.id}/receiver`)).json().processed_count, 1);
    // An index digest alone must never establish key equality.
    await database.query(
      'UPDATE mock_effects SET event_id = $2 WHERE lab_id = $1 AND event_id = $3',
      [labId, 'different-complete-key', `${prefix}1`],
    );
    assert.equal((await replay(first)).json().http_status, 409);
  });

  it('rolls back receiver counter, receipt and effect together on a storage failure', async () => {
    await config(0, 0, true);
    const original = database.transaction;
    database.transaction = (callback) =>
      original((tx) =>
        callback({
          query(sql, params) {
            if (sql.includes('INSERT INTO mock_effects'))
              throw new Error('Demo action storage unavailable');
            return tx.query(sql, params);
          },
        }),
      );
    try {
      const failed = await app.inject({
        method: 'POST',
        url: '/mock/local-playground',
        payload: '{"id":"retryable"}',
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(failed.statusCode, 500);
    } finally {
      database.transaction = original;
    }
    const receiver = (await app.inject(`${base}/receiver`)).json();
    assert.equal(receiver.received_count, 0);
    assert.equal(receiver.processed_count, 0);
    assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 0);
    const retry = await app.inject({
      method: 'POST',
      url: '/mock/local-playground',
      payload: '{"id":"retryable"}',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(retry.json().outcome, 'processed');
  });

  it('scopes replay and history to a lab and validates scenario input', async () => {
    const id = await capture('{}');
    const other = (
      await app.inject({ method: 'POST', url: '/api/labs', payload: { name: 'Other lab' } })
    ).json();
    const path = `/api/labs/${other.id}/requests/${id}/replays`;
    assert.equal((await app.inject(path)).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: path, payload: {} })).statusCode, 404);
    assert.equal((await config(11)).statusCode, 400);
    assert.equal((await config(0, 5001)).statusCode, 400);
    assert.equal((await replay(id, 99)).statusCode, 400);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/requests/${id}/replays`,
          payload: { url: 'https://example.com' },
        })
      ).statusCode,
      400,
    );
  });

  it('clears only the confirmed lab, its history and receipts, preserving endpoint and config', async () => {
    const id = await capture('{}');
    await config(1);
    await replay(id);
    const other = (
      await app.inject({ method: 'POST', url: '/api/labs', payload: { name: 'Keep me' } })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/hooks/${other.token}`,
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `${base}/requests`,
          payload: { confirm: 'Wrong lab' },
        })
      ).statusCode,
      400,
    );
    assert.equal((await app.inject(`${base}/stats`)).json().total, 1);
    const result = await app.inject({
      method: 'DELETE',
      url: `${base}/requests`,
      payload: { confirm: 'Payment playground' },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().cleared, 1);
    assert.equal((await app.inject(`${base}/stats`)).json().total, 0);
    assert.equal((await app.inject(`/api/labs/${other.id}/stats`)).json().total, 1);
    assert.equal((await database.query('SELECT * FROM replay_runs')).rows.length, 0);
    assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 0);
    assert.equal((await database.query('SELECT * FROM mock_effects')).rows.length, 0);
    const receiver = (await app.inject(`${base}/receiver`)).json();
    assert.equal(receiver.fail_first, 1);
    assert.equal(receiver.received_count, 0);
    assert.equal((await app.inject(`${base}/requests/${id}/replays`)).statusCode, 404);
    assert.equal(
      (await app.inject({ method: 'POST', url: '/hooks/local-playground', payload: '{}' }))
        .statusCode,
      202,
    );
  });

  it('does not deliver before a run can be persisted and retains uncertainty after a result-write failure', async () => {
    const id = await capture('{}');
    let failInsert = true;
    let failResult = false;
    const wrapped = {
      ...database,
      query(sql, params) {
        if (failResult && sql.includes('UPDATE replay_runs SET state = $2'))
          throw new Error('Result write unavailable');
        return database.query(sql, params);
      },
      transaction(callback) {
        return database.transaction((tx) =>
          callback({
            query(sql, params) {
              if (failInsert && sql.includes('INSERT INTO replay_runs'))
                throw new Error('Run write unavailable');
              return tx.query(sql, params);
            },
          }),
        );
      },
    };
    const failingApp = await createApp({ database: wrapped, rateLimiting: false, serveWeb: false });
    await failingApp.listen({ port: 0, host: '127.0.0.1' });
    try {
      const send = () =>
        failingApp.inject({ method: 'POST', url: `${base}/requests/${id}/replays`, payload: {} });
      assert.equal((await send()).statusCode, 500);
      assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 0);
      assert.equal((await database.query('SELECT * FROM replay_runs')).rows.length, 0);
      failInsert = false;
      failResult = true;
      assert.equal((await send()).statusCode, 500);
      assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 1);
      assert.equal((await database.query('SELECT * FROM replay_runs')).rows[0].state, 'running');
      assert.equal((await send()).statusCode, 409);
      await database.query("UPDATE replay_runs SET started_at = now() - interval '1 minute'");
      const history = (await failingApp.inject(`${base}/requests/${id}/replays`)).json();
      assert.equal(history.runs[0].state, 'interrupted');
    } finally {
      await failingApp.close();
    }
  });

  it('paginates persisted history without repeating tied timestamps', async () => {
    const id = await capture('{}');
    for (let i = 0; i < 25; i++)
      await database.query(
        `INSERT INTO replay_runs (id, lab_id, capture_id, timeout_ms, state, started_at) VALUES ($1,$2,$3,1000,'succeeded','2026-10-06T12:00:00Z')`,
        [randomUUID(), labId, id],
      );
    const first = (await app.inject(`${base}/requests/${id}/replays`)).json();
    const second = (await app.inject(`${base}/requests/${id}/replays?offset=20`)).json();
    assert.equal(first.total, 25);
    assert.equal(first.runs.length, 20);
    assert.equal(second.runs.length, 5);
    assert.equal(new Set([...first.runs, ...second.runs].map((item) => item.id)).size, 25);
  });

  it('recovers expired running experiments without changing a fresh running run', async () => {
    const id = await capture('{}');
    const stale = randomUUID();
    const fresh = randomUUID();
    await database.query(
      `INSERT INTO replay_runs (id, lab_id, capture_id, timeout_ms, started_at) VALUES ($1,$2,$3,1000,now() - interval '1 minute'),($4,$2,$3,1000,now())`,
      [stale, labId, id, fresh],
    );
    const history = (await app.inject(`${base}/requests/${id}/replays`)).json();
    assert.equal(history.runs.find((run) => run.id === stale).state, 'interrupted');
    assert.equal(history.runs.find((run) => run.id === fresh).state, 'running');
    assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 0);
  });
});

it('bounds receiver responses and times out a stalled body after headers arrive', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/large') response.end(Buffer.alloc(20000, 65));
    else {
      response.writeHead(200);
      response.write('partial');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = {
      body: Buffer.from('{}'),
      contentType: 'application/json',
      runId: randomUUID(),
      timeoutMs: 100,
    };
    const url = `http://127.0.0.1:${server.address().port}`;
    const large = await deliver({ ...options, url: `${url}/large` });
    assert.equal(large.state, 'succeeded');
    assert.equal(large.response_truncated, true);
    assert.equal(Buffer.from(large.response_body_base64, 'base64').length, 16384);
    const slow = await deliver({ ...options, url: `${url}/slow` });
    assert.equal(slow.state, 'timeout');
    assert.equal(slow.http_status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it('persists replay history and receiver settings across an embedded restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webhook-replay-'));
  let database;
  let app;
  try {
    database = await openDatabase({ url: null, dataDir: directory });
    app = await createApp({ database, rateLimiting: false, serveWeb: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    await app.inject({
      method: 'PUT',
      url: `${base}/receiver`,
      payload: { fail_first: 1, delay_ms: 0 },
    });
    const id = (
      await app.inject({ method: 'POST', url: '/hooks/local-playground', payload: '{}' })
    ).json().request_id;
    const run = (
      await app.inject({ method: 'POST', url: `${base}/requests/${id}/replays`, payload: {} })
    ).json();
    await app.close();
    await database.close();
    database = await openDatabase({ url: null, dataDir: directory });
    app = await createApp({ database, rateLimiting: false, serveWeb: false });
    assert.equal((await app.inject(`${base}/requests/${id}/replays`)).json().runs[0].id, run.id);
    assert.equal((await app.inject(`${base}/receiver`)).json().received_count, 1);
  } finally {
    await app?.close();
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('retains protected receiver effects after restarting and re-acknowledges duplicates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webhook-idempotency-'));
  let database;
  let app;
  const request = {
    method: 'POST',
    url: '/mock/local-playground',
    payload: '{"id":"durable-key"}',
    headers: { 'content-type': 'application/json' },
  };
  try {
    database = await openDatabase({ url: null, dataDir: directory });
    app = await createApp({ database, rateLimiting: false, serveWeb: false });
    await app.inject({
      method: 'PUT',
      url: `${base}/receiver`,
      payload: { fail_first: 0, delay_ms: 0, idempotency_enabled: true },
    });
    const first = (await app.inject(request)).json();
    assert.equal(first.outcome, 'processed');
    await app.close();
    await database.close();
    database = await openDatabase({ url: null, dataDir: directory });
    app = await createApp({ database, rateLimiting: false, serveWeb: false });
    const duplicate = (await app.inject(request)).json();
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.effect_id, first.effect_id);
    const summary = (await app.inject(`${base}/receiver`)).json();
    assert.equal(summary.processed_count, 1);
    assert.equal(summary.deduplicated_count, 1);
    assert.equal(summary.idempotency_enabled, true);
    await app.inject({
      method: 'DELETE',
      url: `${base}/requests`,
      payload: { confirm: 'Payment playground' },
    });
    assert.equal((await app.inject(request)).json().outcome, 'processed');
    assert.equal((await app.inject(`${base}/receiver`)).json().processed_count, 1);
  } finally {
    await app?.close();
    await database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
