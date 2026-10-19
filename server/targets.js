const invalid = (message) => Object.assign(new Error(message), { statusCode: 400 });

// Accept literal loopback only. Never resolve a user-supplied hostname through DNS.
export function localTarget(value, appPort) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\#]/.test(value))
    throw invalid(
      'Use an HTTP localhost or 127.0.0.1 URL with an explicit port, without credentials or fragments.',
    );
  const match = /^http:\/\/(localhost|127\.0\.0\.1):(\d{1,5})(?:[/?]|$)/.exec(value);
  const port = Number(match?.[2]);
  if (!match || port < 1 || port > 65535)
    throw invalid('Use http://localhost:PORT/path or http://127.0.0.1:PORT/path (port 1–65535).');
  if (port === appPort) throw invalid('Choose a different port from the Webhook Lab API.');
  const url = new URL(value);
  return `http://127.0.0.1:${port}${url.pathname}${url.search}`;
}

export function snapshotTarget(lab, app) {
  return {
    target_mode: lab.delivery_mode,
    target_url:
      lab.delivery_mode === 'local'
        ? localTarget(lab.delivery_url, app.server.address()?.port)
        : null,
  };
}

export function deliveryUrl(target, app, token) {
  const port = app.server.address()?.port;
  if (!port) throw new Error('The API must be listening before replay.');
  return target.target_mode === 'local'
    ? localTarget(target.target_url, port)
    : `http://127.0.0.1:${port}/mock/${token}`;
}

export function registerTargets(app, database, { labParams, lockLab }) {
  const path = '/api/labs/:labId/delivery-target';
  const view = (lab) => ({ mode: lab.delivery_mode, url: lab.delivery_url });
  app.get(path, { schema: { params: labParams } }, async (request) =>
    database.transaction(async (tx) => view(await lockLab(tx, request.params.labId))),
  );
  app.put(
    path,
    {
      schema: {
        params: labParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['mode', 'url'],
          properties: {
            mode: { type: 'string', enum: ['mock', 'local'] },
            url: { anyOf: [{ type: 'string', maxLength: 2048 }, { type: 'null' }] },
          },
        },
      },
    },
    async (request) => {
      const { mode, url } = request.body;
      const normalized = mode === 'local' ? localTarget(url, app.server.address()?.port) : null;
      return database.transaction(async (tx) => {
        await lockLab(tx, request.params.labId);
        const { rows } = await tx.query(
          'UPDATE labs SET delivery_mode = $2, delivery_url = $3 WHERE id = $1 RETURNING *',
          [request.params.labId, mode, normalized],
        );
        return view(rows[0]);
      });
    },
  );
}
