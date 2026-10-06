# Design decisions

## Scope

Version 0.1 is a local capture and inspection tool. It is intended to be understandable by a JavaScript developer and runnable without installing database services. It has no replay worker yet. The initial workload is one developer and occasional bursts of synthetic webhooks, with payloads limited to 256 KiB.

## One request is one record

Every POST gets a UUID capture ID. The optional provider event ID is metadata, not a uniqueness constraint. Deduplicating at the capture layer would remove the exact evidence this tool should expose. Duplicate counts are scoped to a lab.

Later, the data model will distinguish captured requests, logical events, delivery runs, individual deliveries, and HTTP attempts. A manual replay must create a new delivery record while preserving the chosen event identity.

## Byte preservation

Capture routes read buffers without parsing JSON first. We store body bytes as base64 text and parse the UTF-8 representation only for metadata and preview. This costs roughly 33% more storage than raw bytes, but keeps both JavaScript database drivers and the download API simple. Revisit `BYTEA` or object storage for a larger service.

Header redaction intentionally modifies sensitive header values. This tool does not promise byte-for-byte preservation of the entire HTTP request, header casing, or a provider signature's validity during a future replay. The original body bytes are preserved.

## Acknowledgement boundary

Successful capture returns 202 after the INSERT completes. A failed INSERT returns 500. The request never receives a successful acknowledgement merely because its body was read into memory. There is no guarantee of exactly-once delivery: a sender can lose the acknowledgement and retry, which produces another capture.

## Two database adapters

An external PostgreSQL connection uses `pg.Pool`. The default development path uses file-backed PGlite, an embedded PostgreSQL WASM build. Both execute the same SQL schema and parameterized queries. PGlite permits quick local setup, but only a single application process should access its data directory.

The test suite runs locally against embedded PostgreSQL and is configured in CI for a real PostgreSQL service too. Startup applies numbered migrations in a transaction under a PostgreSQL advisory lock. Version 1 adopts the original schema; version 2 rebuilds complete metadata from captured bodies and replaces the provider-ID index. Applied versions are recorded, so upgrades preserve captures and repeated startup is idempotent.

## Indexing and refresh

Indexes support per-lab reverse-chronological listing and provider-ID duplicate lookups. IDs are stored in full; a fixed-size digest index narrows candidates and exact ID equality prevents hash collisions from merging events. Unsupported PostgreSQL text (NUL or unpaired UTF-16 surrogates) is unavailable as metadata, with original bytes retained. Search uses parameterized ILIKE with escaped wildcard characters. The small local workload does not need a cache. The dashboard issues two polling reads every 2.5 seconds, cancels a sibling read on failure, and drains both before scheduling another attempt. A 10-second deadline handles stalled reads; lab/filter changes cancel obsolete requests.

Offset pagination keeps the API easy to understand but can shift under continuous writes. Cursor pagination and computed duplicate aggregates would be the first database improvements for a high-volume inbox. A hosted deployment would also need retention, storage quotas, and authentication.

## Next milestone: reliable outbound delivery

Create a run and its planned deliveries inside a PostgreSQL transaction. Persist an outbox entry in that transaction. A dispatcher submits pending entries to BullMQ using stable job IDs. Recover pending entries after restart; reconcile jobs that might have been submitted before the dispatcher marked them.

The worker records each HTTP attempt, applies a finite retry policy, and forwards the recorded bytes. Worker retries and queue redelivery must be expected. Receiver-side idempotency requires its own transactional constraints and cannot be guaranteed by queue job-ID deduplication.

The built-in mock receiver will allow deterministic 500 responses and slow acknowledgements. The public demo should initially allow only that receiver; arbitrary outbound URLs require protection against access to private addresses, redirects, and DNS changes.
