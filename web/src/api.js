export async function api(path, options = {}) {
  const response = await fetch(path, options);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The API is starting or unavailable. Please try again in a moment.');
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

export function jsonPost(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function sampleEvent() {
  return {
    id: `evt_${crypto.randomUUID().slice(0, 8)}`,
    type: 'payment.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: {
      order_id: 'order_1042',
      amount: 4900,
      currency: 'eur',
      customer: { name: 'Alex Morgan', email: 'alex@example.com' },
    },
  };
}

// Standard POSIX quoting keeps copied commands safe for arbitrary request text.
export function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function curlCommand(endpoint, body = JSON.stringify(sampleEvent(), null, 2)) {
  return `curl -X POST ${shellQuote(endpoint)} -H 'Content-Type: application/json' --data-binary ${shellQuote(body)}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
