import { api } from './api.js';

export async function readInbox(labId, params, signal, timeoutMs = 10000) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  let failure;
  const timer = setTimeout(() => {
    failure ||= new Error('Inbox refresh timed out. Please retry.');
    controller.abort();
  }, timeoutMs);
  async function read(path) {
    try {
      return await api(path, { signal: controller.signal });
    } catch (error) {
      failure ||= error;
      controller.abort();
      throw error;
    }
  }
  try {
    // Drain both reads even on failure before the caller can schedule another poll.
    const results = await Promise.allSettled([
      read(`/api/labs/${labId}/requests?${params}`),
      read(`/api/labs/${labId}/stats`),
    ]);
    signal.throwIfAborted();
    if (failure) throw failure;
    return results.map((result) => result.value);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
