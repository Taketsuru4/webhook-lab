import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// A disposable example handler, not a payment processor or a durable idempotent receiver.
const port = Number(process.env.RECEIVER_PORT || 3000);
const failFirst = Number(process.env.FAIL_FIRST || 0);
const delayMs = Number(process.env.DELAY_MS || 0);
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !Number.isInteger(failFirst) ||
  failFirst < 0 ||
  failFirst > 10 ||
  !Number.isInteger(delayMs) ||
  delayMs < 0 ||
  delayMs > 5000
) {
  throw new Error('Use RECEIVER_PORT 1–65535, FAIL_FIRST 0–10 and DELAY_MS 0–5000.');
}
let count = 0;
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/webhooks') {
    request.resume();
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 256 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const attempt = ++count;
    const body = Buffer.concat(chunks);
    console.log(
      `Attempt ${attempt}: ${body.length} bytes, run ${request.headers['x-webhook-lab-run-id'] || 'unknown'}`,
    );
    console.log(body.toString('utf8'));
    if (delayMs) await delay(delayMs);
    response.writeHead(attempt <= failFirst ? 500 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ attempt, received_bytes: body.length }));
  } catch (error) {
    console.error(error.message);
    if (!response.headersSent) response.writeHead(400);
    response.end();
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    `Receiver: http://localhost:${port}/webhooks (fail first ${failFirst}, delay ${delayMs} ms)`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
