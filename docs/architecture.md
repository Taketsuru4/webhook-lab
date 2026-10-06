# Design decisions

## Scope

The local MVP captures, inspects and manually replays webhooks to a built-in mock receiver. It is intended to be understandable by a JavaScript developer and runnable without installing database services. It has no background worker or automatic retries. Run one API process, even with external PostgreSQL. The initial workload is one developer and occasional bursts of synthetic webhooks, with payloads limited to 256 KiB.

## One request is one record

Every POST gets a UUID capture ID. The optional provider event ID is metadata, not a uniqueness constraint. Deduplicating at the capture layer would remove the exact evidence this tool should expose. Duplicate counts are scoped to a lab.

Each manual replay creates a new `replay_runs` row referencing its immutable capture. There is one HTTP attempt per run. No business operation, payment execution, event deduplication or exactly-once processing is inferred from capture or replay status. A future queued-delivery model can distinguish runs, deliveries and attempts.

## Byte preservation

Capture routes read buffers without parsing JSON first. We store body bytes as base64 text and parse the UTF-8 representation only for metadata and preview. This costs roughly 33% more storage than raw bytes, but keeps both JavaScript database drivers and the download API simple. Revisit `BYTEA` or object storage for a larger service.

Header redaction intentionally modifies sensitive header values. This tool does not promise byte-for-byte preservation of the entire HTTP request, header casing, or a provider signature's validity during replay. The original body bytes are preserved.

## Acknowledgement boundary

Successful capture returns 202 after the INSERT completes. A failed INSERT returns 500. The request never receives a successful acknowledgement merely because its body was read into memory. There is no guarantee of exactly-once delivery: a sender can lose the acknowledgement and retry, which produces another capture.

## Two database adapters

An external PostgreSQL connection uses `pg.Pool`. The default development path uses file-backed PGlite, an embedded PostgreSQL WASM build. Both execute the same SQL schema and parameterized queries. PGlite permits quick local setup, but only a single application process should access its data directory.

The test suite runs locally against embedded PostgreSQL and is configured in CI for a real PostgreSQL service too. Startup applies numbered migrations in a transaction under a PostgreSQL advisory lock. Version 1 adopts the original schema; version 2 rebuilds complete metadata from captured bodies and replaces the provider-ID index. Applied versions are recorded, so upgrades preserve captures and repeated startup is idempotent.

## Indexing and refresh

Indexes support per-lab reverse-chronological listing and provider-ID duplicate lookups. IDs are stored in full; a fixed-size digest index narrows candidates and exact ID equality prevents hash collisions from merging events. Unsupported PostgreSQL text (NUL or unpaired UTF-16 surrogates) is unavailable as metadata, with original bytes retained. Search uses parameterized ILIKE with escaped wildcard characters. The small local workload does not need a cache. The dashboard issues two polling reads every 2.5 seconds, cancels a sibling read on failure, and drains both before scheduling another attempt. A 10-second deadline handles stalled reads; lab/filter changes cancel obsolete requests.

Offset pagination keeps the API easy to understand but can shift under continuous writes. Cursor pagination and computed duplicate aggregates would be the first database improvements for a high-volume inbox. A hosted deployment would also need retention, storage quotas, and authentication.

## Local manual replay

Migration 3 adds receiver settings, replay runs and mock receipts. Persist a `running` row before sending. The API then forwards the stored body and Content-Type over real loopback HTTP to its own mock route, followed by a separate result UPDATE. APP_ORIGIN affects displayed capture URLs and cannot select a replay destination. Other captured headers are not forwarded: credentials are redacted and old signature headers would misrepresent the new request.

The mock receiver atomically increments its counter and records the received body before delaying its response. Its first N requests return 500, and subsequent requests return 200. Saving configuration resets the counter. Original captures are never changed or added by replay. Receipts retain another copy of the body: acceptable for local experiments, but they increase storage and must be included in cleanup/retention for a hosted product.

Timeouts cover response headers and body consumption. We store at most 16 KiB of response bytes, flag truncation and cancel the remaining stream. History previews decode those bytes as UTF-8. A successful state means a 2xx response; a timeout can occur after the receiver has received the body. There is no distributed transaction spanning HTTP and PostgreSQL: a process crash or failed result UPDATE leaves delivery outcome uncertain. Runs older than 15 seconds that still say `running` become `interrupted` on startup or a later history/management operation. Fresh interrupted runs can take that long to be recognized; none are automatically resent.

A lab row lock serializes starting a replay, saving receiver settings and clearing the inbox. Persistent running-state checks permit one experiment per lab; an in-process limit permits eight active replays across labs. Locks are released before HTTP, so the mock route can obtain its own lock without deadlock. Clear inbox requires the current lab name, rejects running experiments and deletes captures with cascading run history plus mock receipts in a transaction. It preserves the lab/token/configuration and resets the receiver counter. Typing a name is deliberate-action UX, not authorization.

The dashboard keeps replay controls separate from the original inspector tabs, refreshes history after an action and cancels obsolete reads/actions when selection changes. Cancelling the browser request does not undo a server-side delivery. Running history entries are polled until completion; other history is refreshed manually, so another browser's new attempt is visible after Refresh.

The tradeoff is an immediately runnable local experiment with clear outcomes and small operational cost. A durable worker, configurable external destinations and receiver-side idempotency are separate next steps.

## Next milestone: queued outbound delivery

Create a run and its planned deliveries inside a PostgreSQL transaction. Persist an outbox entry in that transaction. A dispatcher submits pending entries to BullMQ using stable job IDs. Recover pending entries after restart; reconcile jobs that might have been submitted before the dispatcher marked them.

The worker records each HTTP attempt, applies a finite retry policy, and forwards the recorded bytes. Worker retries and queue redelivery must be expected. Receiver-side idempotency requires its own transactional constraints and cannot be guaranteed by queue job-ID deduplication.

The built-in mock receiver already supports deterministic 500 responses and slow acknowledgements. The public demo should initially allow only that receiver; arbitrary outbound URLs require protection against access to private addresses, redirects, and DNS changes.
