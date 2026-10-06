import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { saveCapture } from './capture.js';

const uuidSchema = { type: 'string', format: 'uuid' };
const labParams = { type: 'object', required: ['labId'], properties: { labId: uuidSchema } };

export async function createApp({
  database,
  logger = false,
  origin = 'http://localhost:4310',
  rateLimiting = true,
  serveWeb = true,
} = {}) {
  const app = Fastify({ logger, bodyLimit: 256 * 1024, requestTimeout: 10000 });
  if (rateLimiting)
    await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  // Conflict handling also makes default-lab creation safe across API replicas.
  await database.query(
    `
    INSERT INTO labs (id, name, token) VALUES ($1, $2, $3)
    ON CONFLICT (token) DO NOTHING
  `,
    ['00000000-0000-4000-8000-000000000001', 'Payment playground', 'local-playground'],
  );

  async function requireLab(id) {
    const { rows } = await database.query('SELECT * FROM labs WHERE id = $1', [id]);
    if (!rows[0]) throw Object.assign(new Error('Lab not found.'), { statusCode: 404 });
    return rows[0];
  }

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode || 500;
    if (status >= 500) request.log.error(error);
    reply
      .code(status)
      .send({ error: status >= 500 ? 'Something went wrong. Please try again.' : error.message });
  });

  app.get('/api/health', async () => {
    await database.query('SELECT 1');
    return { status: 'ok', database: database.mode, milestone: 'capture' };
  });

  app.get('/api/labs', async () => {
    const { rows } = await database.query('SELECT * FROM labs ORDER BY created_at ASC, id ASC');
    return {
      labs: rows.map((lab) => ({ ...lab, endpoint: `${origin}/hooks/${lab.token}` })),
      database: database.mode,
    };
  });

  app.post(
    '/api/labs',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 60 } },
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: 'Give your lab a name.' });
      const id = randomUUID();
      const token = randomBytes(18).toString('hex');
      const { rows } = await database.query(
        'INSERT INTO labs (id, name, token) VALUES ($1, $2, $3) RETURNING *',
        [id, name, token],
      );
      return reply.code(201).send({ ...rows[0], endpoint: `${origin}/hooks/${token}` });
    },
  );

  app.get(
    '/api/labs/:labId/requests',
    {
      schema: {
        params: labParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 120, default: '' },
            filter: { type: 'string', enum: ['all', 'duplicates', 'untyped'], default: 'all' },
            offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
          },
        },
      },
    },
    async (request) => {
      await requireLab(request.params.labId);
      const { q, filter, offset } = request.query;
      const conditions = ['r.lab_id = $1'];
      const params = [request.params.labId];
      if (q) {
        params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
        conditions.push(`(r.event_type ILIKE $2 OR r.event_id ILIKE $2 OR r.id::text ILIKE $2)`);
      }
      if (filter === 'untyped') conditions.push("r.event_type = 'untyped'");
      if (filter === 'duplicates')
        conditions.push(
          '(SELECT count(*) FROM captured_requests d WHERE d.lab_id = r.lab_id AND md5(d.event_id) = md5(r.event_id) AND d.event_id = r.event_id) > 1',
        );
      const where = conditions.join(' AND ');
      const { rows: counts } = await database.query(
        `SELECT count(*)::int AS total FROM captured_requests r WHERE ${where}`,
        params,
      );
      params.push(offset);
      const { rows } = await database.query(
        `
      SELECT r.id, r.event_id, r.event_type, r.received_at, r.size_bytes, r.content_type,
        CASE WHEN r.event_id IS NULL THEN 1 ELSE
          (SELECT count(*)::int FROM captured_requests d WHERE d.lab_id = r.lab_id AND md5(d.event_id) = md5(r.event_id) AND d.event_id = r.event_id)
        END AS occurrences
      FROM captured_requests r WHERE ${where}
      ORDER BY r.received_at DESC, r.id DESC LIMIT 50 OFFSET $${params.length}
    `,
        params,
      );
      return { requests: rows, total: counts[0].total, offset };
    },
  );

  app.get('/api/labs/:labId/stats', { schema: { params: labParams } }, async (request) => {
    await requireLab(request.params.labId);
    const params = [request.params.labId];
    const { rows } = await database.query(
      `
      SELECT count(*)::int AS total,
        (count(event_id) - count(DISTINCT event_id))::int AS duplicates,
        COALESCE(sum(size_bytes), 0)::bigint AS bytes,
        count(*) FILTER (WHERE received_at > now() - interval '1 hour')::int AS last_hour
      FROM captured_requests WHERE lab_id = $1
    `,
      params,
    );
    const { rows: traffic } = await database.query(
      `
      SELECT bucket, count(r.id)::int AS count
      FROM generate_series(0, 11) AS bucket
      LEFT JOIN captured_requests r ON r.lab_id = $1
        AND r.received_at > now() - (12 - bucket) * interval '5 minutes'
        AND r.received_at <= now() - (11 - bucket) * interval '5 minutes'
      GROUP BY bucket ORDER BY bucket
    `,
      params,
    );
    return { ...rows[0], bytes: Number(rows[0].bytes), traffic };
  });

  app.get(
    '/api/labs/:labId/requests/:requestId',
    {
      schema: {
        params: {
          ...labParams,
          required: ['labId', 'requestId'],
          properties: { labId: uuidSchema, requestId: uuidSchema },
        },
      },
    },
    async (request, reply) => {
      const { rows } = await database.query(
        'SELECT * FROM captured_requests WHERE id = $1 AND lab_id = $2',
        [request.params.requestId, request.params.labId],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'Request not found.' });
      const capture = rows[0];
      const rawBody = Buffer.from(capture.raw_body_base64, 'base64').toString('utf8');
      let payload = null;
      let isJson = false;
      try {
        payload = JSON.parse(rawBody);
        isJson = true;
      } catch {
        /* Return raw text for non-JSON requests. */
      }
      return { ...capture, raw_body: rawBody, payload, is_json: isJson };
    },
  );

  // Encapsulation keeps API JSON parsing independent from exact-byte webhook capture.
  await app.register(
    async (hooks) => {
      hooks.removeAllContentTypeParsers();
      hooks.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
        done(null, body),
      );
      hooks.post(
        '/:token',
        {
          config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
          schema: {
            params: {
              type: 'object',
              required: ['token'],
              properties: { token: { type: 'string', minLength: 1, maxLength: 100 } },
            },
          },
        },
        async (request, reply) => {
          const { rows } = await database.query('SELECT id FROM labs WHERE token = $1', [
            request.params.token,
          ]);
          if (!rows[0]) return reply.code(404).send({ error: 'Endpoint not found.' });
          const capture = await saveCapture(
            database,
            rows[0].id,
            request.body || Buffer.alloc(0),
            request.headers,
          );
          // Acknowledge only after the database confirms durable storage.
          return reply.code(202).send({ accepted: true, request_id: capture.id });
        },
      );
    },
    { prefix: '/hooks' },
  );

  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  if (serveWeb && existsSync(dist)) {
    await app.register(staticFiles, { root: dist });
  }
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Route not found.' }));
  return app;
}
