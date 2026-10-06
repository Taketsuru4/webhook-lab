import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  Database,
  Download,
  FileText,
  FlaskConical,
  Inbox,
  Layers,
  Plus,
  Radio,
  Search,
  Send,
  Terminal,
  Webhook,
  X,
} from 'lucide-react';
import { api, curlCommand, formatBytes, jsonPost, sampleEvent } from './api.js';
import { readInbox } from './polling.js';
import ReplayPanel from './ReplayPanel.jsx';

function IconButton({ label, children, ...props }) {
  return (
    <button className="icon-button" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

function CopyButton({ text, label = 'Copy', className = 'button secondary compact', onError }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      onError?.('Clipboard access is unavailable. Select and copy the text manually.');
    }
  }
  return (
    <button className={className} onClick={copy}>
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? 'Copied' : label}
    </button>
  );
}

function Modal({ title, description, children, onClose }) {
  const ref = useRef();
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) {
          const rect = ref.current.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-heading">
        <div>
          <span className="eyebrow">YOUR PLAYGROUND</span>
          <h2 id="modal-title">{title}</h2>
        </div>
        <IconButton label="Close dialog" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      <p className="muted">{description}</p>
      {children}
    </dialog>
  );
}

function ClearInboxModal({ lab, onClose, onCleared }) {
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api(`/api/labs/${lab.id}/requests`, {
        ...jsonPost({ confirm: confirmation }),
        method: 'DELETE',
      });
      onCleared(result.cleared);
      onClose();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Clear this inbox?"
      description={`Delete all captures, replay history and mock receipts in “${lab.name}”. The lab endpoint and receiver settings stay available. This cannot be undone.`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <label className="field-label">
          Type the lab name to confirm
          <input
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <p className="muted">{lab.name}</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button danger" disabled={busy || confirmation !== lab.name}>
            {busy ? 'Clearing…' : 'Delete captures & history'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SendModal({ lab, onClose, onSent }) {
  const [body, setBody] = useState(() => JSON.stringify(sampleEvent(), null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setError('');
    try {
      JSON.parse(body);
    } catch {
      setError('The sample body must be valid JSON. You can capture any other format using curl.');
      return;
    }
    setBusy(true);
    try {
      const result = await api(`/hooks/${lab.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-lab-source': 'sample-sender' },
        body,
      });
      onSent(result.request_id);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Send a sample event"
      description={`Make a real HTTP request to ${lab.name}. Edit the JSON to try your own event.`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="sample-body">
          Request body <span>application/json</span>
        </label>
        <textarea
          id="sample-body"
          className="json-editor"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={14}
          spellCheck={false}
          autoFocus
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            <Send size={16} />
            {busy ? 'Sending…' : 'Send event'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewLabModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onCreated(await api('/api/labs', jsonPost({ name: name.trim() })));
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Create a new lab"
      description="Give each integration its own endpoint and event inbox."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="lab-name">
          Lab name
        </label>
        <input
          id="lab-name"
          className="text-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. GitHub integration"
          maxLength={60}
          required
          autoFocus
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            <Plus size={16} />
            {busy ? 'Creating…' : 'Create lab'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Code({ text }) {
  const truncated = text.length > 24000;
  const lines = text.slice(0, 24000).split('\n');
  return (
    <div className="code-content" tabIndex={0} aria-label="Scrollable request code">
      <pre>
        {lines.map((line, index) => (
          <div className="code-line" key={index}>
            <span className="line-number" aria-hidden="true">
              {index + 1}
            </span>
            <code>
              {line
                .split(
                  /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b)/g,
                )
                .map((token, i) => (
                  <span
                    key={i}
                    className={
                      token.startsWith('"')
                        ? token.endsWith(':')
                          ? 'token-key'
                          : 'token-string'
                        : /^(true|false|null|-?\d)/.test(token)
                          ? 'token-value'
                          : undefined
                    }
                  >
                    {token}
                  </span>
                ))}
            </code>
          </div>
        ))}
      </pre>
      {truncated && (
        <p className="code-note">Preview limited to 24 KB. Copy or download the full request.</p>
      )}
    </div>
  );
}

function Inspector({ capture, labId, selectedId, loading, error, onSelect, onRetry, onError }) {
  const [tab, setTab] = useState('payload');
  function download() {
    const bytes = Uint8Array.from(atob(capture.raw_body_base64), (character) =>
      character.charCodeAt(0),
    );
    const url = URL.createObjectURL(new Blob([bytes], { type: capture.content_type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${capture.id}.${capture.is_json ? 'json' : 'bin'}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const text = capture
    ? tab === 'headers'
      ? JSON.stringify(capture.headers, null, 2)
      : tab === 'raw'
        ? capture.raw_body
        : capture.is_json
          ? JSON.stringify(capture.payload, null, 2)
          : capture.raw_body
    : '';
  return (
    <section className="inspector" aria-label="Request inspector">
      <div className="panel-heading">
        <div className="heading-with-icon">
          <Braces size={17} />
          <h2>Request inspector</h2>
        </div>
        {selectedId && (
          <IconButton label="Close request inspector" onClick={() => onSelect(null)}>
            <X size={16} />
          </IconButton>
        )}
      </div>
      {!selectedId ? (
        <div className="inspector-empty">
          <div className="empty-orbit">
            <Braces size={27} />
          </div>
          <h3>Every detail, in one place.</h3>
          <p>
            Select an event to inspect its payload,
            <br />
            headers, and original request body.
          </p>
          <span className="keyboard-hint">
            <ArrowDownLeft size={13} /> Choose a request from the inbox
          </span>
        </div>
      ) : loading ? (
        <div className="inspector-empty">
          <span className="loading-dot" />
          <p>Loading request…</p>
        </div>
      ) : capture ? (
        <>
          <div className="request-summary">
            <span className="method-pill">POST</span>
            <span className="request-event-type">{capture.event_type}</span>
            <span className="accepted">
              <Check size={12} />
              202
            </span>
          </div>
          <div className="inspector-tabs" role="tablist" aria-label="Request content">
            {['payload', 'headers', 'raw'].map((item) => (
              <button
                key={item}
                role="tab"
                aria-selected={tab === item}
                aria-controls="request-content"
                id={`tab-${item}`}
                className={tab === item ? 'active' : ''}
                onClick={() => setTab(item)}
              >
                {item === 'raw' ? 'Raw body' : item === 'headers' ? 'Headers' : 'Payload'}
                {item === 'headers' && <span>{Object.keys(capture.headers).length}</span>}
              </button>
            ))}
          </div>
          <div className="code-toolbar">
            <span>
              {tab === 'headers'
                ? 'REQUEST HEADERS'
                : capture.is_json && tab === 'payload'
                  ? 'JSON'
                  : 'RAW TEXT'}
            </span>
            <CopyButton text={text} label="Copy" className="code-copy" onError={onError} />
          </div>
          <div role="tabpanel" id="request-content" aria-labelledby={`tab-${tab}`} tabIndex={0}>
            <Code text={text} />
          </div>
          <div className="request-meta">
            <div>
              <span>Captured at</span>
              <strong>{new Date(capture.received_at).toLocaleString()}</strong>
            </div>
            <div>
              <span>Body size</span>
              <strong>{formatBytes(capture.size_bytes)}</strong>
            </div>
            <div>
              <span>Request ID</span>
              <strong className="mono break-anywhere">{capture.id}</strong>
            </div>
            <div>
              <span>Provider event ID</span>
              <strong className="mono break-anywhere">{capture.event_id || 'Not provided'}</strong>
            </div>
          </div>
          <div className="inspector-footer">
            <span>
              <Database size={13} /> Saved to PostgreSQL
            </span>
            <button className="button secondary compact" onClick={download}>
              <Download size={14} />
              Download body
            </button>
          </div>
          <ReplayPanel key={capture.id} capture={capture} labId={labId} />
        </>
      ) : (
        <div className="inspector-empty">
          <p>{error || 'Could not load this request.'}</p>
          <button className="button secondary" onClick={onRetry}>
            Retry request
          </button>
          <button className="button secondary" onClick={() => onSelect(null)}>
            Close inspector
          </button>
        </div>
      )}
    </section>
  );
}

function Traffic({ counts = [] }) {
  const peak = Math.max(1, ...counts.map((item) => item.count));
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  return (
    <section className="traffic" aria-label="Incoming requests during the last hour">
      <div className="traffic-description">
        <span className="eyebrow">INCOMING TRAFFIC</span>
        <strong>
          {total} <span>requests in the last hour</span>
        </strong>
      </div>
      <div className="traffic-chart">
        <div
          className="traffic-bars"
          role="img"
          aria-label={`Requests in twelve five-minute intervals: ${counts.map((item) => item.count).join(', ') || 'No data'}`}
        >
          {Array.from({ length: 12 }, (_, i) => (
            <div
              className="traffic-bar-track"
              key={i}
              title={`${60 - i * 5}–${55 - i * 5} minutes ago: ${counts[i]?.count || 0} requests`}
            >
              <div
                className="traffic-bar"
                style={{ height: `${Math.max(3, ((counts[i]?.count || 0) / peak) * 100)}%` }}
              />
            </div>
          ))}
        </div>
        <div className="chart-labels">
          <span>60 min ago</span>
          <span>30 min ago</span>
          <span>Now</span>
        </div>
      </div>
    </section>
  );
}

function Guide({ lab, onError, onSend }) {
  return (
    <div className="guide-grid">
      <section className="guide-card">
        <span className="step-number">01</span>
        <h2>Send your first webhook</h2>
        <p>
          Use your terminal to POST a request to this lab’s endpoint. The inbox updates
          automatically.
        </p>
        <div className="guide-code">
          <pre>
            {curlCommand(
              lab.endpoint,
              '{"id":"evt_001","type":"payment.succeeded","data":{"amount":4900,"currency":"eur"}}',
            )}
          </pre>
          <CopyButton
            text={curlCommand(
              lab.endpoint,
              '{"id":"evt_001","type":"payment.succeeded","data":{"amount":4900,"currency":"eur"}}',
            )}
            onError={onError}
          />
        </div>
        <button className="button secondary" onClick={onSend}>
          <Send size={16} />
          Or use the sample sender
        </button>
      </section>
      <section className="guide-card">
        <span className="step-number">02</span>
        <h2>Inspect what actually arrived</h2>
        <p>
          Each HTTP request gets its own capture ID. Select a request to explore the JSON payload,
          redacted headers, and raw body.
        </p>
        <div className="guide-note">
          <Layers size={20} />
          <div>
            <strong>Duplicates are part of the experiment.</strong>
            <p>
              Send the same event ID twice. Both requests are stored, and the inbox marks repeated
              IDs.
            </p>
          </div>
        </div>
        <p>
          Malformed JSON and non-JSON bodies are captured too. Body downloads preserve the original
          bytes. Select a capture and use Replay original body. Open Receiver behavior to fail the
          first request, then replay twice to compare HTTP 500 and 200. Set a response delay above
          the replay timeout to explore uncertain delivery.
        </p>
      </section>
      <section className="guide-card wide">
        <span className="eyebrow">BUILDING IN THE OPEN</span>
        <h2>A small lab. Real engineering decisions.</h2>
        <div className="roadmap">
          <div>
            <span className="roadmap-dot done" />
            <strong>Capture & inspect</strong>
            <span>Available now</span>
          </div>
          <div>
            <span className="roadmap-dot done" />
            <strong>Manual replay</strong>
            <span>Available now</span>
          </div>
          <div>
            <span className="roadmap-dot done" />
            <strong>Mock failures & timeouts</strong>
            <span>Available now</span>
          </div>
          <div>
            <span className="roadmap-dot done" />
            <strong>Idempotency demo</strong>
            <span>Available now</span>
          </div>
        </div>
        <p className="muted">
          This version runs as a local, single-user tool. The management API has no authentication;
          keep it on localhost.
        </p>
      </section>
    </div>
  );
}

export default function App() {
  const [labs, setLabs] = useState([]);
  const [labId, setLabId] = useState(null);
  const [database, setDatabase] = useState('');
  const [view, setView] = useState('inbox');
  const [modal, setModal] = useState(null);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState('all');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [capture, setCapture] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailRevision, setDetailRevision] = useState(0);
  const [live, setLive] = useState(true);
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const lab = labs.find((item) => item.id === labId);
  const displayedError = detailError || error || connectionError;

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function loadLabs() {
      try {
        const result = await api('/api/labs', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setLabs(result.labs);
        setLabId(result.labs[0]?.id || null);
        setDatabase(result.database);
        setConnectionError('');
      } catch (err) {
        if (controller.signal.aborted) return;
        setConnectionError(err.message);
        timer = setTimeout(loadLabs, 2500);
      }
    }
    loadLabs();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!labId) return;
    const controller = new AbortController();
    let timer;
    async function refresh() {
      try {
        const params = new URLSearchParams({ q: deferredQuery, filter, offset });
        const [requests, metrics] = await readInbox(labId, params, controller.signal);
        if (controller.signal.aborted) return;
        setData(requests);
        setStats(metrics);
        setConnected(true);
        setConnectionError('');
      } catch (err) {
        if (controller.signal.aborted) return;
        setConnected(false);
        setConnectionError(err.message);
      } finally {
        if (live && !controller.signal.aborted) timer = setTimeout(refresh, 2500);
      }
    }
    refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [labId, deferredQuery, filter, offset, live, revision]);

  useEffect(() => {
    if (!selectedId || !labId) return;
    const controller = new AbortController();
    api(`/api/labs/${labId}/requests/${selectedId}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setCapture(result);
        setDetailLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted || err.name === 'AbortError') return;
        setDetailError(err.message);
        setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId, labId, detailRevision]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const selectRequest = useCallback(
    (id) => {
      if (id === selectedId) return;
      setCapture(null);
      setDetailError('');
      setSelectedId(id);
      setDetailLoading(Boolean(id));
    },
    [selectedId],
  );

  function retryCapture() {
    if (!selectedId || !labId || detailLoading) return;
    setCapture(null);
    setDetailError('');
    setDetailLoading(true);
    setDetailRevision((value) => value + 1);
  }

  function chooseLab(id) {
    if (id === labId) return;
    setLabId(id);
    setQuery('');
    setFilter('all');
    setOffset(0);
    setData(null);
    setStats(null);
    setError('');
    selectRequest(null);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Webhook Lab home">
          <span className="brand-mark">
            <Webhook size={23} />
          </span>
          <span>
            webhook<span className="brand-light">lab</span>
            <span className="brand-period">.</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">W</span>
          <div>
            <strong>My workspace</strong>
            <span>Local development</span>
          </div>
          <ChevronDown size={14} />
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="Main navigation">
          <button
            className={`nav-item ${view === 'inbox' ? 'active' : ''}`}
            onClick={() => setView('inbox')}
          >
            <Inbox size={18} />
            Event inbox<span className="nav-count">{stats?.total || 0}</span>
          </button>
          <button
            className={`nav-item ${view === 'guide' ? 'active' : ''}`}
            onClick={() => setView('guide')}
          >
            <FileText size={18} />
            Quick start
            <ArrowRight size={14} />
          </button>
        </nav>
        <div className="labs-label">
          <span className="nav-label">YOUR LABS</span>
          <IconButton label="Create a new lab" onClick={() => setModal('new')}>
            <Plus size={15} />
          </IconButton>
        </div>
        <nav aria-label="Labs">
          {labs.map((item) => (
            <button
              key={item.id}
              className={`lab-nav ${item.id === labId ? 'selected' : ''}`}
              onClick={() => chooseLab(item.id)}
            >
              <span className="lab-dot" />
              <span>{item.name}</span>
            </button>
          ))}
        </nav>
        <button className="add-lab" onClick={() => setModal('new')}>
          <Plus size={14} />
          New lab
        </button>
        <div className="sidebar-bottom">
          <div className="next-card">
            <FlaskConical size={20} />
            <span className="eyebrow">YOUR NEXT EXPERIMENT</span>
            <strong>Test the unexpected.</strong>
            <p>Replay a request. Make the receiver fail. See exactly what happened.</p>
            <button onClick={() => setView('guide')}>
              See the roadmap
              <ArrowRight size={13} />
            </button>
          </div>
          <div className="local-indicator">
            <span className={`status-dot ${connected ? '' : 'offline'}`} />
            <span>
              {database === 'embedded'
                ? 'Embedded PostgreSQL'
                : database === 'postgres'
                  ? 'PostgreSQL connected'
                  : 'Connecting…'}
            </span>
            <span className="version">v0.1</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{lab?.name || 'Loading your lab…'}</strong>
          </div>
          <div className="topbar-right">
            <button
              className="icon-button mobile-new-lab"
              aria-label="Create a new lab"
              onClick={() => setModal('new')}
            >
              <Plus size={18} />
            </button>
            <span className="environment-pill">
              <Terminal size={12} />
              Local
            </span>
            <button
              className="help-link"
              onClick={() => setView('guide')}
              aria-label="Open quick start"
            >
              <CircleHelp size={18} />
            </button>
            <span className="avatar">W</span>
          </div>
        </header>
        <div className="page-content">
          <div className="page-title">
            <div>
              <div className="title-eyebrow">
                <span className="tiny-logo">
                  <ArrowDownLeft size={13} />
                </span>
                CAPTURE. INSPECT. UNDERSTAND.
              </div>
              <h1>{view === 'inbox' ? 'Your webhooks, in focus.' : 'A good place to start.'}</h1>
              <p>
                {view === 'inbox'
                  ? 'One inbox for every request. See exactly what came through.'
                  : 'From your first request to your next integration.'}
              </p>
            </div>
            <button className="button primary" onClick={() => setModal('send')} disabled={!lab}>
              <Plus size={17} />
              Send sample event
            </button>
          </div>
          {displayedError && (
            <div className="error-banner" role="alert">
              <span>{displayedError}</span>
              <button
                className="button secondary compact"
                onClick={() => {
                  if (detailError) {
                    retryCapture();
                    return;
                  }
                  setError('');
                  setConnectionError('');
                  setRevision((value) => value + 1);
                  if (!lab) window.location.reload();
                }}
              >
                Retry
              </button>
              <IconButton
                label="Dismiss error"
                onClick={() => {
                  setDetailError('');
                  setError('');
                  setConnectionError('');
                }}
              >
                <X size={16} />
              </IconButton>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              <Check size={16} />
              {notice}
            </div>
          )}
          {lab && (
            <section className="endpoint-card" aria-label="Webhook endpoint">
              <div className="endpoint-icon">
                <Webhook size={22} />
              </div>
              <div className="endpoint-main">
                <span className="eyebrow">YOUR CAPTURE ENDPOINT</span>
                <div className="endpoint-url">
                  <span className="method-pill">POST</span>
                  <code>{lab.endpoint}</code>
                </div>
              </div>
              <div className="endpoint-actions">
                <CopyButton text={lab.endpoint} label="Copy URL" onError={setError} />
                <CopyButton
                  text={curlCommand(lab.endpoint)}
                  label="Copy curl"
                  className="button subtle compact"
                  onError={setError}
                />
              </div>
            </section>
          )}
          {view === 'guide' && lab ? (
            <Guide lab={lab} onError={setError} onSend={() => setModal('send')} />
          ) : (
            <>
              <div className="stats-grid">
                {[
                  {
                    label: 'Captured requests',
                    value: stats?.total,
                    icon: Inbox,
                    note: 'Every incoming HTTP request',
                  },
                  {
                    label: 'Unique events',
                    value: stats ? stats.total - stats.duplicates : undefined,
                    icon: Braces,
                    note: 'Distinct IDs + requests without IDs',
                  },
                  {
                    label: 'Repeated deliveries',
                    value: stats?.duplicates,
                    icon: Layers,
                    note: 'Extra requests with the same event ID',
                  },
                  {
                    label: 'Data captured',
                    value: stats ? formatBytes(stats.bytes) : undefined,
                    icon: Database,
                    note: 'Original request bodies',
                  },
                ].map(({ label, value, icon: Icon, note }, i) => (
                  <section className={`stat-card stat-${i}`} key={label}>
                    <div>
                      <span>{label}</span>
                      <Icon size={17} />
                    </div>
                    <strong>{value ?? '—'}</strong>
                    <p>{note}</p>
                  </section>
                ))}
              </div>
              <Traffic counts={stats?.traffic} />
              <div className="inbox-layout">
                <section className="inbox-panel" aria-label="Captured requests">
                  <div className="panel-heading">
                    <div className="heading-with-icon">
                      <Radio size={17} />
                      <h2>Event inbox</h2>
                      <span className="count-pill">{data?.total || 0}</span>
                    </div>
                    <button
                      className={`live-toggle ${live && connected ? 'is-live' : ''}`}
                      onClick={() => setLive((value) => !value)}
                      aria-pressed={live}
                    >
                      <span className="status-dot" />
                      {!connected ? 'Offline' : live ? 'Live' : 'Paused'}
                    </button>
                  </div>
                  <div className="inbox-tools-actions">
                    <button
                      className="button secondary compact"
                      disabled={!stats?.total}
                      onClick={() => setModal('clear')}
                    >
                      Clear inbox
                    </button>
                  </div>
                  <div className="inbox-toolbar">
                    <div className="search-input">
                      <Search size={15} />
                      <input
                        type="search"
                        placeholder="Search event type or ID…"
                        aria-label="Search event type or ID"
                        value={query}
                        onChange={(event) => {
                          setQuery(event.target.value);
                          setOffset(0);
                        }}
                      />
                    </div>
                    <select
                      className="filter-select"
                      aria-label="Filter requests"
                      value={filter}
                      onChange={(event) => {
                        setFilter(event.target.value);
                        setOffset(0);
                      }}
                    >
                      <option value="all">All requests</option>
                      <option value="duplicates">Repeated IDs</option>
                      <option value="untyped">Untyped</option>
                    </select>
                  </div>
                  <div className="list-column-labels">
                    <span>EVENT / REQUEST</span>
                    <span>RECEIVED</span>
                  </div>
                  {!data ? (
                    <div className="inbox-empty">
                      <span className="loading-dot" />
                      <h3>Connecting to your inbox…</h3>
                    </div>
                  ) : data.requests.length === 0 ? (
                    <div className="inbox-empty">
                      <div className="empty-orbit">
                        <Inbox size={28} />
                      </div>
                      <h3>
                        {query || filter !== 'all'
                          ? 'No matching requests.'
                          : 'Ready for your first webhook.'}
                      </h3>
                      <p>
                        {query || filter !== 'all'
                          ? 'Try another search or switch to all requests.'
                          : 'Send a sample event or POST to your endpoint.\nYour requests will appear right here.'}
                      </p>
                      {query || filter !== 'all' ? (
                        <button
                          className="button secondary"
                          onClick={() => {
                            setQuery('');
                            setFilter('all');
                            setOffset(0);
                          }}
                        >
                          Clear filters
                        </button>
                      ) : (
                        <button
                          className="button secondary"
                          onClick={() => setModal('send')}
                          disabled={!lab}
                        >
                          <Send size={15} />
                          Send your first event
                          <ArrowRight size={14} />
                        </button>
                      )}
                    </div>
                  ) : (
                    <ul className="event-list">
                      {data.requests.map((item) => (
                        <li key={item.id}>
                          <button
                            className={`event-row ${selectedId === item.id ? 'selected' : ''}`}
                            aria-pressed={selectedId === item.id}
                            onClick={() => selectRequest(item.id)}
                          >
                            <span className="event-icon">
                              <ArrowDownLeft size={17} />
                            </span>
                            <span className="event-row-main">
                              <span className="event-type">
                                {item.event_type}
                                {item.occurrences > 1 && (
                                  <span className="duplicate-badge">
                                    Repeated ×{item.occurrences}
                                  </span>
                                )}
                              </span>
                              <span className="event-id">
                                {item.event_id || item.id}
                                <span className="event-size">{formatBytes(item.size_bytes)}</span>
                              </span>
                            </span>
                            <span className="event-row-time">
                              <time
                                dateTime={item.received_at}
                                title={new Date(item.received_at).toLocaleString()}
                              >
                                {new Date(item.received_at).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                  hour12: false,
                                })}
                              </time>
                              <span className="accepted">
                                <Check size={10} />
                                Captured
                              </span>
                            </span>
                            <ChevronRight size={13} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="inbox-footer">
                    <span>
                      {data?.total
                        ? `${offset + 1}–${offset + data.requests.length} of ${data.total} requests`
                        : 'Requests are stored automatically'}
                      {live && <span className="refresh-note"> · refreshes every 2.5s</span>}
                    </span>
                    <div className="pagination">
                      <IconButton
                        label="Previous page"
                        disabled={offset === 0}
                        onClick={() => setOffset((value) => Math.max(0, value - 50))}
                      >
                        <ChevronLeft size={15} />
                      </IconButton>
                      <IconButton
                        label="Next page"
                        disabled={!data || offset + 50 >= data.total}
                        onClick={() => setOffset((value) => value + 50)}
                      >
                        <ChevronRight size={15} />
                      </IconButton>
                    </div>
                  </div>
                </section>
                <Inspector
                  capture={capture}
                  labId={labId}
                  selectedId={selectedId}
                  loading={detailLoading}
                  error={detailError}
                  onSelect={selectRequest}
                  onRetry={retryCapture}
                  onError={setError}
                />
              </div>
            </>
          )}
          <footer className="page-footer">
            <span>
              <Activity size={13} />
              Built for the moments between “sent” and “received”.
            </span>
            <span>
              Webhook Lab<span className="footer-separator">/</span>Local MVP
            </span>
          </footer>
        </div>
      </main>
      {modal === 'send' && lab && (
        <SendModal
          lab={lab}
          onClose={() => setModal(null)}
          onSent={(id) => {
            setQuery('');
            setFilter('all');
            setOffset(0);
            setView('inbox');
            setRevision((value) => value + 1);
            selectRequest(id);
            setNotice('Event captured. Your request is saved and ready to inspect.');
          }}
        />
      )}
      {modal === 'clear' && lab && (
        <ClearInboxModal
          lab={lab}
          onClose={() => setModal(null)}
          onCleared={(count) => {
            selectRequest(null);
            setData(null);
            setStats(null);
            setOffset(0);
            setQuery('');
            setFilter('all');
            setRevision((value) => value + 1);
            setNotice(`Cleared ${count} captures and their replay history from “${lab.name}”.`);
          }}
        />
      )}
      {modal === 'new' && (
        <NewLabModal
          onClose={() => setModal(null)}
          onCreated={(created) => {
            setLabs((items) => [...items, created]);
            chooseLab(created.id);
            setView('inbox');
            setNotice(`“${created.name}” is ready. Copy the endpoint to start capturing.`);
          }}
        />
      )}
    </div>
  );
}
