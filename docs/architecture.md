# Design decisions

## Scope

The local MVP captures, inspects and manually replays webhooks to a built-in mock receiver. It is intended to be understandable by a JavaScript developer and runnable without installing database services. A local background worker supports persistent, finite retry jobs. Run one API process, even with external PostgreSQL. The initial workload is one developer and occasional bursts of synthetic webhooks, with payloads limited to 256 KiB.

## One request is one record

Every POST gets a UUID capture ID. The optional provider event ID is metadata, not a uniqueness constraint. Deduplicating at the capture layer would remove the exact evidence this tool should expose. Duplicate counts are scoped to a lab.

Each manual replay creates a new `replay_runs` row referencing its immutable capture. There is one HTTP attempt per run. Manual attempts remain independent; queued jobs group their attempts with `delivery_job_id` and an attempt number. No business operation, payment execution, event deduplication or exactly-once processing is inferred from capture or replay status. Delivery job state describes overall scheduling; HTTP attempt state records each observed result.

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

The tradeoff is an immediately runnable local experiment with clear outcomes and small operational cost. A separate scalable worker and configurable external destinations are future steps.

## Transactional receiver idempotency

Migration 4 adds an opt-in guard and `mock_effects`. This table models synthetic actions rather than real payments. Each successful unguarded receipt creates a new action; guarded receipts require a non-empty, supported top-level string `id` to deduplicate. Missing/invalid keys remain inspectable and explicitly process without protection.

`acceptMock` runs inside the receiver transaction while holding the lab row lock. It stores the receipt and demo effect, including a key reservation, atomically. The database also enforces uniqueness of `(lab_id, key_hash)` for guarded actions. SHA-256 keeps the index key bounded for large provider IDs; complete key equality is checked before acknowledging a duplicate. A digest collision fails closed as a conflict. The original body hash must match too: reusing an ID with different bytes is 409, including changes that preserve JSON semantics. This is a deliberate strict-body experiment, not provider-specific normalization.

Configured 500 responses record receipts but perform no action or key registration. A delayed acknowledgement follows the commit, so a sender can time out after processing; a retry then returns 200 with `duplicate` and the same effect ID. HTTP success does not mean a new action occurred. Dashboard counters and attempt outcomes make that distinction visible.

Receiver settings reset only the fail-first counter. Existing effects/keys and aggregate outcome counts survive settings changes and restarts. Disabling protection permits individual actions again; enabling it does not backfill keys from unguarded receipts. Legacy receipts are marked `legacy` without inventing historical actions. Clearing the inbox removes receipts and cascading effects/keys, so a new experiment may process that ID again. Long-term retention of protection records would need a separately chosen policy.

The guarantee covers the demo action stored in the same database transaction. External payments, email or arbitrary side effects require their own idempotency contract or transactional outbox; a database key cannot make a remote action atomic.

## Persistent local retry worker

Migration 5 creates `delivery_jobs` and links background attempts to their jobs. Enqueue holds the lab lock, checks capture scope and absence of active experiments, persists the job and commits before 202. A partial unique index guards one active job per lab. The job row is the local durable queue itself, so there is no second queue write or outbox dual-write problem in this version.

The worker starts only after Fastify is listening. It polls every 250 ms and processes one job attempt at a time across labs. Claiming locks the lab then the job, rechecks eligibility, inserts the running attempt and updates the job lease/count in one transaction before HTTP. Result storage and next scheduling state also commit together. HTTP happens outside the transaction so the built-in receiver can acquire its own lab lock.

A finite policy retries network failures, timeouts, HTTP 408/429 and 5xx responses. Other responses, including redirects and 409 conflicts, stop. The initial delay doubles per failure and caps at five seconds; retries include no jitter because this local tool aims for reproducible experiments. Maximum attempts includes the initial attempt and is limited to five. A production dispatcher would need configurable jitter, Retry-After support and a concurrency/throughput policy.

If a lease remains running for 15 seconds, recovery marks the attempt interrupted and schedules another one if budget remains, or terminates exhausted/cancelled jobs. Failed result transactions can leave a request delivered but recorded as uncertain; receiver-side idempotency is what prevents repeated demo actions during recovery. A late completion must match the current attempt count/state before updating the job. This is an at-least-once model; there is no exactly-once delivery claim.

Cancellation is durable and scoped to the job's capture/lab. Queued/waiting jobs stop immediately. Running jobs set a cancellation flag and record the current outcome before cancelling future attempts. Receiver resets, manual replay and inbox cleanup reject active jobs. Clear inbox cascades through jobs/attempts and separately clears receiver receipts/effects. Job histories paginate ten jobs per page and include at most five bounded attempt responses each; manual history excludes background attempts.

`preClose` stops polling and waits for the current worker attempt before resource shutdown. Idle HTTP sockets are limited to ten seconds. Test teardown explicitly destroys unused test sockets after assertions so aborted-fetch replacement connections cannot delay the suite. Fresh interrupted leases may remain visible as running until expiry; the UI polls active jobs and explains cancellation uncertainty.

This keeps the default installation runnable without Redis, at the cost of a single in-process worker and database polling. PGlite still requires one API process; external PostgreSQL is exercised with the same SQL but this release keeps the same one-process contract. A separate distributed-worker mode should add heartbeat leases, worker ownership, fairness and reconciliation tests rather than assuming this local loop is a scalable service.

## Next milestone: separate outbound worker

Create a run and its planned deliveries inside a PostgreSQL transaction. Persist an outbox entry in that transaction. A dispatcher submits pending entries to BullMQ using stable job IDs. Recover pending entries after restart; reconcile jobs that might have been submitted before the dispatcher marked them.

The worker records each HTTP attempt, applies a finite retry policy, and forwards the recorded bytes. Worker retries and queue redelivery must be expected. Receiver-side idempotency requires its own transactional constraints and cannot be guaranteed by queue job-ID deduplication.

The built-in mock receiver already supports deterministic 500 responses and slow acknowledgements. The public demo should initially allow only that receiver; arbitrary outbound URLs require protection against access to private addresses, redirects, and DNS changes.
