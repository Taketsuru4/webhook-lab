import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/app.js';
import { localTarget } from '../server/targets.js';

const labId = '00000000-0000-4000-8000-000000000001';
const base = `/api/labs/${labId}`;

describe('selected local HTTP receiver', () => {
  let database, app, admin, schema, receiver, other, receiverUrl, otherUrl;
  let receipts, others, failFirst, delayMs, redirect, onReceipt;
  before(async () => {
    let url = process.env.TEST_DATABASE_URL || null;
    if (url) {
      admin = await openDatabase({ url });
      schema = `targets_${randomUUID().replaceAll('-', '')}`;
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
    receiver = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      receipts.push({ body: Buffer.concat(chunks), headers: request.headers, path: request.url });
      const status = redirect ? 302 : receipts.length <= failFirst ? 500 : 200;
      onReceipt?.();
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      response.writeHead(status, {
        'content-type': 'application/json',
        ...(redirect ? { location: otherUrl } : {}),
      });
      response.end(JSON.stringify({ received: true }));
    });
    other = createServer((request, response) => {
      others.push(request.url);
      request.resume();
      response.end('other');
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${receiver.address().port}/webhooks?source=lab`;
    otherUrl = `http://127.0.0.1:${other.address().port}/different`;
  });
  beforeEach(async () => {
    receipts = [];
    others = [];
    failFirst = 0;
    delayMs = 0;
    redirect = false;
    onReceipt = null;
    await database.query('DELETE FROM captured_requests');
    await database.query('DELETE FROM mock_receipts');
    await database.query('DELETE FROM labs WHERE id <> $1', [labId]);
    await database.query("UPDATE labs SET delivery_mode = 'mock', delivery_url = NULL");
  });
  after(async () => {
    for (const server of [receiver, other]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    app.server.closeAllConnections();
    await app.close();
    await database.close();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    }
  });
  const save = (url, mode = 'local') =>
    app.inject({ method: 'PUT', url: `${base}/delivery-target`, payload: { mode, url } });
  const capture = async (body = '{"id":"local_event"}', contentType = 'application/json') =>
    (
      await app.inject({
        method: 'POST',
        url: '/hooks/local-playground',
        payload: body,
        headers: {
          'content-type': contentType,
          authorization: 'Bearer secret',
          'stripe-signature': 'old-signature',
        },
      })
    ).json().request_id;
  const path = (id, kind = 'replays') => `${base}/requests/${id}/${kind}`;
  const replay = (id, timeout_ms = 1000) =>
    app.inject({ method: 'POST', url: path(id), payload: { timeout_ms } });
  const queue = (id) =>
    app.inject({ method: 'POST', url: path(id, 'jobs'), payload: { retry_delay_ms: 250 } });
  const history = async (id) => (await app.inject(path(id, 'jobs'))).json().jobs[0];

  it('defaults to the mock, normalizes localhost, and preserves exact JSON, malformed, binary and empty bodies', async () => {
    assert.deepEqual((await app.inject(`${base}/delivery-target`)).json(), {
      mode: 'mock',
      url: null,
    });
    const saved = await save(receiverUrl.replace('127.0.0.1', 'localhost'));
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().url, receiverUrl);
    for (const [body, type] of [
      [Buffer.from(' {"id":"evt", "name":"Φοίβος ☕"}\n'), 'application/json'],
      [Buffer.from('{broken'), 'application/json'],
      [Buffer.from([0, 255, 192, 13, 10]), 'application/octet-stream'],
      [Buffer.alloc(0), 'text/plain'],
    ]) {
      const id = await capture(body, type);
      const response = await replay(id);
      assert.equal(response.statusCode, 201);
      const run = response.json();
      assert.equal(run.state, 'succeeded');
      assert.equal(run.target_mode, 'local');
      assert.equal(run.target_url, receiverUrl);
      const received = receipts.at(-1);
      assert.deepEqual(received.body, body);
      assert.equal(received.headers['content-type'], type);
      assert.equal(received.headers.authorization, undefined);
      assert.equal(received.headers['stripe-signature'], undefined);
      assert.equal(received.headers['x-webhook-lab-run-id'], run.id);
      assert.equal(received.path, '/webhooks?source=lab');
    }
    assert.equal((await database.query('SELECT * FROM mock_receipts')).rows.length, 0);
    assert.equal((await app.inject(`${base}/stats`)).json().total, 4);
    await save(null, 'mock');
    const response = await replay(await capture());
    assert.equal(response.json().target_mode, 'mock');
    assert.match(response.json().target_url, /\/mock\/local-playground$/);
  });

  it('rejects remote addresses, alternate IP forms, credentials, fragments and its own API without saving or sending', async () => {
    for (const url of [
      'https://localhost:3000/hook',
      'http://example.com:3000/hook',
      'http://localhost.example.com:3000/hook',
      'http://192.168.1.2:3000/hook',
      'http://169.254.169.254:80/',
      'http://0.0.0.0:3000/',
      'http://127.1:3000/',
      'http://2130706433:3000/',
      'http://0x7f000001:3000/',
      'http://[::1]:3000/',
      'http://user:pass@localhost:3000/',
      'http://localhost:3000@evil.com/',
      'http://localhost/',
      'http://localhost:0/',
      'http://localhost:65536/',
      'http://localhost:3000/#fragment',
      'http://localhost:3000/\\evil',
      'http://localhost:3000/\nfoo',
      `http://localhost:${app.server.address().port}/hooks/local-playground`,
    ])
      assert.equal((await save(url)).statusCode, 400, url);
    assert.deepEqual((await app.inject(`${base}/delivery-target`)).json(), {
      mode: 'mock',
      url: null,
    });
    assert.equal(receipts.length, 0);
    assert.equal((await save(null)).statusCode, 400);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `${base}/delivery-target`,
          payload: { mode: 'remote', url: receiverUrl },
        })
      ).statusCode,
      400,
    );
    assert.equal((await app.inject(`/api/labs/${randomUUID()}/delivery-target`)).statusCode, 404);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/labs/${randomUUID()}/delivery-target`,
          payload: { mode: 'local', url: receiverUrl },
        })
      ).statusCode,
      404,
    );
  });

  it('keeps the original destination throughout retries even after the lab target changes', async () => {
    failFirst = 1;
    await save(receiverUrl);
    const id = await capture();
    const queued = await queue(id);
    assert.equal(queued.statusCode, 202);
    assert.equal(queued.json().target_url, receiverUrl);
    assert.equal(receipts.length, 0);
    await save(otherUrl);
    await app.deliveryWorker.processOne();
    assert.equal((await history(id)).state, 'waiting_retry');
    await database.query('UPDATE delivery_jobs SET next_attempt_at = now()');
    await app.deliveryWorker.processOne();
    const job = await history(id);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.target_url, receiverUrl);
    assert.deepEqual(
      job.attempts.map((run) => run.http_status),
      [500, 200],
    );
    assert.ok(job.attempts.every((run) => run.target_url === receiverUrl));
    assert.equal(others.length, 0);
    assert.equal((await replay(id)).json().target_url, otherUrl);
    assert.equal(others.length, 1);
  });

  it('records timeouts and cancels future local deliveries after an in-flight attempt', async () => {
    delayMs = 200;
    await save(receiverUrl);
    const id = await capture();
    assert.equal((await replay(id, 100)).json().state, 'timeout');
    delayMs = 200;
    failFirst = 10;
    const job = (await queue(id)).json();
    let received;
    const arrival = new Promise((resolve) => {
      received = resolve;
    });
    onReceipt = received;
    const processing = app.deliveryWorker.processOne();
    await arrival;
    const cancelled = await app.inject({
      method: 'POST',
      url: `${path(id, 'jobs')}/${job.id}/cancel`,
      payload: {},
    });
    assert.equal(cancelled.json().cancel_requested, true);
    await processing;
    assert.equal((await history(id)).state, 'cancelled');
    assert.equal((await history(id)).attempt_count, 1);
    assert.equal(await app.deliveryWorker.processOne(), false);
  });

  it('records redirects without following them or retrying them', async () => {
    redirect = true;
    await save(receiverUrl);
    const id = await capture();
    assert.equal((await replay(id)).json().http_status, 302);
    await queue(id);
    await app.deliveryWorker.processOne();
    assert.equal((await history(id)).state, 'failed');
    assert.equal((await history(id)).attempt_count, 1);
    assert.equal(others.length, 0);
  });

  it('revalidates queued URLs against the current API port before sending', async () => {
    await save(receiverUrl);
    const id = await capture();
    await queue(id);
    await database.query('UPDATE delivery_jobs SET target_url = $1', [
      `http://127.0.0.1:${app.server.address().port}/hooks/local-playground`,
    ]);
    await app.deliveryWorker.processOne();
    const job = await history(id);
    assert.equal(job.state, 'failed');
    assert.match(job.last_error, /different port/);
    assert.equal(receipts.length, 0);
    assert.equal(job.attempt_count, 1);
    assert.equal((await app.inject(`${base}/stats`)).json().total, 1);
  });
  it('preserves a local destination and queued job after reopening the embedded database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-local-target-'));
    let db, local;
    try {
      db = await openDatabase({ url: null, dataDir: directory });
      local = await createApp({
        database: db,
        deliveryWorker: false,
        rateLimiting: false,
        serveWeb: false,
      });
      await local.inject({
        method: 'PUT',
        url: `${base}/delivery-target`,
        payload: { mode: 'local', url: receiverUrl },
      });
      const id = (
        await local.inject({
          method: 'POST',
          url: '/hooks/local-playground',
          payload: '{"id":"restart_target"}',
        })
      ).json().request_id;
      const job = (
        await local.inject({ method: 'POST', url: path(id, 'jobs'), payload: {} })
      ).json();
      await local.close();
      await db.close();
      db = await openDatabase({ url: null, dataDir: directory });
      local = await createApp({
        database: db,
        deliveryWorker: false,
        rateLimiting: false,
        serveWeb: false,
      });
      await local.listen({ port: 0, host: '127.0.0.1' });
      assert.deepEqual((await local.inject(`${base}/delivery-target`)).json(), {
        mode: 'local',
        url: receiverUrl,
      });
      await local.deliveryWorker.processOne();
      const saved = (await local.inject(path(id, 'jobs'))).json().jobs[0];
      assert.equal(saved.id, job.id);
      assert.equal(saved.state, 'succeeded');
      assert.equal(saved.attempts[0].target_url, receiverUrl);
      assert.equal(receipts.length, 1);
    } finally {
      local?.server.closeAllConnections();
      await local?.close();
      await db?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it('normalizes explicit port 80 without DNS and preserves encoded paths and query strings', () => {
  assert.equal(
    localTarget('http://localhost:80/hook%20here?x=a%2Fb'),
    'http://127.0.0.1:80/hook%20here?x=a%2Fb',
  );
});
