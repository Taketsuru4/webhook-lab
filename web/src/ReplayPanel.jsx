import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, RotateCcw } from 'lucide-react';
import { api, jsonPost } from './api.js';

const label = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  timeout: 'Timed out',
  interrupted: 'Interrupted',
};

function ReceiverOutcome({ body }) {
  let outcome;
  try {
    outcome = JSON.parse(body)?.outcome;
  } catch {
    /* Non-JSON responses remain available as text. */
  }
  const outcomes = {
    processed: 'One demo action processed',
    processed_without_key: 'Processed without duplicate protection: no usable event ID',
    duplicate: 'Duplicate skipped: original demo action retained',
    conflict: 'Event ID conflict: no new action',
    failed: 'Configured receiver failure: no action',
  };
  return Object.hasOwn(outcomes, outcome) ? (
    <p className="receiver-outcome">{outcomes[outcome]}</p>
  ) : null;
}

export default function ReplayPanel({ capture, labId }) {
  const [config, setConfig] = useState(null);
  const [history, setHistory] = useState(null);
  const [failFirst, setFailFirst] = useState(null);
  const [delayMs, setDelayMs] = useState(null);
  const [idempotency, setIdempotency] = useState(null);
  const [timeoutMs, setTimeoutMs] = useState(2000);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const actions = useRef(new Set());
  const base = `/api/labs/${labId}`;
  const runsPath = `${base}/requests/${capture.id}/replays`;

  useEffect(() => {
    const pending = actions.current;
    return () => {
      for (const controller of pending) controller.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function refresh() {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
        const [receiver, runs] = await Promise.all([
          api(`${base}/receiver`, { signal }),
          api(`${runsPath}?offset=${offset}`, { signal }),
        ]);
        if (controller.signal.aborted) return;
        setConfig(receiver);
        setHistory(runs);
        setError('');
        if (runs.runs.some((run) => run.state === 'running')) timer = setTimeout(refresh, 2500);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, runsPath, offset, revision]);

  async function perform(kind, path, options) {
    if (busy) return;
    const controller = new AbortController();
    actions.current.add(controller);
    setBusy(kind);
    setError('');
    try {
      const result = await api(path, {
        ...options,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      if (controller.signal.aborted) return;
      if (kind === 'save') setConfig(result);
      setOffset(0);
      setRevision((value) => value + 1);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          kind === 'replay'
            ? `${failure.message} Refresh history before replaying again; the receiver may have received the body.`
            : failure.message,
        );
    } finally {
      actions.current.delete(controller);
      if (!controller.signal.aborted) setBusy('');
    }
  }
  const dirty =
    config &&
    (Number(failFirst ?? config?.fail_first ?? 0) !== config.fail_first ||
      Number(delayMs ?? config?.delay_ms ?? 0) !== config.delay_ms ||
      (idempotency ?? config?.idempotency_enabled ?? false) !==
        (config.idempotency_enabled ?? false));

  return (
    <section className="replay-panel" aria-label="Replay experiment">
      <div className="replay-heading">
        <div>
          <span className="eyebrow">TRY THE DELIVERY</span>
          <h3>Replay to mock receiver</h3>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh replay history"
          disabled={Boolean(busy)}
          onClick={() => {
            setLoading(true);
            setRevision((value) => value + 1);
          }}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <p className="muted">Send the original body again. Every replay creates one saved attempt.</p>
      <details className="receiver-settings">
        <summary>Receiver behavior{config ? ` · ${config.received_count} received` : ''}</summary>
        <p className="muted">
          Configure the next experiment. Saving resets the receiver’s attempt counter.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            perform('save', `${base}/receiver`, {
              ...jsonPost({
                fail_first: Number(failFirst ?? config?.fail_first ?? 0),
                delay_ms: Number(delayMs ?? config?.delay_ms ?? 0),
                idempotency_enabled: idempotency ?? config?.idempotency_enabled ?? false,
              }),
              method: 'PUT',
            });
          }}
        >
          <div className="replay-fields">
            <label>
              Fail first N requests
              <input
                type="number"
                min="0"
                max="10"
                required
                value={failFirst ?? config?.fail_first ?? 0}
                onChange={(event) => setFailFirst(event.target.value)}
                disabled={Boolean(busy) || loading}
              />
            </label>
            <label>
              Response delay (ms)
              <input
                type="number"
                min="0"
                max="5000"
                required
                value={delayMs ?? config?.delay_ms ?? 0}
                onChange={(event) => setDelayMs(event.target.value)}
                disabled={Boolean(busy) || loading}
              />
            </label>
          </div>
          <label className="idempotency-toggle">
            <input
              type="checkbox"
              checked={idempotency ?? config?.idempotency_enabled ?? false}
              onChange={(event) => setIdempotency(event.target.checked)}
              disabled={Boolean(busy) || loading}
            />{' '}
            Protect against duplicate demo actions
          </label>
          <p className="muted">
            Uses a non-empty top-level event ID. Reusing it with different body bytes returns 409.
            Saving keeps existing protection records; Clear inbox resets the experiment.
          </p>
          <button
            className="button secondary compact"
            disabled={!config || loading || Boolean(busy)}
          >
            {busy === 'save' ? 'Saving…' : 'Save & reset receiver'}
          </button>
        </form>
        {config && (
          <p className="receiver-applied">
            Saved: first {config.fail_first} return 500, then 200 · {config.delay_ms} ms delay.
          </p>
        )}
      </details>
      {config && (
        <div className="receiver-outcomes" aria-label="Mock receiver demo totals">
          <div>
            <strong>{config.processed_count ?? 0}</strong>
            <span>Demo actions processed</span>
          </div>
          <div>
            <strong>{config.deduplicated_count ?? 0}</strong>
            <span>Duplicates skipped</span>
          </div>
          <div>
            <strong>{config.conflict_count ?? 0}</strong>
            <span>Key conflicts</span>
          </div>
          <p>Totals since inbox cleanup. No real payments are executed.</p>
        </div>
      )}
      <form
        className="replay-action"
        onSubmit={(event) => {
          event.preventDefault();
          perform('replay', runsPath, jsonPost({ timeout_ms: Number(timeoutMs) }));
        }}
      >
        <label>
          Timeout (ms)
          <input
            type="number"
            min="100"
            max="10000"
            required
            value={timeoutMs}
            onChange={(event) => setTimeoutMs(event.target.value)}
            disabled={Boolean(busy)}
          />
        </label>
        <button className="button primary" disabled={!config || loading || Boolean(busy) || dirty}>
          <RotateCcw size={15} />
          {busy === 'replay' ? 'Replaying…' : 'Replay original body'}
        </button>
      </form>
      {dirty && <p className="muted">Save receiver changes before replaying.</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="replay-history-heading">
        <h4>
          Attempt history <span>{history?.total ?? '—'}</span>
        </h4>
        <span>Manual · no automatic retries</span>
      </div>
      {loading ? (
        <p className="muted">Loading replay history…</p>
      ) : !history?.runs.length ? (
        <p className="replay-empty">
          No attempts yet. Try a successful delivery, then a failure or timeout.
        </p>
      ) : (
        <ol className="replay-history">
          {history.runs.map((run) => (
            <li key={run.id} className={`replay-result ${run.state}`}>
              <div className="replay-result-heading">
                <strong>{label[run.state]}</strong>
                <span>
                  {run.http_status ? `HTTP ${run.http_status}` : 'No completed response'}
                  {run.duration_ms != null ? ` · ${run.duration_ms} ms` : ''}
                </span>
              </div>
              <time dateTime={run.started_at}>{new Date(run.started_at).toLocaleString()}</time>
              <ReceiverOutcome body={run.response_body} />
              {run.error && <p>{run.error}</p>}
              {run.response_body && (
                <details>
                  <summary>
                    Receiver response{run.response_truncated ? ' (first 16 KiB)' : ''}
                  </summary>
                  <pre>{run.response_body}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
      {history?.total > 20 && (
        <div className="replay-pagination">
          <span>
            {offset + 1}–{offset + history.runs.length} of {history.total}
          </span>
          <button
            className="icon-button"
            aria-label="Previous attempts"
            disabled={offset === 0 || Boolean(busy)}
            onClick={() => {
              setLoading(true);
              setOffset((value) => Math.max(0, value - 20));
            }}
          >
            <ChevronLeft size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="Next attempts"
            disabled={offset + 20 >= history.total || Boolean(busy)}
            onClick={() => {
              setLoading(true);
              setOffset((value) => value + 20);
            }}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      )}
      <p className="replay-note">
        Body bytes are preserved. Only Content-Type is forwarded; captured credentials and provider
        signatures are excluded.
      </p>
    </section>
  );
}
