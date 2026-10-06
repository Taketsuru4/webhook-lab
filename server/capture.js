import { randomUUID } from 'node:crypto';

const sensitiveHeader =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-access-token|x-webhook-secret)$/i;

export function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      sensitiveHeader.test(key) ? '[REDACTED]' : value,
    ]),
  );
}

function metadataText(value, maxLength, fallback) {
  // PostgreSQL text cannot store NUL. Check the complete value before truncation.
  // Keep unsupported metadata unavailable without modifying the original body.
  if (typeof value !== 'string' || value.includes('\u0000')) return fallback;
  return value.slice(0, maxLength);
}

export function describeBody(body) {
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    /* Raw bodies are valid captures. */
  }
  const object = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return {
    eventId: metadataText(object.id, 200, null),
    eventType: metadataText(object.type, 120, 'untyped'),
  };
}

export async function saveCapture(database, labId, body, headers) {
  const id = randomUUID();
  const { eventId, eventType } = describeBody(body);
  const { rows } = await database.query(
    `
    INSERT INTO captured_requests
      (id, lab_id, event_id, event_type, headers, raw_body_base64, content_type, size_bytes)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
    RETURNING id, event_id, event_type, received_at, size_bytes
  `,
    [
      id,
      labId,
      eventId,
      eventType,
      JSON.stringify(redactHeaders(headers)),
      body.toString('base64'),
      headers['content-type'] || 'application/octet-stream',
      body.length,
    ],
  );
  return rows[0];
}
