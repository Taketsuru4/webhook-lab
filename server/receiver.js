import { createHash, randomUUID } from 'node:crypto';
import { describeBody } from './capture.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function receiverSummary(tx, config) {
  const { rows } = await tx.query(
    `SELECT
    (SELECT count(*)::int FROM mock_effects WHERE lab_id = $1) AS processed_count,
    count(*) FILTER (WHERE outcome = 'duplicate')::int AS deduplicated_count,
    count(*) FILTER (WHERE outcome = 'conflict')::int AS conflict_count
    FROM mock_receipts WHERE lab_id = $1`,
    [config.lab_id],
  );
  return { ...config, ...rows[0] };
}

// The caller holds the lab row lock. Receipt, key reservation and demo effect commit together.
export async function acceptMock(tx, config, body, { runId, contentType }) {
  const receiptId = randomUUID();
  const eventId = describeBody(body).eventId;
  const hasKey = typeof eventId === 'string' && eventId.length > 0;
  const keyHash = config.idempotency_enabled && hasKey ? digest(eventId) : null;
  const bodyHash = digest(body);
  let status = config.received_count <= config.fail_first ? 500 : 200;
  let outcome =
    status === 500
      ? 'failed'
      : config.idempotency_enabled && !hasKey
        ? 'processed_without_key'
        : 'processed';
  let effectId = null;
  let message =
    status === 500 ? 'Configured mock failure.' : 'Mock receiver processed one demo action.';

  if (status === 200 && keyHash) {
    const { rows } = await tx.query(
      'SELECT * FROM mock_effects WHERE lab_id = $1 AND key_hash = $2',
      [config.lab_id, keyHash],
    );
    if (rows[0]) {
      // Compare complete keys as well as hashes; never turn a digest collision into a duplicate.
      if (rows[0].event_id !== eventId || rows[0].body_hash !== bodyHash) {
        status = 409;
        outcome = 'conflict';
        message =
          'This event ID is already bound to a different body. No new demo action was processed.';
      } else {
        outcome = 'duplicate';
        effectId = rows[0].id;
        message = 'Duplicate acknowledged. The original demo action was not repeated.';
      }
    }
  }
  if (outcome === 'processed' || outcome === 'processed_without_key') effectId = randomUUID();
  if (outcome === 'processed_without_key')
    message = 'No usable event ID: processed without duplicate protection.';
  await tx.query(
    `INSERT INTO mock_receipts
    (id, lab_id, run_id, raw_body_base64, size_bytes, content_type, http_status, outcome, event_id, effect_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      receiptId,
      config.lab_id,
      runId,
      body.toString('base64'),
      body.length,
      contentType,
      status,
      outcome,
      eventId,
      effectId,
    ],
  );
  if (outcome === 'processed' || outcome === 'processed_without_key') {
    await tx.query(
      `INSERT INTO mock_effects (id, lab_id, first_receipt_id, event_id, key_hash, body_hash)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [effectId, config.lab_id, receiptId, eventId, keyHash, bodyHash],
    );
  }
  const summary = await receiverSummary(tx, config);
  return {
    status,
    config: summary,
    response: {
      received: true,
      attempt: config.received_count,
      size_bytes: body.length,
      outcome,
      effect_id: effectId,
      processed_count: summary.processed_count,
      message,
    },
  };
}
