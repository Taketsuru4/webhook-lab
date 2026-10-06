import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/database.js';

const defaultLabId = '00000000-0000-4000-8000-000000000001';
const inbox = `/api/labs/${defaultLabId}/requests`;
const hook = '/hooks/local-playground';

describe('Webhook capture API', () => {
  let database;
  let app;
  before(async () => {
    database = await openDatabase({
      url: process.env.TEST_DATABASE_URL || null,
      dataDir: ':memory:',
    });
    app = await createApp({ database, rateLimiting: false, serveWeb: false });
  });
  beforeEach(async () => {
    await database.query('DELETE FROM captured_requests');
    await database.query('DELETE FROM labs WHERE id <> $1', [defaultLabId]);
  });
  after(async () => {
    await app.close();
    await database.close();
  });

  async function send(payload, headers = { 'content-type': 'application/json' }) {
    return app.inject({ method: 'POST', url: hook, payload, headers });
  }

  it('captures exact JSON text including whitespace and Unicode', async () => {
    const body =
      '{\n  "id": "evt_unicode", "type": "payment.succeeded",\n  "customer": "Φοίβος ☕"\n}\n';
    const result = await send(body);
    assert.equal(result.statusCode, 202);
    const record = (await app.inject(`${inbox}/${result.json().request_id}`)).json();
    assert.equal(record.raw_body, body);
    assert.deepEqual(Buffer.from(record.raw_body_base64, 'base64'), Buffer.from(body));
    assert.equal(record.size_bytes, Buffer.byteLength(body));
    assert.equal(record.event_id, 'evt_unicode');
    assert.equal(record.is_json, true);
  });

  it('retains malformed JSON, text, binary, and empty bodies', async () => {
    for (const [body, contentType] of [
      [Buffer.from('{broken json'), 'application/json'],
      [Buffer.from('hello webhook\n'), 'text/plain'],
      [Buffer.from([0, 255, 192, 128, 13, 10]), 'application/octet-stream'],
      [Buffer.alloc(0), 'text/plain'],
    ]) {
      const result = await send(body, { 'content-type': contentType });
      assert.equal(result.statusCode, 202);
      const record = (await app.inject(`${inbox}/${result.json().request_id}`)).json();
      assert.deepEqual(Buffer.from(record.raw_body_base64, 'base64'), body);
      assert.equal(record.is_json, false);
      assert.equal(record.event_type, 'untyped');
    }
  });

  it('marks valid JSON primitives without treating them as typed events', async () => {
    for (const value of ['null', 'false', '0', '[]', '"hello"']) {
      const result = await send(value);
      const record = (await app.inject(`${inbox}/${result.json().request_id}`)).json();
      assert.equal(record.is_json, true);
      assert.equal(record.event_type, 'untyped');
    }
  });

  it('preserves valid JSON bodies when NUL metadata cannot be stored as text', async () => {
    for (const [payload, eventId, eventType] of [
      [{ id: 'evt_\u0000unsafe', type: 'payment.succeeded' }, null, 'payment.succeeded'],
      [{ id: 'evt_safe', type: 'payment.\u0000succeeded' }, 'evt_safe', 'untyped'],
      [{ id: '\u0000', type: '\u0000' }, null, 'untyped'],
    ]) {
      const body = `\n  ${JSON.stringify({ ...payload, customer: 'Φοίβος ☕' })}\n`;
      const result = await send(body);
      assert.equal(result.statusCode, 202);
      const detail = await app.inject(`${inbox}/${result.json().request_id}`);
      assert.equal(detail.statusCode, 200);
      const record = detail.json();
      assert.equal(record.event_id, eventId);
      assert.equal(record.event_type, eventType);
      assert.equal(record.is_json, true);
      assert.deepEqual(record.payload, JSON.parse(body));
      assert.equal(record.raw_body, body);
      assert.deepEqual(Buffer.from(record.raw_body_base64, 'base64'), Buffer.from(body));
      assert.equal(record.size_bytes, Buffer.byteLength(body));
    }
    const ordinary = await send('{"id":"evt_after_nul","type":"test.event"}');
    assert.equal(ordinary.statusCode, 202);
    const record = (await app.inject(`${inbox}/${ordinary.json().request_id}`)).json();
    assert.equal(record.event_id, 'evt_after_nul');
    assert.equal(record.event_type, 'test.event');
  });

  it('checks NUL characters beyond the former metadata length limits', async () => {
    for (const payload of [
      { id: `${'a'.repeat(200)}\u0000suffix`, type: 'test.event' },
      { id: 'evt_safe', type: `${'a'.repeat(120)}\u0000suffix` },
    ]) {
      const body = JSON.stringify(payload);
      const result = await send(body);
      assert.equal(result.statusCode, 202);
      const record = (await app.inject(`${inbox}/${result.json().request_id}`)).json();
      assert.equal(record.event_id, payload.id.includes('\u0000') ? null : payload.id);
      assert.equal(record.event_type, payload.type.includes('\u0000') ? 'untyped' : payload.type);
      assert.deepEqual(Buffer.from(record.raw_body_base64, 'base64'), Buffer.from(body));
    }
  });

  it('does not invent duplicate identities by stripping NUL from event IDs', async () => {
    const unsafe = JSON.stringify({ id: 'evt_\u0000same', type: 'test.event' });
    const responses = await Promise.all([
      send(unsafe),
      send(unsafe),
      send('{"id":"evt_same","type":"test.event"}'),
    ]);
    assert.ok(responses.every((response) => response.statusCode === 202));
    const requests = (await app.inject(inbox)).json();
    assert.equal(requests.total, 3);
    assert.equal(requests.requests.filter((item) => item.event_id === null).length, 2);
    assert.ok(requests.requests.every((item) => item.occurrences === 1));
    assert.equal((await app.inject(`${inbox}?filter=duplicates`)).json().total, 0);
    const stats = (await app.inject(`/api/labs/${defaultLabId}/stats`)).json();
    assert.equal(stats.total, 3);
    assert.equal(stats.duplicates, 0);
  });

  it('stores every concurrent duplicate and scopes occurrences to each lab', async () => {
    const body = JSON.stringify({ id: 'evt_duplicate', type: 'payment.succeeded' });
    const responses = await Promise.all(Array.from({ length: 5 }, () => send(body)));
    assert.ok(responses.every((response) => response.statusCode === 202));
    assert.equal(new Set(responses.map((response) => response.json().request_id)).size, 5);
    const requests = (await app.inject(`${inbox}?filter=duplicates`)).json();
    assert.equal(requests.total, 5);
    assert.ok(requests.requests.every((item) => item.occurrences === 5));
    const stats = (await app.inject(`/api/labs/${defaultLabId}/stats`)).json();
    assert.equal(stats.total, 5);
    assert.equal(stats.duplicates, 4);
    assert.equal(
      stats.traffic.reduce((sum, item) => sum + item.count, 0),
      5,
    );

    const lab = (
      await app.inject({ method: 'POST', url: '/api/labs', payload: { name: 'Other lab' } })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/hooks/${lab.token}`,
      payload: body,
      headers: { 'content-type': 'application/json' },
    });
    const other = (await app.inject(`/api/labs/${lab.id}/requests?filter=duplicates`)).json();
    assert.equal(other.total, 0);
    assert.equal(
      (await app.inject(`/api/labs/${lab.id}/requests/${responses[0].json().request_id}`))
        .statusCode,
      404,
    );
  });

  it('keeps long provider IDs distinct and detects actual repeated long IDs', async () => {
    const prefix = 'a'.repeat(200);
    for (const id of [`${prefix}1`, `${prefix}2`, `${prefix}1`]) {
      assert.equal((await send(JSON.stringify({ id, type: 'test.event' }))).statusCode, 202);
    }
    const requests = (await app.inject(inbox)).json();
    assert.equal(requests.requests.filter((item) => item.event_id === `${prefix}1`).length, 2);
    assert.equal(requests.requests.find((item) => item.event_id === `${prefix}2`).occurrences, 1);
    assert.equal((await app.inject(`${inbox}?filter=duplicates`)).json().total, 2);
    assert.equal((await app.inject(`/api/labs/${defaultLabId}/stats`)).json().duplicates, 1);
    assert.equal((await app.inject(`${inbox}?q=${encodeURIComponent('a1')}`)).json().total, 2);
  });

  it('captures large incompressible IDs without exceeding index limits', async () => {
    const { randomBytes } = await import('node:crypto');
    const id = randomBytes(8000).toString('hex');
    const body = JSON.stringify({ id, type: `event.${'x'.repeat(130)}` });
    const response = await send(body);
    assert.equal(response.statusCode, 202);
    const record = (await app.inject(`${inbox}/${response.json().request_id}`)).json();
    assert.equal(record.event_id, id);
    assert.equal(record.event_type, JSON.parse(body).type);
    assert.deepEqual(Buffer.from(record.raw_body_base64, 'base64'), Buffer.from(body));
  });

  it('redacts common credentials while retaining non-secret headers', async () => {
    const result = await send('{}', {
      'content-type': 'application/json',
      authorization: 'Bearer private-token',
      cookie: 'session=private',
      'x-api-key': 'private-key',
      'x-webhook-secret': 'private-secret',
      'x-request-id': 'trace_123',
    });
    const record = (await app.inject(`${inbox}/${result.json().request_id}`)).json();
    for (const key of ['authorization', 'cookie', 'x-api-key', 'x-webhook-secret'])
      assert.equal(record.headers[key], '[REDACTED]');
    assert.equal(record.headers['x-request-id'], 'trace_123');
    assert.ok(!JSON.stringify(record).includes('private-token'));
  });

  it('returns no acknowledgement when storage fails', async () => {
    const failDatabase = {
      ...database,
      query: (sql, params) => {
        if (sql.includes('INSERT INTO captured_requests')) throw new Error('Database unavailable');
        return database.query(sql, params);
      },
    };
    const failingApp = await createApp({
      database: failDatabase,
      rateLimiting: false,
      serveWeb: false,
    });
    try {
      const result = await failingApp.inject({
        method: 'POST',
        url: hook,
        payload: { id: 'evt_lost' },
      });
      assert.equal(result.statusCode, 500);
      assert.equal(result.json().accepted, undefined);
      assert.equal((await app.inject(inbox)).json().total, 0);
    } finally {
      await failingApp.close();
    }
  });

  it('supports search and treats SQL wildcard characters as literal input', async () => {
    await send('{"id":"evt_100%","type":"invoice.paid"}');
    await send('{"id":"evt_1000","type":"payment.succeeded"}');
    await send('{"id":"evt_other","type":"payment.succeeded"}');
    assert.equal((await app.inject(`${inbox}?q=payment`)).json().total, 2);
    assert.equal((await app.inject(`${inbox}?q=${encodeURIComponent('100%')}`)).json().total, 1);
    assert.equal((await app.inject(`${inbox}?q=${encodeURIComponent('evt_')}`)).json().total, 3);
    assert.equal(
      (await app.inject(`${inbox}?q=${encodeURIComponent("' OR 1=1 --")}`)).json().total,
      0,
    );
  });

  it('paginates without repeating requests when timestamps tie', async () => {
    await Promise.all(
      Array.from({ length: 55 }, (_, i) =>
        send(JSON.stringify({ id: `evt_${i}`, type: 'test.event' })),
      ),
    );
    const first = (await app.inject(inbox)).json();
    const second = (await app.inject(`${inbox}?offset=50`)).json();
    assert.equal(first.total, 55);
    assert.equal(first.requests.length, 50);
    assert.equal(second.requests.length, 5);
    assert.equal(new Set([...first.requests, ...second.requests].map((item) => item.id)).size, 55);
  });

  it('validates management input and unknown endpoints', async () => {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/labs', payload: { name: '   ' } })).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/labs', payload: { name: 'x'.repeat(61) } }))
        .statusCode,
      400,
    );
    assert.equal((await app.inject('/api/labs/not-a-uuid/requests')).statusCode, 400);
    assert.equal((await app.inject(`${inbox}?offset=-1`)).statusCode, 400);
    assert.equal((await app.inject(`${inbox}?filter=made-up`)).statusCode, 400);
    assert.equal(
      (await app.inject({ method: 'POST', url: '/hooks/missing', payload: '{}' })).statusCode,
      404,
    );
    assert.equal(
      (await app.inject('/api/labs/00000000-0000-4000-8000-000000000099/stats')).statusCode,
      404,
    );
  });

  it('rejects payloads above the 256 KiB limit', async () => {
    const response = await send('x'.repeat(256 * 1024 + 1), { 'content-type': 'text/plain' });
    assert.equal(response.statusCode, 413);
    assert.equal((await app.inject(inbox)).json().total, 0);
  });

  it('applies capture rate limits to protect local storage', async () => {
    const limited = await createApp({ database, serveWeb: false });
    try {
      const responses = [];
      for (let i = 0; i < 121; i++)
        responses.push(await limited.inject({ method: 'POST', url: hook, payload: '{}' }));
      assert.equal(responses[119].statusCode, 202);
      assert.equal(responses[120].statusCode, 429);
      assert.ok(responses[120].headers['retry-after']);
    } finally {
      await limited.close();
    }
  });
});

it('embedded database retains captures across a real close and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webhook-lab-test-'));
  // A clean checkout has neither .data nor the database directory yet.
  const dataDir = join(directory, 'nested', 'postgres');
  let database;
  let app;
  try {
    database = await openDatabase({ url: null, dataDir });
    app = await createApp({ database, rateLimiting: false, serveWeb: false });
    const result = await app.inject({
      method: 'POST',
      url: hook,
      payload: '{"id":"evt_persistent"}',
      headers: { 'content-type': 'application/json' },
    });
    const id = result.json().request_id;
    await app.close();
    await database.close();
    database = await openDatabase({ url: null, dataDir });
    app = await createApp({ database, rateLimiting: false, serveWeb: false });
    const record = await app.inject(`${inbox}/${id}`);
    assert.equal(record.statusCode, 200);
    assert.equal(record.json().event_id, 'evt_persistent');
  } finally {
    if (app) await app.close();
    if (database) await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
