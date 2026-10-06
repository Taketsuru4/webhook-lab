import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptMock, receiverSummary } from './receiver.js';

const uuid = { type: 'string', format: 'uuid' };
const labParams = { type: 'object', required: ['labId'], properties: { labId: uuid } };
const captureParams = {
  type: 'object',
  required: ['labId', 'requestId'],
  properties: { labId: uuid, requestId: uuid },
};
const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const RESPONSE_LIMIT = 16 * 1024;

// Bound the whole response, including a receiver that sends headers then stalls.
export async function deliver({ url, body, contentType, runId, timeoutMs }) {
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = null;
  let responseType = null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      body,
      headers: {
        'content-type': contentType || 'application/octet-stream',
        'x-webhook-lab-run-id': runId,
      },
    });
    status = response.status;
    responseType = response.headers.get('content-type');
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    let truncated = false;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const remaining = RESPONSE_LIMIT - size;
          chunks.push(value.subarray(0, remaining));
          size += Math.min(value.length, remaining);
          if (value.length > remaining) {
            truncated = true;
            await reader.cancel();
            break;
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    return {
      state: response.ok ? 'succeeded' : 'failed',
      http_status: status,
      response_body_base64: Buffer.concat(chunks).toString('base64'),
      response_content_type: responseType,
      response_truncated: truncated,
      error: null,
      duration_ms: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      state: controller.signal.aborted ? 'timeout' : 'failed',
      http_status: status,
      response_body_base64: '',
      response_content_type: responseType,
      response_truncated: false,
      error: controller.signal.aborted
        ? 'Receiver did not finish before the timeout. It may have received the body.'
        : error.message.slice(0, 500),
      duration_ms: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function registerReplay(app, database, { transport = deliver } = {}) {
  const active = new Set();
  async function recover(tx = database) {
    await tx.query(`UPDATE replay_runs SET state = 'interrupted', finished_at = now(),
      error = 'Replay was interrupted. The receiver may have received the body.'
      WHERE state = 'running' AND started_at < now() - interval '15 seconds'`);
  }
  await recover();
  async function lockLab(tx, labId) {
    const { rows } = await tx.query('SELECT * FROM labs WHERE id = $1 FOR UPDATE', [labId]);
    if (!rows[0]) throw failure('Lab not found.', 404);
    return rows[0];
  }
  async function ensureIdle(tx, labId) {
    await recover(tx);
    const { rows } = await tx.query(
      "SELECT id FROM replay_runs WHERE lab_id = $1 AND state = 'running' LIMIT 1",
      [labId],
    );
    if (rows.length) throw failure('Wait for the current replay to finish, then try again.', 409);
  }
  async function settings(tx, labId) {
    await tx.query('INSERT INTO mock_receivers (lab_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      labId,
    ]);
    return (await tx.query('SELECT * FROM mock_receivers WHERE lab_id = $1', [labId])).rows[0];
  }
  function viewRun(run) {
    return {
      ...run,
      response_body: Buffer.from(run.response_body_base64, 'base64').toString('utf8'),
    };
  }

  app.get('/api/labs/:labId/receiver', { schema: { params: labParams } }, async (request) =>
    database.transaction(async (tx) => {
      await lockLab(tx, request.params.labId);
      return receiverSummary(tx, await settings(tx, request.params.labId));
    }),
  );
  app.put(
    '/api/labs/:labId/receiver',
    {
      schema: {
        params: labParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['fail_first', 'delay_ms'],
          properties: {
            fail_first: { type: 'integer', minimum: 0, maximum: 10 },
            delay_ms: { type: 'integer', minimum: 0, maximum: 5000 },
            idempotency_enabled: { type: 'boolean' },
          },
        },
      },
    },
    async (request) =>
      database.transaction(async (tx) => {
        const labId = request.params.labId;
        await lockLab(tx, labId);
        await ensureIdle(tx, labId);
        await settings(tx, labId);
        const { rows } = await tx.query(
          `UPDATE mock_receivers SET fail_first = $2, delay_ms = $3, received_count = 0,
           idempotency_enabled = COALESCE($4, idempotency_enabled) WHERE lab_id = $1 RETURNING *`,
          [
            labId,
            request.body.fail_first,
            request.body.delay_ms,
            request.body.idempotency_enabled ?? null,
          ],
        );
        return receiverSummary(tx, rows[0]);
      }),
  );

  app.get(
    '/api/labs/:labId/requests/:requestId/replays',
    {
      schema: {
        params: captureParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } },
        },
      },
    },
    async (request) => {
      const { labId, requestId } = request.params;
      const capture = await database.query(
        'SELECT id FROM captured_requests WHERE lab_id = $1 AND id = $2',
        [labId, requestId],
      );
      if (!capture.rows.length) throw failure('Request not found.', 404);
      await recover();
      const { rows } = await database.query(
        `SELECT * FROM replay_runs WHERE lab_id = $1 AND capture_id = $2 ORDER BY started_at DESC, id DESC LIMIT 20 OFFSET $3`,
        [labId, requestId, request.query.offset],
      );
      const counts = await database.query(
        'SELECT count(*)::int AS total FROM replay_runs WHERE lab_id = $1 AND capture_id = $2',
        [labId, requestId],
      );
      return { runs: rows.map(viewRun), total: counts.rows[0].total, offset: request.query.offset };
    },
  );

  app.post(
    '/api/labs/:labId/requests/:requestId/replays',
    {
      schema: {
        params: captureParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            timeout_ms: { type: 'integer', minimum: 100, maximum: 10000, default: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      if (active.size >= 8) throw failure('Too many active replays. Try again shortly.', 429);
      const { labId, requestId } = request.params;
      const id = randomUUID();
      active.add(id);
      try {
        const { capture, token } = await database.transaction(async (tx) => {
          const lab = await lockLab(tx, labId);
          const { rows } = await tx.query(
            'SELECT * FROM captured_requests WHERE lab_id = $1 AND id = $2',
            [labId, requestId],
          );
          if (!rows[0]) throw failure('Request not found.', 404);
          // One experiment per lab at a time makes fail-first behavior reproducible.
          await ensureIdle(tx, labId);
          await tx.query(
            `INSERT INTO replay_runs (id, lab_id, capture_id, timeout_ms) VALUES ($1, $2, $3, $4)`,
            [id, labId, requestId, request.body.timeout_ms],
          );
          return { capture: rows[0], token: lab.token };
        });
        const address = app.server.address();
        // Always target this process over loopback; APP_ORIGIN is only a display setting.
        const result = address
          ? await transport({
              url: `http://127.0.0.1:${address.port}/mock/${token}`,
              body: Buffer.from(capture.raw_body_base64, 'base64'),
              contentType: capture.content_type,
              runId: id,
              timeoutMs: request.body.timeout_ms,
            })
          : {
              state: 'failed',
              http_status: null,
              response_body_base64: '',
              response_content_type: null,
              response_truncated: false,
              error: 'The API must be listening before replay.',
              duration_ms: 0,
            };
        const { rows } = await database.query(
          `UPDATE replay_runs SET state = $2, http_status = $3,
        response_body_base64 = $4, response_content_type = $5, response_truncated = $6,
        error = $7, duration_ms = $8, finished_at = now() WHERE id = $1 RETURNING *`,
          [
            id,
            result.state,
            result.http_status,
            result.response_body_base64,
            result.response_content_type,
            result.response_truncated,
            result.error,
            result.duration_ms,
          ],
        );
        return reply.code(201).send(viewRun(rows[0]));
      } finally {
        active.delete(id);
      }
    },
  );

  app.delete(
    '/api/labs/:labId/requests',
    {
      schema: {
        params: labParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['confirm'],
          properties: { confirm: { type: 'string', maxLength: 60 } },
        },
      },
    },
    async (request) =>
      database.transaction(async (tx) => {
        const labId = request.params.labId;
        const lab = await lockLab(tx, labId);
        if (request.body.confirm !== lab.name)
          throw failure('Type the lab name to confirm clearing its inbox.', 400);
        await ensureIdle(tx, labId);
        const count = await tx.query(
          'SELECT count(*)::int AS total FROM captured_requests WHERE lab_id = $1',
          [labId],
        );
        await tx.query('DELETE FROM captured_requests WHERE lab_id = $1', [labId]);
        await tx.query('DELETE FROM mock_receipts WHERE lab_id = $1', [labId]);
        await tx.query('UPDATE mock_receivers SET received_count = 0 WHERE lab_id = $1', [labId]);
        return { cleared: count.rows[0].total };
      }),
  );

  await app.register(
    async (mock) => {
      mock.removeAllContentTypeParsers();
      mock.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
        done(null, body),
      );
      mock.post(
        '/:token',
        {
          schema: {
            params: {
              type: 'object',
              required: ['token'],
              properties: { token: { type: 'string', minLength: 1, maxLength: 100 } },
            },
          },
        },
        async (request, reply) => {
          const result = await database.transaction(async (tx) => {
            const labs = await tx.query('SELECT * FROM labs WHERE token = $1 FOR UPDATE', [
              request.params.token,
            ]);
            if (!labs.rows[0]) throw failure('Receiver not found.', 404);
            const labId = labs.rows[0].id;
            await settings(tx, labId);
            const { rows } = await tx.query(
              'UPDATE mock_receivers SET received_count = received_count + 1 WHERE lab_id = $1 RETURNING *',
              [labId],
            );
            return acceptMock(tx, rows[0], request.body || Buffer.alloc(0), {
              runId: String(request.headers['x-webhook-lab-run-id'] || '').slice(0, 100),
              contentType: request.headers['content-type'] || null,
            });
          });
          if (result.config.delay_ms) await delay(result.config.delay_ms);
          return reply.code(result.status).send(result.response);
        },
      );
    },
    { prefix: '/mock' },
  );
}
