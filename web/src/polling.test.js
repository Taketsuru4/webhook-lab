import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api.js';
import { readInbox } from './polling.js';

vi.mock('./api.js', () => ({ api: vi.fn() }));
beforeEach(() => {
  api.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

it('aborts the sibling read and waits for its cleanup before rejecting', async () => {
  const failure = new Error('Requests unavailable');
  let finishSibling;
  let aborted = false;
  api.mockImplementation((path, { signal }) => {
    if (path.includes('/requests?')) return Promise.reject(failure);
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          finishSibling = () => reject(new DOMException('Cancelled', 'AbortError'));
        },
        { once: true },
      );
    });
  });
  let settled = false;
  const result = readInbox('lab', '', new AbortController().signal);
  const observed = result.catch((error) => {
    settled = true;
    return error;
  });
  await vi.waitFor(() => expect(aborted).toBe(true));
  expect(settled).toBe(false);
  expect(api).toHaveBeenCalledTimes(2);
  finishSibling();
  expect(await observed).toBe(failure);
});

it('times out stalled reads and cancels both requests', async () => {
  vi.useFakeTimers();
  const signals = [];
  api.mockImplementation(
    (_path, { signal }) =>
      new Promise((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        );
      }),
  );
  const outcome = readInbox('lab', '', new AbortController().signal, 100).catch((error) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect((await outcome).message).toContain('timed out');
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels both reads when the selected lab or effect changes', async () => {
  const parent = new AbortController();
  const signals = [];
  api.mockImplementation(
    (_path, { signal }) =>
      new Promise((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        );
      }),
  );
  const result = readInbox('lab', '', parent.signal);
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  parent.abort();
  await rejection;
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
