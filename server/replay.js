import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptMock, receiverSummary } from './receiver.js';
import { deliver, storeResult, viewRun } from './delivery.js';
import { registerJobs } from './jobs.js';
export { deliver } from './delivery.js';

const uuid = { type: 'string', format: 'uuid' };
const labParams = { type: 'object', required: ['labId'], properties: { labId: uuid } };
const captureParams = {
  type: 'object',
  required: ['labId', 'requestId'],
  properties: { labId: uuid, requestId: uuid },
};
const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });

export async function registerReplay(
  app,
  database,
  { transport = deliver, workerEnabled = true } = {},
) {
  const active = new Set();
  async function recover(tx = database) {
    await tx.query(`UPDATE replay_runs SET state = 'interrupted', finished_at = now(),
      error = 'Replay was interrupted. The receiver may have received the body.'
      WHERE delivery_job_id IS NULL AND state = 'running' AND started_at < now() - interval '15 seconds'`);
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
    const jobs = await tx.query(
      "SELECT id FROM delivery_jobs WHERE lab_id = $1 AND state IN ('queued','running','waiting_retry') LIMIT 1",
      [labId],
    );
    if (jobs.rows.length)
      throw failure('Wait for the queued delivery to finish or cancel it first.', 409);
  }
  async function settings(tx, labId) {
    await tx.query('INSERT INTO mock_receivers (lab_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      labId,
    ]);
    return (await tx.query('SELECT * FROM mock_receivers WHERE lab_id = $1', [labId])).rows[0];
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
        `SELECT * FROM replay_runs WHERE lab_id = $1 AND capture_id = $2 AND delivery_job_id IS NULL ORDER BY started_at DESC, id DESC LIMIT 20 OFFSET $3`,
        [labId, requestId, request.query.offset],
      );
      const counts = await database.query(
        'SELECT count(*)::int AS total FROM replay_runs WHERE lab_id = $1 AND capture_id = $2 AND delivery_job_id IS NULL',
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
        const run = await storeResult(database, id, result);
        return reply.code(201).send(viewRun(run));
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

  await registerJobs(app, database, {
    transport,
    workerEnabled,
    lockLab,
    ensureIdle,
    captureParams,
  });

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
