import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Repeat2 } from 'lucide-react';
import { api, jsonPost } from './api.js';

const active = (job) => ['queued', 'running', 'waiting_retry'].includes(job.state);
const labels = {
  queued: 'Queued',
  running: 'Delivering',
  waiting_retry: 'Waiting to retry',
  succeeded: 'Delivered',
  failed: 'Stopped after failure',
  cancelled: 'Cancelled',
};

export default function JobPanel({
  labId,
  captureId,
  timeoutMs,
  disabled,
  onActiveChange,
  onChange,
}) {
  const [data, setData] = useState(null);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [retryDelay, setRetryDelay] = useState(500);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signature = useRef('');
  const actions = useRef(new Set());
  const path = `/api/labs/${labId}/requests/${captureId}/jobs`;
  const pending = Boolean(data?.active_job) || data?.jobs.some(active);

  useEffect(() => {
    const controllers = actions.current;
    return () => {
      for (const controller of controllers) controller.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function refresh() {
      try {
        const result = await api(`${path}?offset=${offset}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        if (controller.signal.aborted) return;
        setData(result);
        setError('');
        onActiveChange(Boolean(result.active_job) || result.jobs.some(active));
        const nextSignature = JSON.stringify(
          result.jobs.map((job) => [job.id, job.state, job.attempt_count, job.cancel_requested]),
        );
        if (signature.current && signature.current !== nextSignature) onChange();
        signature.current = nextSignature;
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 2500);
      }
    }
    refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, offset, revision, onActiveChange, onChange]);

  async function submit(url, body) {
    if (busy) return;
    const controller = new AbortController();
    actions.current.add(controller);
    setBusy(true);
    setError('');
    try {
      await api(url, {
        ...jsonPost(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (controller.signal.aborted) return;
      if (url === path) onActiveChange(true);
      setOffset(0);
      setRevision((value) => value + 1);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(`${failure.message} Refresh jobs to confirm their current state.`);
    } finally {
      actions.current.delete(controller);
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <section className="job-panel" aria-label="Automatic delivery">
      <div className="replay-heading">
        <h3>Deliver with retries</h3>
        <button
          className="icon-button"
          aria-label="Refresh delivery jobs"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <p className="muted">
        A saved job runs in the background and survives a server restart. Transient failures retry;
        conflicts stop.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(path, {
            max_attempts: Number(maxAttempts),
            retry_delay_ms: Number(retryDelay),
            timeout_ms: Number(timeoutMs),
          });
        }}
      >
        <div className="replay-fields">
          <label>
            Maximum attempts
            <input
              type="number"
              min="1"
              max="5"
              required
              value={maxAttempts}
              onChange={(event) => setMaxAttempts(event.target.value)}
              disabled={disabled || busy || pending}
            />
          </label>
          <label>
            First retry delay (ms)
            <input
              type="number"
              min="250"
              max="5000"
              required
              value={retryDelay}
              onChange={(event) => setRetryDelay(event.target.value)}
              disabled={disabled || busy || pending}
            />
          </label>
        </div>
        <button className="button secondary" disabled={disabled || busy || pending || !data}>
          <Repeat2 size={15} />
          {busy ? 'Saving…' : 'Queue delivery'}
        </button>
      </form>
      <p className="replay-note">
        Uses the timeout above. Retry delay doubles up to 5 seconds. A timeout can follow receiver
        processing; enable duplicate protection when comparing safe retries.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {data?.active_job && data.active_job.capture_id !== captureId && (
        <p className="muted">
          This lab has an active job for another capture. View that capture to stop retries.
        </p>
      )}
      {!data ? (
        <p className="muted">Loading delivery jobs…</p>
      ) : !data.jobs.length ? (
        <p className="muted">No queued deliveries yet.</p>
      ) : (
        <ol className="replay-history">
          {data.jobs.map((job) => (
            <li key={job.id} className={`replay-result ${job.state}`}>
              <div className="replay-result-heading">
                <strong>{labels[job.state]}</strong>
                <span>
                  {job.attempt_count}/{job.max_attempts} attempts
                </span>
              </div>
              <time dateTime={job.created_at}>{new Date(job.created_at).toLocaleString()}</time>
              {job.state === 'waiting_retry' && (
                <p>Next attempt after {new Date(job.next_attempt_at).toLocaleTimeString()}</p>
              )}
              {job.last_error && <p>{job.last_error}</p>}
              {job.cancel_requested && job.state === 'running' && (
                <p>Stopping after the current attempt. Sending cannot be undone.</p>
              )}
              {active(job) && (
                <button
                  className="button secondary compact"
                  disabled={busy || job.cancel_requested}
                  onClick={() => submit(`${path}/${job.id}/cancel`, {})}
                >
                  Stop retries
                </button>
              )}
              {!!job.attempts.length && (
                <details open={active(job)}>
                  <summary>Attempt results</summary>
                  <ol className="job-attempts">
                    {job.attempts.map((attempt) => (
                      <li key={attempt.id}>
                        <strong>
                          #{attempt.attempt_number} · {attempt.state}
                        </strong>
                        <span>
                          {attempt.http_status
                            ? `HTTP ${attempt.http_status}`
                            : 'No completed response'}
                          {attempt.duration_ms != null ? ` · ${attempt.duration_ms} ms` : ''}
                        </span>
                        {attempt.error && <p>{attempt.error}</p>}
                        {attempt.response_body && (
                          <details>
                            <summary>Receiver response</summary>
                            <pre>{attempt.response_body}</pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
      {data?.total > 10 && (
        <div className="replay-pagination">
          <span>
            {offset + 1}–{offset + data.jobs.length} of {data.total} jobs
          </span>
          <button
            className="icon-button"
            aria-label="Previous delivery jobs"
            disabled={offset === 0 || busy}
            onClick={() => setOffset((value) => Math.max(0, value - 10))}
          >
            <ChevronLeft size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="Next delivery jobs"
            disabled={offset + 10 >= data.total || busy}
            onClick={() => setOffset((value) => value + 10)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </section>
  );
}
