import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ReplayPanel from './ReplayPanel.jsx';
import { api } from './api.js';

vi.mock('./api.js', async (original) => ({ ...(await original()), api: vi.fn() }));
const capture = { id: 'capture-1' };
const base = '/api/labs/lab-1';
let receiver;
let runs;
let destination;
const run = (state = 'succeeded') => ({
  id: 'run-1',
  state,
  http_status: state === 'succeeded' ? 200 : 500,
  duration_ms: 23,
  started_at: '2026-10-06T12:00:00Z',
  response_body: 'mock response',
});

beforeEach(() => {
  receiver = { fail_first: 1, delay_ms: 0, received_count: 0 };
  runs = [];
  destination = { mode: 'mock', url: null };
  api.mockImplementation(async (path, options) => {
    if (path.endsWith('/delivery-target')) {
      if (options?.method === 'PUT') {
        destination = JSON.parse(options.body);
        if (destination.url) destination.url = destination.url.replace('localhost', '127.0.0.1');
      }
      return destination;
    }
    if (path.includes('/jobs')) return { jobs: [], total: 0, offset: 0 };
    if (path.endsWith('/receiver')) {
      if (options?.method === 'PUT') receiver = { ...JSON.parse(options.body), received_count: 0 };
      return receiver;
    }
    if (path.endsWith('/replays') && options?.method === 'POST') {
      runs = [run('failed')];
      receiver = { ...receiver, received_count: 1 };
      return runs[0];
    }
    if (path.includes('/replays?')) return { runs, total: runs.length, offset: 0 };
    throw new Error(`Unexpected ${path}`);
  });
});

it('saves a normalized local endpoint, hides mock controls and records the actual destination', async () => {
  const user = userEvent.setup();
  render(<ReplayPanel capture={capture} labId="lab-1" />);
  await screen.findByText(/No attempts yet/);
  await user.selectOptions(screen.getByLabelText('Receiver'), 'local');
  expect(screen.queryByText(/Receiver behavior/)).toBeNull();
  expect(screen.queryByText('Demo actions processed')).toBeNull();
  await user.type(screen.getByLabelText('Local receiver URL'), 'http://localhost:3000/webhooks');
  expect(screen.getByRole('button', { name: 'Replay original body' }).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Queue delivery' }).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Save destination' }));
  await screen.findByText('Saved destination: http://127.0.0.1:3000/webhooks');
  expect(screen.getByLabelText('Local receiver URL').value).toBe('http://127.0.0.1:3000/webhooks');
  expect(screen.getByRole('button', { name: 'Replay original body' }).disabled).toBe(false);
  const original = api.getMockImplementation();
  api.mockImplementation(async (path, options) => {
    if (path.endsWith('/replays') && options?.method === 'POST') {
      runs = [
        {
          ...run(),
          target_mode: 'local',
          target_url: destination.url,
          response_body: '{"outcome":"duplicate"}',
        },
      ];
      return runs[0];
    }
    return original(path, options);
  });
  await user.click(screen.getByRole('button', { name: 'Replay original body' }));
  expect(await screen.findByText('To: http://127.0.0.1:3000/webhooks')).toBeTruthy();
  expect(screen.queryByText('Duplicate skipped: original demo action retained')).toBeNull();
  expect(screen.getByText(/your receiver must handle duplicate deliveries safely/)).toBeTruthy();
});

it('keeps sending disabled after a rejected destination and allows correcting it', async () => {
  const original = api.getMockImplementation();
  api.mockImplementation((path, options) => {
    if (
      path.endsWith('/delivery-target') &&
      options?.method === 'PUT' &&
      options.body.includes('example.com')
    )
      throw new Error('Only local endpoints are allowed.');
    return original(path, options);
  });
  const user = userEvent.setup();
  render(<ReplayPanel capture={capture} labId="lab-1" />);
  await screen.findByText(/No attempts yet/);
  await user.selectOptions(screen.getByLabelText('Receiver'), 'local');
  const input = screen.getByLabelText('Local receiver URL');
  await user.type(input, 'http://example.com:3000/hook');
  await user.click(screen.getByRole('button', { name: 'Save destination' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Only local');
  expect(screen.getByRole('button', { name: 'Replay original body' }).disabled).toBe(true);
  await user.clear(input);
  await user.type(input, 'http://localhost:3000/hook');
  await user.click(screen.getByRole('button', { name: 'Save destination' }));
  await screen.findByText('Saved destination: http://127.0.0.1:3000/hook');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('loads a persisted local target and keeps old attempt destinations visible after switching to mock', async () => {
  destination = { mode: 'local', url: 'http://127.0.0.1:3000/old' };
  runs = [{ ...run(), target_mode: 'local', target_url: destination.url }];
  const user = userEvent.setup();
  render(<ReplayPanel capture={capture} labId="lab-1" />);
  await screen.findByText('To: http://127.0.0.1:3000/old');
  expect(screen.getByLabelText('Receiver').value).toBe('local');
  await user.selectOptions(screen.getByLabelText('Receiver'), 'mock');
  await user.click(screen.getByRole('button', { name: 'Save destination' }));
  await screen.findByText('Saved destination: Built-in mock');
  expect(screen.getByText('To: http://127.0.0.1:3000/old')).toBeTruthy();
  expect(screen.getByText(/Receiver behavior/)).toBeTruthy();
});
afterEach(() => {
  cleanup();
});

it('uses persisted receiver settings and saves edited scenarios before replay', async () => {
  const user = userEvent.setup();
  render(<ReplayPanel capture={capture} labId="lab-1" />);
  await screen.findByText(/No attempts yet/);
  await user.click(screen.getByText(/Receiver behavior/));
  const failInput = screen.getByLabelText('Fail first N requests');
  expect(failInput.value).toBe('1');
  await user.clear(failInput);
  await user.type(failInput, '2');
  expect(screen.getByRole('button', { name: 'Replay original body' }).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Save & reset receiver' }));
  await screen.findByText(/Saved: first 2 return 500/);
  expect(
    api.mock.calls.some(
      ([path, options]) =>
        path === `${base}/receiver` &&
        options?.method === 'PUT' &&
        JSON.parse(options.body).fail_first === 2,
    ),
  ).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Replay original body' }));
  expect(await screen.findByText('Failed')).toBeTruthy();
  expect(screen.getByText('HTTP 500 · 23 ms')).toBeTruthy();
  await user.click(screen.getByText('Receiver response'));
  expect(screen.getByText('mock response')).toBeTruthy();
});

it('keeps one replay pending and explains an uncertain failure with refresh available', async () => {
  let rejectReplay;
  const original = api.getMockImplementation();
  api.mockImplementation((path, options) =>
    options?.method === 'POST'
      ? new Promise((_resolve, reject) => {
          rejectReplay = reject;
        })
      : original(path, options),
  );
  const user = userEvent.setup();
  render(<ReplayPanel capture={capture} labId="lab-1" />);
  await screen.findByText(/No attempts yet/);
  await user.click(screen.getByRole('button', { name: 'Replay original body' }));
  expect(screen.getByRole('button', { name: 'Replaying…' }).disabled).toBe(true);
  await act(async () => rejectReplay(new Error('Connection lost')));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'receiver may have received the body',
  );
  await user.click(screen.getByRole('button', { name: 'Refresh replay history' }));
  await screen.findByText(/No attempts yet/);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not put a late result from a previous selection into the next request', async () => {
  let resolveReplay;
  const original = api.getMockImplementation();
  api.mockImplementation((path, options) =>
    options?.method === 'POST'
      ? new Promise((resolve) => {
          resolveReplay = resolve;
        })
      : original(path, options),
  );
  const user = userEvent.setup();
  const view = render(<ReplayPanel key="first" capture={capture} labId="lab-1" />);
  await screen.findByText(/No attempts yet/);
  await user.click(screen.getByRole('button', { name: 'Replay original body' }));
  view.rerender(<ReplayPanel key="second" capture={{ id: 'capture-2' }} labId="lab-1" />);
  await screen.findByText(/No attempts yet/);
  await act(async () => resolveReplay(run()));
  expect(screen.queryByText('Succeeded')).toBeNull();
  expect(screen.getByRole('button', { name: 'Replay original body' }).disabled).toBe(false);
});

it('renders persisted timeouts as uncertain receipts rather than confirmed receiver failure', async () => {
  runs = [
    {
      ...run('timeout'),
      http_status: null,
      response_body: '',
      error: 'Receiver did not finish before the timeout. It may have received the body.',
    },
  ];
  render(<ReplayPanel capture={capture} labId="lab-1" />);
  expect(await screen.findByText('Timed out')).toBeTruthy();
  expect(
    within(screen.getByRole('region', { name: 'Replay experiment' })).getByText(
      /may have received the body/,
    ),
  ).toBeTruthy();
});

it('saves the idempotency guard and distinguishes duplicate acknowledgement from a new action', async () => {
  receiver = {
    ...receiver,
    idempotency_enabled: true,
    processed_count: 1,
    deduplicated_count: 1,
    conflict_count: 0,
  };
  runs = [
    { ...run(), response_body: JSON.stringify({ outcome: 'duplicate', processed_count: 1 }) },
  ];
  const user = userEvent.setup();
  render(<ReplayPanel capture={capture} labId="lab-1" />);
  expect(await screen.findByText('Duplicate skipped: original demo action retained')).toBeTruthy();
  expect(screen.getByText('Succeeded')).toBeTruthy();
  expect(screen.getByText('Demo actions processed')).toBeTruthy();
  await user.click(screen.getByText(/Receiver behavior/));
  const guard = screen.getByRole('checkbox', { name: 'Protect against duplicate demo actions' });
  expect(guard.checked).toBe(true);
  await user.click(guard);
  expect(screen.getByRole('button', { name: 'Replay original body' }).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Save & reset receiver' }));
  expect(
    api.mock.calls.some(
      ([_path, options]) =>
        options?.method === 'PUT' && JSON.parse(options.body).idempotency_enabled === false,
    ),
  ).toBe(true);
});
