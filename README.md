# Webhook Lab

**Capture, inspect, and understand your webhooks.**

[![Verify](https://github.com/Taketsuru4/webhook-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/Taketsuru4/webhook-lab/actions/workflows/ci.yml)

A local developer tool that gives each integration its own HTTP endpoint and event inbox. Inspect the exact body, browse headers, and spot repeated event IDs without losing any incoming requests.

Built entirely in **JavaScript** with React, Vite, Fastify, and PostgreSQL.

**Status:** milestone 1 — capture and inspection. Replay, a Redis/BullMQ delivery worker, and failure scenarios are planned next. This release does not forward requests or simulate receiver failures.

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

The API returns `202` only after the request has been stored. `202` means **captured**, not forwarded or processed by a business application.

## What works today

- Create named labs with isolated endpoints and inboxes.
- Capture arbitrary HTTP POST bodies, including malformed JSON, plain text, binary, and empty bodies.
- Preserve original bytes as base64; download the original body from the inspector.
- Browse pretty-printed JSON, redacted headers, and raw UTF-8 text previews.
- Search event type, provider event ID, or capture ID; filter repeated IDs and untyped requests.
- Paginate 50 requests at a time.
- Refresh the inbox every 2.5 seconds, with a pause control.
- See actual request totals, duplicate counts, stored body sizes, and an hourly traffic histogram.
- Copy endpoint URLs and safely quoted curl commands.
- Use the responsive dashboard with keyboard navigation and reduced-motion support.

Nothing is seeded into the inbox. The sample sender creates real, synthetic requests when you click it.

## Use an external PostgreSQL server

With Docker installed:

```sh
docker compose up -d postgres
cp .env.example .env
```

Uncomment `DATABASE_URL` in `.env`, then run `npm run dev`.

Alternatively, set `DATABASE_URL` to your own PostgreSQL connection string. The schema is initialized on startup. Embedded and external databases have separate data; switching the adapter does not migrate existing captures.

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
```

The capture route has its own raw-buffer content parser. Management routes keep normal JSON validation. The API persists a request before acknowledging receipt, and the UI polls the API without overlapping refreshes.

| File                   | Responsibility                                    |
| ---------------------- | ------------------------------------------------- |
| `server/index.js`      | Database connection, server startup, shutdown     |
| `server/app.js`        | Routes, validation, limits, capture parser        |
| `server/capture.js`    | Event metadata, header redaction, request storage |
| `server/database.js`   | Embedded and external database adapters           |
| `server/schema.sql`    | Tables and indexes                                |
| `web/src/App.jsx`      | Dashboard, inspector, sample sender, labs         |
| `web/src/api.js`       | HTTP helper, sample events, curl quoting          |
| `test/capture.test.js` | API, concurrency, failure, and persistence tests  |

See [design decisions](docs/architecture.md) and the [Greek getting-started guide](docs/getting-started-el.md).

## Verification

```sh
npm run verify
```

Runs lint, formatting checks, API and React UI test suites, and a production UI build. API tests cover exact bytes, Unicode, malformed JSON, duplicates arriving concurrently, cross-lab isolation, header redaction, storage failures, literal search wildcards, pagination, validation, request limits, and persistence across a database restart. UI tests exercise the dashboard in React Strict Mode and cover repeated selection, pending details, switching requests, and reopening the inspector.

Run the suites individually with `npm run test:api` or `npm run test:ui`. UI tests use Vitest, React Testing Library, and jsdom with mocked API responses; they are component interaction tests, not full browser/server integration tests.

For external PostgreSQL tests, provide a **dedicated test database**:

```sh
TEST_DATABASE_URL=postgres://user:password@localhost:5432/webhook_lab_test npm test
```

Tests clear their tables. Never point `TEST_DATABASE_URL` at a database containing data you want to keep. The suite intentionally ignores `DATABASE_URL` to keep application data separate from test data.

GitHub Actions runs the embedded suite and an independent PostgreSQL 17 integration job on pushes and pull requests. See the [workflow results](https://github.com/Taketsuru4/webhook-lab/actions/workflows/ci.yml).

## Limits of this release

This is a **local, single-user** tool. Management endpoints have no authentication. The default server listens on `127.0.0.1`; do not expose the management API publicly. The built-in playground endpoint uses a predictable token; newly created labs have randomly generated tokens. Tokens route requests; they are not a substitute for authentication.

Bodies are limited to 256 KiB. Common credential headers (`Authorization`, cookies, API keys, and common token headers) are redacted before storage. Payloads and arbitrary custom headers can still contain sensitive data; use synthetic data while experimenting. Raw text previews decode bytes as UTF-8, while downloaded bodies preserve the original bytes.

An event is identified only by top-level string fields `id` and `type`. Repeated-ID badges indicate repeated provider IDs within one lab, not semantic equivalence of arbitrary payloads. Requests without IDs count individually. Captures have no automatic expiry yet. Pagination uses offsets, so the visible pages can shift as live requests arrive; pause the sender for stable historical browsing.

## Roadmap

- [x] Capture, persist, and inspect requests.
- [x] Multiple labs, real sample sender, search, and duplicate visibility.
- [ ] Persist delivery runs and an outbox, then dispatch using Redis/BullMQ.
- [ ] Replay captured bodies and record every HTTP attempt.
- [ ] Add configurable retries, timeouts, duplicate delivery, and out-of-order scenarios.
- [ ] Add a mock receiver and a transactional idempotency demo.
- [ ] Add authentication, retention, and restricted outbound destinations for hosted use.

## License

MIT — see [LICENSE](LICENSE).
