import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDemoApi } from './demo.js';
let demo, lab, id, path;
const send = (body) => ({ method: 'POST', body: JSON.stringify(body) });
beforeEach(async () => {
  vi.useFakeTimers();
  demo = createDemoApi();
  lab = (await demo.api('/api/labs')).labs[0];
  id = (await demo.api(`/api/labs/${lab.id}/requests`)).requests[0].id;
  path = `/api/labs/${lab.id}`;
});
afterEach(() => vi.useRealTimers());

it('seeds only synthetic captures, isolates visitors, searches duplicates and preserves Unicode bytes', async () => {
  expect((await demo.api(`${path}/stats`)).total).toBe(3);
  expect((await demo.api(`${path}/requests?filter=duplicates`)).total).toBe(2);
  const body = '{"id":"δοκιμή","type":"test.☕"}';
  const captured = await demo.api(`/hooks/${lab.token}`, { method: 'POST', body });
  const record = await demo.api(`${path}/requests/${captured.request_id}`);
  expect(
    new TextDecoder().decode(Uint8Array.from(atob(record.raw_body_base64), (c) => c.charCodeAt(0))),
  ).toBe(body);
  expect((await createDemoApi().api('/api/labs')).labs[0].id).not.toBe(lab.id);
  const other = await demo.api('/api/labs', send({ name: 'Other' }));
  expect((await demo.api(`/api/labs/${other.id}/requests`)).total).toBe(0);
  await expect(demo.api(`/api/labs/${other.id}/requests/${id}`)).rejects.toThrow('not found');
});

it('simulates 500,500,200 jobs without network and rejects real delivery destinations', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  await demo.api(`${path}/receiver`, {
    ...send({ fail_first: 2, delay_ms: 0, idempotency_enabled: true }),
    method: 'PUT',
  });
  await demo.api(`${path}/requests/${id}/jobs`, send({}));
  await vi.advanceTimersByTimeAsync(3000);
  const job = (await demo.api(`${path}/requests/${id}/jobs`)).jobs[0];
  expect(job.state).toBe('succeeded');
  expect(job.attempts.map((run) => run.http_status)).toEqual([500, 500, 200]);
  expect((await demo.api(`${path}/receiver`)).processed_count).toBe(1);
  await expect(
    demo.api(`${path}/delivery-target`, {
      ...send({ mode: 'local', url: 'http://localhost:3000' }),
      method: 'PUT',
    }),
  ).rejects.toThrow('local app');
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it('distinguishes duplicate acknowledgements and body conflicts from processed demo actions', async () => {
  await demo.api(`${path}/receiver`, {
    ...send({ fail_first: 0, delay_ms: 0, idempotency_enabled: true }),
    method: 'PUT',
  });
  for (let n = 0; n < 2; n++) {
    const result = demo.api(`${path}/requests/${id}/replays`, send({}));
    await vi.advanceTimersByTimeAsync(1);
    await result;
  }
  expect((await demo.api(`${path}/receiver`)).processed_count).toBe(1);
  expect((await demo.api(`${path}/receiver`)).deduplicated_count).toBe(1);
  const record = await demo.api(`${path}/requests/${id}`);
  const conflict = await demo.api(
    `/hooks/${lab.token}`,
    send({ id: record.event_id, type: 'different' }),
  );
  const result = demo.api(`${path}/requests/${conflict.request_id}/replays`, send({}));
  await vi.advanceTimersByTimeAsync(1);
  expect((await result).http_status).toBe(409);
});

it('cancels an in-flight simulation and requires typed-name cleanup', async () => {
  await demo.api(`${path}/receiver`, {
    ...send({ fail_first: 10, delay_ms: 500, idempotency_enabled: true }),
    method: 'PUT',
  });
  const job = await demo.api(`${path}/requests/${id}/jobs`, send({}));
  await vi.advanceTimersByTimeAsync(40);
  await demo.api(`${path}/requests/${id}/jobs/${job.id}/cancel`, send({}));
  await vi.advanceTimersByTimeAsync(3000);
  const saved = (await demo.api(`${path}/requests/${id}/jobs`)).jobs[0];
  expect(saved.state).toBe('cancelled');
  expect(saved.attempt_count).toBe(1);
  await expect(
    demo.api(`${path}/requests`, { ...send({ confirm: 'wrong' }), method: 'DELETE' }),
  ).rejects.toThrow('lab name');
  await demo.api(`${path}/requests`, { ...send({ confirm: lab.name }), method: 'DELETE' });
  expect((await demo.api(`${path}/stats`)).total).toBe(0);
});

it('simulates timeout uncertainty and respects aborted read requests', async () => {
  await demo.api(`${path}/receiver`, {
    ...send({ fail_first: 0, delay_ms: 3000, idempotency_enabled: true }),
    method: 'PUT',
  });
  const result = demo.api(`${path}/requests/${id}/replays`, send({ timeout_ms: 100 }));
  await vi.advanceTimersByTimeAsync(100);
  expect((await result).state).toBe('timeout');
  expect((await demo.api(`${path}/receiver`)).processed_count).toBe(1);
  await expect(demo.api('/api/labs', { signal: AbortSignal.abort() })).rejects.toThrow();
});
