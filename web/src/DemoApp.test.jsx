import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App.jsx';
import { createDemoApi } from './demo.js';
const state = vi.hoisted(() => ({ client: null }));
vi.mock('./api.js', async (original) => ({
  ...(await original()),
  isDemo: true,
  api: (...args) => state.client.api(...args),
}));
afterEach(cleanup);
it('clearly labels the simulation, hides nonfunctional URL copying and loads a seeded capture', async () => {
  state.client = createDemoApi();
  const user = userEvent.setup();
  render(<App />);
  expect(screen.getByRole('region', { name: 'Demo information' }).textContent).toContain(
    'No real webhooks',
  );
  await screen.findByRole('button', { name: /evt_demo_002/ });
  expect(screen.queryByRole('button', { name: 'Copy URL' })).toBeNull();
  await user.click(screen.getByRole('button', { name: /evt_demo_002/ }));
  await screen.findByLabelText('Receiver');
  expect(screen.getByRole('option', { name: /My local endpoint/ }).disabled).toBe(true);
  expect(screen.queryByText('Saved to PostgreSQL')).toBeNull();
});
