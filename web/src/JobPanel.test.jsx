import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import JobPanel from './JobPanel.jsx';
import { api } from './api.js';

vi.mock('./api.js', async (original) => ({ ...(await original()), api: vi.fn() }));
let data;
const activeChanged = vi.fn();
const changed = vi.fn();
const job = (state = 'queued') => ({
  id: 'job-1',
  capture_id: 'capture-1',
  state,
  attempt_count: 0,
  max_attempts: 3,
  created_at: '2026-10-06T12:00:00Z',
  attempts: [],
  cancel_requested: false,
});
const mount = (captureId = 'capture-1') =>
  render(
    <JobPanel
      key={captureId}
      labId="lab-1"
      captureId={captureId}
      timeoutMs={2000}
      disabled={false}
      onActiveChange={activeChanged}
      onChange={changed}
    />,
  );

beforeEach(() => {
  data = { jobs: [], total: 0, offset: 0, active_job: null };
  api.mockImplementation(async (path, options) => {
    if (options?.method === 'POST') {
      if (path.endsWith('/cancel'))
        data = {
          ...data,
          jobs: data.jobs.map((item) => ({ ...item, state: 'cancelled', cancel_requested: true })),
          active_job: null,
        };
      else data = { ...data, jobs: [job()], total: 1, active_job: job() };
      return data.jobs[0];
    }
    return data;
  });
});
afterEach(() => {
  cleanup();
});

it('queues the chosen retry policy and disables another job until cancellation', async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText('No queued deliveries yet.');
  const max = screen.getByLabelText('Maximum attempts');
  await user.clear(max);
  await user.type(max, '4');
  await user.click(screen.getByRole('button', { name: 'Queue delivery' }));
  expect(await screen.findByText('Queued')).toBeTruthy();
  expect(
    api.mock.calls.some(
      ([_path, options]) =>
        options?.method === 'POST' &&
        JSON.parse(options.body).max_attempts === 4 &&
        JSON.parse(options.body).timeout_ms === 2000,
    ),
  ).toBe(true);
  expect(screen.getByRole('button', { name: 'Queue delivery' }).disabled).toBe(true);
  expect(activeChanged).toHaveBeenCalledWith(true);
  await user.click(screen.getByRole('button', { name: 'Stop retries' }));
  expect(await screen.findByText('Cancelled')).toBeTruthy();
  expect(activeChanged).toHaveBeenLastCalledWith(false);
});

it('shows saved attempts and notifies receiver refresh after job progress', async () => {
  data = { ...data, jobs: [job()], total: 1, active_job: job() };
  const user = userEvent.setup();
  mount();
  await screen.findByText('Queued');
  data = {
    ...data,
    active_job: null,
    jobs: [
      {
        ...job('succeeded'),
        attempt_count: 2,
        attempts: [
          { id: 'one', attempt_number: 1, state: 'failed', http_status: 500, duration_ms: 20 },
          { id: 'two', attempt_number: 2, state: 'succeeded', http_status: 200, duration_ms: 15 },
        ],
      },
    ],
  };
  await user.click(screen.getByRole('button', { name: 'Refresh delivery jobs' }));
  expect(await screen.findByText('Delivered')).toBeTruthy();
  await user.click(screen.getByText('Attempt results'));
  expect(screen.getByText('HTTP 500 · 20 ms')).toBeTruthy();
  expect(screen.getByText('HTTP 200 · 15 ms')).toBeTruthy();
  expect(changed).toHaveBeenCalled();
});

it('warns that cancellation of a running attempt does not undo delivery', async () => {
  data = {
    ...data,
    active_job: job('running'),
    jobs: [{ ...job('running'), cancel_requested: true }],
    total: 1,
  };
  mount();
  expect(
    await screen.findByText('Stopping after the current attempt. Sending cannot be undone.'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Stop retries' }).disabled).toBe(true);
});

it('does not let a delayed enqueue result affect another selected capture', async () => {
  let resolvePost;
  api.mockImplementation((_path, options) =>
    options?.method === 'POST'
      ? new Promise((resolve) => {
          resolvePost = resolve;
        })
      : Promise.resolve(data),
  );
  const user = userEvent.setup();
  const view = mount();
  await screen.findByText('No queued deliveries yet.');
  await user.click(screen.getByRole('button', { name: 'Queue delivery' }));
  view.rerender(
    <JobPanel
      key="capture-2"
      labId="lab-1"
      captureId="capture-2"
      timeoutMs={2000}
      disabled={false}
      onActiveChange={activeChanged}
      onChange={changed}
    />,
  );
  await screen.findByText('No queued deliveries yet.');
  await act(async () => resolvePost(job()));
  expect(screen.queryByText('Queued')).toBeNull();
  expect(activeChanged).toHaveBeenLastCalledWith(false);
});

it('blocks another capture while this lab has a saved active job', async () => {
  data = { ...data, active_job: job() };
  mount('capture-2');
  expect(await screen.findByText(/active job for another capture/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Queue delivery' }).disabled).toBe(true);
});
