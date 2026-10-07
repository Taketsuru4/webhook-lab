import { randomUUID } from 'node:crypto';
import { storeResult, viewRun } from './delivery.js';

const activeStates = ['queued', 'running', 'waiting_retry'];
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });
export function retryable(result) {
  return (
    result.state === 'timeout' ||
    (result.state === 'failed' &&
      (result.http_status === null ||
        result.http_status === 408 ||
        result.http_status === 429 ||
        result.http_status >= 500))
  );
}

export function createJobWorker({ app, database, transport, lockLab }) {
  let timer;
  let stopping = true;
  let current;

  async function recover() {
    await database.transaction(async (tx) => {
      // The local worker has one process. Stale leases represent uncertain attempts, not unsent work.
      const { rows } = await tx.query(
        "SELECT id, lab_id FROM delivery_jobs WHERE state = 'running' AND lease_started_at < now() - interval '15 seconds'",
      );
      for (const row of rows) {
        await lockLab(tx, row.lab_id);
        const jobs = await tx.query(
          "SELECT * FROM delivery_jobs WHERE id = $1 AND state = 'running' AND lease_started_at < now() - interval '15 seconds' FOR UPDATE",
          [row.id],
        );
        const job = jobs.rows[0];
        if (!job) continue;
        await tx.query(
          `UPDATE replay_runs SET state = 'interrupted', finished_at = now(), error = 'Worker interrupted; the receiver may have processed the body.' WHERE delivery_job_id = $1 AND state = 'running'`,
          [job.id],
        );
        const state = job.cancel_requested
          ? 'cancelled'
          : job.attempt_count >= job.max_attempts
            ? 'failed'
            : 'waiting_retry';
        await tx.query(
          `UPDATE delivery_jobs SET state = $2, lease_started_at = NULL, next_attempt_at = now(),
          last_error = 'An interrupted attempt may have reached the receiver.', finished_at = CASE WHEN $2 IN ('failed','cancelled') THEN now() ELSE NULL END WHERE id = $1`,
          [job.id, state],
        );
      }
    });
  }
  async function claim() {
    return database.transaction(async (tx) => {
      const candidates = await tx.query(
        "SELECT id, lab_id FROM delivery_jobs WHERE state IN ('queued','waiting_retry') AND next_attempt_at <= now() ORDER BY next_attempt_at, id LIMIT 1",
      );
      if (!candidates.rows.length) return null;
      const candidate = candidates.rows[0];
      const lab = await lockLab(tx, candidate.lab_id);
      const { rows } = await tx.query(
        "SELECT * FROM delivery_jobs WHERE id = $1 AND state IN ('queued','waiting_retry') AND next_attempt_at <= now() FOR UPDATE",
        [candidate.id],
      );
      if (!rows.length) return null;
      const job = rows[0];
      const manual = await tx.query(
        "SELECT id FROM replay_runs WHERE lab_id = $1 AND delivery_job_id IS NULL AND state = 'running' LIMIT 1",
        [job.lab_id],
      );
      if (manual.rows.length) return null;
      const capture = (
        await tx.query('SELECT * FROM captured_requests WHERE id = $1 AND lab_id = $2', [
          job.capture_id,
          job.lab_id,
        ])
      ).rows[0];
      if (!capture) throw new Error('Queued capture is unavailable.');
      const runId = randomUUID();
      const attempt = job.attempt_count + 1;
      await tx.query(
        `INSERT INTO replay_runs (id, lab_id, capture_id, timeout_ms, delivery_job_id, attempt_number) VALUES ($1,$2,$3,$4,$5,$6)`,
        [runId, job.lab_id, job.capture_id, job.timeout_ms, job.id, attempt],
      );
      await tx.query(
        "UPDATE delivery_jobs SET state = 'running', attempt_count = $2, lease_started_at = now() WHERE id = $1",
        [job.id, attempt],
      );
      return { ...job, attempt_count: attempt, runId, token: lab.token, capture };
    });
  }
  async function execute() {
    const address = app.server.address();
    if (!address) return false;
    await recover();
    const job = await claim();
    if (!job) return false;
    const result = await transport({
      url: `http://127.0.0.1:${address.port}/mock/${job.token}`,
      body: Buffer.from(job.capture.raw_body_base64, 'base64'),
      contentType: job.capture.content_type,
      runId: job.runId,
      timeoutMs: job.timeout_ms,
    });
    await database.transaction(async (tx) => {
      await lockLab(tx, job.lab_id);
      const latest = (
        await tx.query('SELECT * FROM delivery_jobs WHERE id = $1 FOR UPDATE', [job.id])
      ).rows[0];
      // Do not let a late result overwrite a newer lease after recovery.
      if (!latest || latest.state !== 'running' || latest.attempt_count !== job.attempt_count)
        return;
      await storeResult(tx, job.runId, result);
      const retry =
        result.state !== 'succeeded' && retryable(result) && job.attempt_count < job.max_attempts;
      const state = latest.cancel_requested
        ? 'cancelled'
        : result.state === 'succeeded'
          ? 'succeeded'
          : retry
            ? 'waiting_retry'
            : 'failed';
      const backoff = Math.min(5000, job.retry_delay_ms * 2 ** (job.attempt_count - 1));
      const message =
        result.state === 'succeeded'
          ? null
          : result.error || `Receiver returned HTTP ${result.http_status}.`;
      await tx.query(
        `UPDATE delivery_jobs SET state = $2, next_attempt_at = now() + $3 * interval '1 millisecond',
        lease_started_at = NULL, last_error = $4, finished_at = CASE WHEN $2 IN ('succeeded','failed','cancelled') THEN now() ELSE NULL END WHERE id = $1`,
        [job.id, state, backoff, message],
      );
    });
    return true;
  }
  function processOne() {
    if (current) return current;
    current = execute().finally(() => {
      current = null;
    });
    return current;
  }
  async function tick() {
    try {
      await processOne();
    } catch (failure) {
      app.log.error(failure, 'Delivery worker attempt failed');
    }
    if (!stopping) {
      timer = setTimeout(tick, 250);
      timer.unref();
    }
  }
  return {
    processOne,
    start() {
      if (!stopping) return;
      stopping = false;
      tick();
    },
    async stop() {
      stopping = true;
      clearTimeout(timer);
      try {
        await current;
      } catch {
        /* Persisted lease is recovered after restart. */
      }
    },
  };
}

export async function registerJobs(
  app,
  database,
  { transport, workerEnabled, lockLab, ensureIdle, captureParams },
) {
  const path = '/api/labs/:labId/requests/:requestId/jobs';
  async function requireCapture(labId, requestId, tx = database) {
    const { rows } = await tx.query(
      'SELECT id FROM captured_requests WHERE id = $1 AND lab_id = $2',
      [requestId, labId],
    );
    if (!rows.length) throw error('Request not found.', 404);
  }
  app.post(
    path,
    {
      schema: {
        params: captureParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            timeout_ms: { type: 'integer', minimum: 100, maximum: 10000, default: 2000 },
            max_attempts: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
            retry_delay_ms: { type: 'integer', minimum: 250, maximum: 5000, default: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { labId, requestId } = request.params;
      const job = await database.transaction(async (tx) => {
        await lockLab(tx, labId);
        await requireCapture(labId, requestId, tx);
        await ensureIdle(tx, labId);
        return (
          await tx.query(
            'INSERT INTO delivery_jobs (id, lab_id, capture_id, timeout_ms, max_attempts, retry_delay_ms) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
            [
              randomUUID(),
              labId,
              requestId,
              request.body.timeout_ms,
              request.body.max_attempts,
              request.body.retry_delay_ms,
            ],
          )
        ).rows[0];
      });
      return reply.code(202).send(job);
    },
  );
  app.get(
    path,
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
      await requireCapture(labId, requestId);
      const { rows } = await database.query(
        'SELECT * FROM delivery_jobs WHERE lab_id = $1 AND capture_id = $2 ORDER BY created_at DESC, id DESC LIMIT 10 OFFSET $3',
        [labId, requestId, request.query.offset],
      );
      const total = (
        await database.query(
          'SELECT count(*)::int AS total FROM delivery_jobs WHERE lab_id = $1 AND capture_id = $2',
          [labId, requestId],
        )
      ).rows[0].total;
      const runs = rows.length
        ? (
            await database.query(
              'SELECT * FROM replay_runs WHERE delivery_job_id = ANY($1::uuid[]) ORDER BY attempt_number',
              [rows.map((job) => job.id)],
            )
          ).rows
        : [];
      const activeJob =
        (
          await database.query(
            "SELECT id, capture_id, state FROM delivery_jobs WHERE lab_id = $1 AND state IN ('queued','running','waiting_retry') LIMIT 1",
            [labId],
          )
        ).rows[0] || null;
      return {
        active_job: activeJob,
        jobs: rows.map((job) => ({
          ...job,
          attempts: runs.filter((run) => run.delivery_job_id === job.id).map(viewRun),
        })),
        total,
        offset: request.query.offset,
      };
    },
  );
  app.post(
    `${path}/:jobId/cancel`,
    {
      schema: {
        params: {
          ...captureParams,
          required: [...captureParams.required, 'jobId'],
          properties: { ...captureParams.properties, jobId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request) =>
      database.transaction(async (tx) => {
        const { labId, requestId, jobId } = request.params;
        await lockLab(tx, labId);
        const job = (
          await tx.query(
            'SELECT * FROM delivery_jobs WHERE id = $1 AND lab_id = $2 AND capture_id = $3 FOR UPDATE',
            [jobId, labId, requestId],
          )
        ).rows[0];
        if (!job) throw error('Delivery job not found.', 404);
        if (!activeStates.includes(job.state)) return job;
        return (
          await tx.query(
            `UPDATE delivery_jobs SET cancel_requested = true,
      state = CASE WHEN state = 'running' THEN state ELSE 'cancelled' END,
      finished_at = CASE WHEN state = 'running' THEN NULL ELSE now() END WHERE id = $1 RETURNING *`,
            [jobId],
          )
        ).rows[0];
      }),
  );
  const worker = createJobWorker({ app, database, transport, lockLab });
  app.decorate('deliveryWorker', worker);
  app.addHook('onListen', async () => {
    if (workerEnabled) worker.start();
  });
  app.addHook('preClose', async () => {
    await worker.stop();
  });
}
