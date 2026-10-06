import { StrictMode } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';
import { api } from './api.js';

vi.mock('./api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  api: vi.fn(),
}));

const labId = '00000000-0000-4000-8000-000000000001';
const captures = ['first', 'second'].map((name, index) => {
  const payload = { message: `${name} capture body` };
  const body = JSON.stringify(payload);
  return {
    id: `00000000-0000-4000-8000-00000000000${index + 2}`,
    event_id: `evt_${name}`,
    event_type: 'payment.succeeded',
    received_at: '2026-10-06T12:00:00.000Z',
    size_bytes: body.length,
    content_type: 'application/json',
    occurrences: 1,
    headers: { 'content-type': 'application/json' },
    is_json: true,
    payload,
    raw_body: body,
    raw_body_base64: btoa(body),
  };
});
const detailPath = (capture) => `/api/labs/${labId}/requests/${capture.id}`;

function responseFor(path) {
  if (path === '/api/labs') {
    return {
      database: 'embedded',
      labs: [{ id: labId, name: 'Payment playground', endpoint: '/hooks/local-playground' }],
    };
  }
  if (path === `/api/labs/${labId}/stats`) {
    return { total: 2, duplicates: 0, bytes: 100, traffic: [] };
  }
  if (path.startsWith(`/api/labs/${labId}/requests?`)) {
    return { requests: captures, total: captures.length, offset: 0 };
  }
  const capture = captures.find((item) => detailPath(item) === path);
  if (capture) return capture;
  throw new Error(`Unexpected API path: ${path}`);
}

function detailCalls(capture) {
  return api.mock.calls.filter(([path]) => path === detailPath(capture)).length;
}

async function openInbox() {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  const inbox = within(screen.getByRole('region', { name: 'Captured requests' }));
  const firstRow = await inbox.findByRole('button', { name: /evt_first/ });
  const secondRow = inbox.getByRole('button', { name: /evt_second/ });
  const inspector = within(screen.getByRole('region', { name: 'Request inspector' }));
  return { user, firstRow, secondRow, inspector };
}

beforeEach(() => {
  api.mockImplementation(async (path) => responseFor(path));
});

afterEach(() => {
  cleanup();
});

describe('request inspector selection', () => {
  it('keeps the loaded payload visible when the selected row is clicked again', async () => {
    const { user, firstRow, inspector } = await openInbox();
    await user.click(firstRow);
    expect((await inspector.findByRole('tabpanel')).textContent).toContain('first capture body');

    await user.click(firstRow);

    expect(inspector.queryByText('Loading request…')).toBeNull();
    expect(inspector.getByRole('tabpanel').textContent).toContain('first capture body');
    expect(detailCalls(captures[0])).toBe(1);
  });

  it('allows the original pending detail request to finish after a repeated click', async () => {
    let resolveDetail;
    const pendingDetail = new Promise((resolve) => {
      resolveDetail = resolve;
    });
    api.mockImplementation((path) =>
      path === detailPath(captures[0]) ? pendingDetail : Promise.resolve(responseFor(path)),
    );
    const { user, firstRow, inspector } = await openInbox();
    await user.click(firstRow);
    expect(inspector.getByText('Loading request…')).toBeTruthy();
    await user.click(firstRow);

    await act(async () => resolveDetail(captures[0]));

    expect((await inspector.findByRole('tabpanel')).textContent).toContain('first capture body');
    expect(detailCalls(captures[0])).toBe(1);
  });

  it('loads a different request when another row is selected', async () => {
    const { user, firstRow, secondRow, inspector } = await openInbox();
    await user.click(firstRow);
    expect((await inspector.findByRole('tabpanel')).textContent).toContain('first capture body');

    await user.click(secondRow);

    expect((await inspector.findByRole('tabpanel')).textContent).toContain('second capture body');
    expect(inspector.getByRole('tabpanel').textContent).not.toContain('first capture body');
    expect(detailCalls(captures[0])).toBe(1);
    expect(detailCalls(captures[1])).toBe(1);
  });

  it('fetches the same request again after the inspector is closed and reopened', async () => {
    const { user, firstRow, inspector } = await openInbox();
    await user.click(firstRow);
    await inspector.findByRole('tabpanel');

    await user.click(inspector.getByRole('button', { name: 'Close request inspector' }));
    expect(inspector.queryByRole('tabpanel')).toBeNull();
    await user.click(firstRow);

    expect((await inspector.findByRole('tabpanel')).textContent).toContain('first capture body');
    expect(detailCalls(captures[0])).toBe(2);
  });
});
