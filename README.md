# Webhook Lab

**Capture, inspect, and replay your webhooks.**

[![Verify](https://github.com/Taketsuru4/webhook-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/Taketsuru4/webhook-lab/actions/workflows/ci.yml)

A local developer tool that gives each integration its own HTTP endpoint and event inbox. Inspect the exact body, browse headers, and spot repeated event IDs without losing any incoming requests.

Built entirely in **JavaScript** with React, Vite, Fastify, and PostgreSQL.

**Status:** local MVP — capture, inspection, manual replay, persistent retry jobs, and receiver idempotency experiments. A built-in worker uses the existing database; Redis/BullMQ is an optional future scaling step.

![Webhook Lab dashboard inspecting a captured payment event](docs/preview.png)

## Try it in two minutes

Requires Node.js **22.12+** (Node.js 24 LTS recommended).

```sh
git clone https://github.com/Taketsuru4/webhook-lab.git
cd webhook-lab
npm install
npm run dev
```

Open **http://localhost:5173**, then click **Send sample event**. This sends a real HTTP request to the capture API. Select it in the inbox to inspect the JSON, headers, and original text. Send the same event ID again to see repeated deliveries.

No Docker or database installation is needed for this mode. [PGlite](https://pglite.dev/docs/) runs an embedded PostgreSQL database, persisted to `.data/postgres/`. It is a single-process local development mode; it is not a separately running PostgreSQL server. It uses the same schema and SQL as the external PostgreSQL adapter.

You can also send requests from your terminal:

```sh
curl -X POST http://localhost:4310/hooks/local-playground \
  -H 'Content-Type: application/json' \
  --data-binary '{"id":"evt_001","type":"payment.succeeded","data":{"amount":4900,"currency":"eur"}}'
```

The API returns `202` only after the request has been stored. `202` means **captured**. Replaying is a separate, explicit action; it does not execute payments or other business operations.

## What works today

- Create named labs with isolated endpoints and inboxes.
- Capture arbitrary HTTP POST bodies, including malformed JSON, plain text, binary, and empty bodies.
- Preserve original bytes as base64; download the original body from the inspector.
- Browse pretty-printed JSON, redacted headers, and raw UTF-8 text previews.
- Search event type, provider event ID, or capture ID; filter repeated IDs and untyped requests.
- Paginate 50 requests at a time.
- Refresh the inbox every 2.5 seconds, with a pause control.
- See actual request totals, duplicate counts, stored body sizes, and an hourly traffic histogram.
- Replay original bodies over real HTTP to the built-in mock receiver.
- Configure the first 0–10 receiver requests to return 500, then 200; add 0–5000 ms response delay.
- Set replay timeouts (100–10000 ms) and inspect persisted status, duration, errors and response bodies.
- Queue background deliveries with 1–5 attempts, capped exponential retry delay, persisted attempt results and cancellation.
- Browse attempt history, including uncertain timeouts and interrupted runs.
- Enable a transactional receiver-side idempotency demo and compare HTTP deliveries with demo actions processed.
- Clear one lab’s captures, replay history and mock receipts after typing its name.
- Copy endpoint URLs and safely quoted curl commands.
- Use the responsive dashboard with keyboard navigation and reduced-motion support.

Nothing is seeded into the inbox. The sample sender creates real, synthetic requests when you click it.

## Try a replay experiment

1. Send a sample and select its capture. Click **Replay original body**: the mock receiver returns 200.
2. Open **Receiver behavior**. Set **Fail first N requests** to 1 and click **Save & reset receiver**.
3. Replay twice. The history shows a failed HTTP 500 attempt followed by a successful HTTP 200 attempt.
4. Save a response delay of 3000 ms and use the default 2000 ms timeout. The attempt times out even though the mock receiver may already have stored the body.
5. Refresh the page and reselect the capture: history and receiver settings remain available. **Clear inbox** deletes only the selected lab’s experiments and resets its receiver counter, preserving its endpoint and saved scenario.

Each click creates one new attempt. A timeout does not prove that the receiver did nothing. Replays forward the original body and Content-Type only; captured credentials and provider signature headers are excluded.

## Try automatic retries

Configure **Fail first N requests = 2**, save, then click **Queue delivery** with the default three attempts. The worker records 500, 500, then 200 and marks the job delivered. Jobs remain stored if you refresh the browser or restart the API. Receiver settings and manual replay are blocked while the lab has an active job so that the experiment stays consistent.

The first retry delay is configurable from 250–5000 ms; it doubles after each failed attempt and caps at 5000 ms. Timeouts, network failures, HTTP 408/429 and 5xx responses can retry. Other client errors, including 409 conflicts, stop immediately. **Maximum attempts** includes the initial send.

**Stop retries** cancels queued/waiting work. During an in-flight send, it stops future attempts after the current one is recorded; it cannot undo receiver processing. The default local worker scans the database every 250 ms and executes one queued attempt at a time across labs. Manual attempts and background jobs have separate histories.

A run interrupted by process loss is uncertain. Once its 15-second lease expires, the worker records `interrupted` and may send another attempt within the chosen budget. Use receiver duplicate protection to compare a safe retry with repeated demo processing. This is at-least-once delivery, not exactly-once processing. HTTP 202 on the jobs API means the job was persisted, not already delivered.

## Compare duplicate delivery with duplicate processing

Open **Receiver behavior**, enable **Protect against duplicate demo actions**, and save. Use a JSON capture with a non-empty top-level `id`, then replay it twice: both replies are HTTP 200, while the receiver processes one demo action and skips the duplicate. The response and dashboard explain the distinction.

- The first successful guarded request binds its full event ID to the original body bytes, scoped to the lab.
- The same ID and same bytes acknowledge the existing demo action without repeating it.
- The same ID with different bytes returns 409 without processing a new action; even JSON whitespace changes count as different bytes.
- Configured 500 responses do not reserve the key. A timeout may happen after the receiver committed the demo action; retrying that body then skips the duplicate.
- Missing, empty or unsupported IDs process individually with a visible explanation. Untyped JSON with a valid `id` can still be protected.
- Protection records survive server restart and saving receiver settings. **Clear inbox** deletes them and resets the experiment. Unguarded/legacy requests do not establish guarded keys retroactively.

This is an explicit **demo action**, not a real payment or external side effect. Key registration, receipt and demo action are stored in one database transaction, with a per-lab unique key constraint and complete-ID checks alongside fixed-size hashes. Receiver totals count actions, skipped duplicates and key conflicts since the last inbox cleanup.

## Use an external PostgreSQL server

With Docker installed:

```sh
docker compose up -d postgres
cp .env.example .env
```

Uncomment `DATABASE_URL` in `.env`, then run `npm run dev`.

Alternatively, set `DATABASE_URL` to your own PostgreSQL connection string. Numbered schema migrations run automatically on startup. Embedded and external databases have separate data; switching the adapter does not migrate existing captures.

For a single server serving the built UI:

```sh
npm run build
npm start
```

Then open **http://localhost:4310**. Use `.env` to configure the API port and `APP_ORIGIN`, the origin shown in capture URLs. Vite's development proxy expects API port 4310; update `vite.config.js` if changing it.

## Architecture

```mermaid
flowchart LR
    Sender[curl / external sender / sample form] --> API[Fastify capture API]
    API --> DB[(PostgreSQL)]
    UI[React dashboard] --> Management[Read and lab management APIs]
    Management --> DB
    UI --> Replay[Manual replay API]
    Replay --> DB
    Replay -->|Original body over HTTP| Mock[Built-in mock receiver]
    Mock --> DB
    UI --> Queue[Delivery job API]
    Queue --> DB
    DB --> Worker[Local background worker]
    Worker -->|Recorded attempts over HTTP| Mock
```

The capture route has its own raw-buffer content parser. Management routes keep normal JSON validation. The API persists a request before acknowledging receipt. Each polling attempt cancels and drains its paired reads on failure, with a 10-second deadline, before scheduling another refresh.

| File                      | Responsibility                                                         |
| ------------------------- | ---------------------------------------------------------------------- |
| `server/index.js`         | Database connection, server startup, shutdown                          |
| `server/app.js`           | Routes, validation, limits, capture parser                             |
| `server/delivery.js`      | Bounded HTTP delivery and persisted attempt results                    |
| `server/jobs.js`          | Durable queue, leases, retry policy, cancellation and worker lifecycle |
| `server/receiver.js`      | Atomic mock receipts, idempotency keys and demo effects                |
| `server/replay.js`        | Mock scenarios, byte-preserving HTTP replay, attempt history           |
| `server/capture.js`       | Event metadata, header redaction, request storage                      |
| `server/database.js`      | Embedded and external database adapters                                |
| `server/schema.sql`       | Original capture schema                                                |
| `server/migrations.js`    | Versioned schema upgrades and metadata recovery                        |
| `web/src/App.jsx`         | Dashboard, inspector, sample sender, labs                              |
| `web/src/JobPanel.jsx`    | Retry controls, live jobs and attempt results                          |
| `web/src/ReplayPanel.jsx` | Receiver controls, replay and paginated attempt history                |
| `web/src/api.js`          | HTTP helper, sample events, curl quoting                               |
| `test/capture.test.js`    | API, concurrency, failure, and persistence tests                       |

See [design decisions](docs/architecture.md) and the [Greek getting-started guide](docs/getting-started-el.md).

## Verification

```sh
npm run verify
```

Runs lint, formatting checks, API and React UI test suites, and a production UI build. API tests cover exact bytes, Unicode, malformed JSON, duplicates arriving concurrently, cross-lab isolation, header redaction, storage failures, literal search wildcards, pagination, validation, request limits, and persistence across a database restart. Replay tests use real localhost HTTP to check unchanged bodies, failed/successful experiments, timeout uncertainty, response size limits, stalled response bodies, lab isolation, concurrent-operation exclusion, clearing and restart persistence. UI tests exercise the dashboard in React Strict Mode and cover repeated selection, pending details, switching requests, reopening the inspector, detail retry and repeated failures, independent inbox recovery, cancellation of obsolete retry responses, replay scenarios, late replay results, and confirmed inbox deletion.

Run the suites individually with `npm run test:api` or `npm run test:ui`. UI tests use Vitest, React Testing Library, and jsdom with mocked API responses; they are component interaction tests, not full browser/server integration tests.

For external PostgreSQL tests, provide a **dedicated test database**:

```sh
TEST_DATABASE_URL=postgres://user:password@localhost:5432/webhook_lab_test npm test
```

Tests clear their tables. Never point `TEST_DATABASE_URL` at a database containing data you want to keep. The suite intentionally ignores `DATABASE_URL` to keep application data separate from test data.

GitHub Actions runs the embedded suite and an independent PostgreSQL 17 integration job on pushes and pull requests. See the [workflow results](https://github.com/Taketsuru4/webhook-lab/actions/workflows/ci.yml).

## Limits of this release

This is a **local, single-user, single-API-process** tool, including when using external PostgreSQL. Management endpoints have no authentication. The default server listens on `127.0.0.1`; do not expose the management API publicly. The built-in playground endpoint uses a predictable token; newly created labs have randomly generated tokens. Tokens route requests; they are not a substitute for authentication.

Bodies are limited to 256 KiB. Common credential headers (`Authorization`, cookies, API keys, and common token headers) are redacted before storage. Payloads and arbitrary custom headers can still contain sensitive data; use synthetic data while experimenting. Raw text previews decode bytes as UTF-8, while downloaded bodies preserve the original bytes.

An event is identified only by complete top-level string fields `id` and `type`. NUL characters or unpaired UTF-16 surrogates make that field unavailable as metadata (absent ID or `untyped` type); the original body and parsed payload remain available. Full IDs are compared for duplicates, with a digest index narrowing candidates without imposing the B-tree key-size limit on the ID itself. Startup migrations restore previously truncated metadata from original bodies and record applied versions. Repeated-ID badges indicate repeated provider IDs within one lab, not semantic equivalence of arbitrary payloads. Requests without IDs count individually. Captures and mock receipts have no automatic expiry yet; use Clear inbox for cleanup. Replay response bodies are capped at 16 KiB, with an explicit truncation flag. At most one experiment is active per lab; a partial unique index permits one queued job per lab. The local worker runs one queued attempt at a time, alongside up to eight manual attempts per API process. Runs left in `running` for over 15 seconds are marked `interrupted` on startup or subsequent history/management operations; manual attempts are never automatically resent. Background jobs recover stale attempts separately and retry only within their configured budget. Replays target only this API’s built-in loopback receiver; arbitrary outbound URLs are unsupported. Manual replay does not guarantee exactly-once processing or validate provider signatures. Pagination uses offsets, so the visible pages can shift as live requests arrive; pause the sender for stable historical browsing.

## Roadmap

- [x] Capture, persist, and inspect requests.
- [x] Multiple labs, real sample sender, search, and duplicate visibility.
- [x] Persist local jobs and every attempt with a built-in database worker.
- [ ] Add an outbox dispatcher and Redis/BullMQ for a separate scalable worker.
- [x] Manual replay of original bodies with persisted attempt history.
- [x] Finite automatic retries, exponential backoff, cancellation and restart recovery.
- [ ] Add configurable duplicate-delivery and out-of-order scenarios.
- [x] Mock receiver with fail-first responses and delayed acknowledgements.
- [x] Numbered migrations and confirmed per-lab inbox cleanup.
- [x] Transactional receiver-side idempotency demo with payload-conflict detection.
- [ ] Add authentication, retention, and restricted outbound destinations for hosted use.

## License

MIT — see [LICENSE](LICENSE).
