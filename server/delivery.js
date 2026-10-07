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

export function viewRun(run) {
  return {
    ...run,
    response_body: Buffer.from(run.response_body_base64, 'base64').toString('utf8'),
  };
}

export async function storeResult(tx, id, result) {
  const { rows } = await tx.query(
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
  return rows[0];
}
