# Astra code review — Webhook Lab

Reviewer: GPT-6 Astra. Review date: October 6, 2026. Reviewed application baseline: `621e4d21b94643a7b837bd9ab5e124dce192dea4`.

## Scope and verdict

This review covers the existing application, not merely the documentation diff in PR #1: Fastify routes and parsing, capture metadata and storage, both database adapters and schema, React state and fetching, inspector/download behavior, responsive styles, configuration, tests, CI, and architecture documentation. It applies the engineering code-review skill. This is an AI-assisted Astra review, not human approval; no fixes were implemented as part of it.

**Verdict: address the correctness findings before treating the capture milestone as hardened, then build replay incrementally.** The architecture is appropriately small for a local single-user application. No P1 issue was established in that intended operating model. Four P2 findings and one P3 finding are listed below. Authentication, hosted operation, retention, replay, and outbound delivery are explicitly future scope; their absence is not reported as an implemented defect.

## Actionable findings

### 1. P2 — Selecting an already selected request leaves the inspector loading indefinitely

**Location:** [web/src/App.jsx:626](https://github.com/Taketsuru4/webhook-lab/blob/621e4d21b94643a7b837bd9ab5e124dce192dea4/web/src/App.jsx#L626), lines 626–630; related detail effect at 603–618.

**Trigger:** Select a populated inbox row, wait for its body to load, then click the same row again.

**Impact and cause:** `selectRequest` clears `capture` and sets `detailLoading` to true every time. `selectedId` remains identical, so React does not rerun the effect whose dependencies are `[selectedId, labId]`. Nothing reloads the body or resets loading. Polling does not repair it. Closing/reopening the inspector or selecting a different request works around it.

**Recommended change:** Make selection idempotent for the current ID, or move loading initialization into the effect that actually starts the request. Keep an explicit detail reload action separate from selection. Add a UI regression test that selects the same row twice and verifies that its content stays visible.

**Evidence:** Deterministic source/state-transition analysis. Supplemental browser verification by the coordinating agent used the built UI at localhost:4311 with an isolated temporary database: after sending a synthetic sample and seeing its payload, clicking the same selected row changed the inspector to “Loading request…”, which persisted through the next polling interval. The Astra reviewer did not personally run that browser check.

### 2. P2 — A failed detail request cannot be recovered with the displayed Retry button

**Location:** [web/src/App.jsx:603](https://github.com/Taketsuru4/webhook-lab/blob/621e4d21b94643a7b837bd9ab5e124dce192dea4/web/src/App.jsx#L603), lines 603–618; Retry handler at lines 783–788.

**Trigger:** Cause the selected request's detail GET to fail once, restore connectivity, then click Retry in the error banner.

**Impact and cause:** The detail catch displays the error and exits loading. Retry clears the error and increments `revision`, but only the inbox/stats polling effect depends on `revision`; the detail effect does not. The inspector remains without content, although the button suggests that the failed operation will be retried. Clicking the same row also hits finding 1.

**Recommended change:** Give detail fetching a retry token or dedicated retry handler, and show a retry action in the inspector's error state. Track detail errors separately from connection and clipboard errors so each recovery action targets the failed operation.

**Acceptance test:** Mock the detail endpoint to return 500 once and 200 next; select a row, click Retry, and assert a second detail GET and restored inspector content without changing selection.

**Evidence:** Source-level dependency and handler analysis by Astra. The coordinating agent additionally verified this in the isolated review browser: a fetch wrapper rejected one detail request and allowed subsequent calls to succeed. After clicking the displayed Retry button, the detail-call counter remained at 1 and the inspector still displayed “Could not load this request.” This was a browser check with an injected client-side failure, not a backend outage test; Astra did not personally run it.

### 3. P2 — Valid JSON metadata containing U+0000 prevents otherwise valid captures

**Location:** [server/capture.js:22](https://github.com/Taketsuru4/webhook-lab/blob/621e4d21b94643a7b837bd9ab5e124dce192dea4/server/capture.js#L22), lines 22–25, with insertion at 31–47.

**Trigger:** POST `{"id":"a\u0000b","type":"ok"}` or `{"id":"ok","type":"a\u0000b"}` with `Content-Type: application/json`.

**Impact and cause:** JSON parsing succeeds, but extracted metadata contains an actual NUL character. PostgreSQL text cannot store that character. The insert fails, producing 500 and retaining no capture, even though the original bytes are valid input to the advertised arbitrary-body capture path. Metadata extraction should not be able to veto storage of the original body.

**Recommended change:** Define a PostgreSQL-safe metadata policy before inserting. For unsupported text, fall back to absent event ID / untyped metadata and preserve the original bytes; alternatively retain a reversible representation with explicit interpretation. Avoid lossy sanitization that could merge unrelated IDs. Apply the policy consistently to both adapters.

**Executed reproduction:** Using a fresh in-memory PGlite database and `app.inject`, both payloads returned status 500 with the generic error response. Neither was stored. This used the actual application code, not mocked storage. The external pg adapter was not executed during this review.

**Acceptance test:** Both requests return 202, byte-for-byte body download matches the original input, and subsequent ordinary captures still work.

### 4. P2 — Truncating provider IDs creates false duplicate identities

**Location:** [server/capture.js:24](https://github.com/Taketsuru4/webhook-lab/blob/621e4d21b94643a7b837bd9ab5e124dce192dea4/server/capture.js#L24); consumers at server/app.js, lines 110–125 and 140–141.

**Trigger:** Send two distinct string IDs whose first 200 UTF-16 code units match, for example `'a'.repeat(200) + '1'` and `'a'.repeat(200) + '2'`.

**Impact and cause:** Both values are silently stored as the same ID. The inbox labels them repeated, the repeated-ID filter includes them, and the unique-event count is wrong. This contradicts the documented meaning of repeated provider IDs. Original bodies survive, but derived identity and search are corrupted. The truncation is not required by the schema, which uses TEXT.

**Recommended change:** Keep full identity separately from any display truncation. Account for PostgreSQL B-tree index key-size limits if accepting large IDs: a fixed-size digest can support lookup, with exact full-value equality where needed. Another explicit policy is to preserve overlong IDs in capture data but mark identity unavailable and exclude them from duplicate grouping. Do not simply remove truncation without considering the index. Event-type truncation should also be made explicit or confined to presentation.

**Executed reproduction:** Both 201-character IDs returned 202. Stats returned `total: 2` and `duplicates: 1`; the repeated filter returned both rows with `occurrences: 2` and the same truncated ID. The expected duplicate count is zero.

**Acceptance test:** IDs differing only after character 200 remain distinct; actual repeated long IDs are classified consistently with the chosen policy; search and displayed metadata do not silently claim a different identity.

### 5. P3 — Polling can overlap after one of its parallel requests rejects

**Location:** [web/src/App.jsx:579](https://github.com/Taketsuru4/webhook-lab/blob/621e4d21b94643a7b837bd9ab5e124dce192dea4/web/src/App.jsx#L579), lines 579–593.

**Trigger:** The requests endpoint fails promptly while its paired stats request remains pending for longer than the retry interval, or vice versa.

**Impact and cause:** `Promise.all` rejects when its first member rejects; it does not wait for or cancel the sibling fetch. `finally` schedules the next refresh after 2.5 seconds using the same lifetime controller. A new pair starts while the old sibling is still pending. Repeated partial failures can accumulate requests and add pressure to an already unhealthy API. The normal successful path correctly avoids overlapping refreshes; the failure path does not satisfy the documented guarantee.

**Recommended change:** Use a controller per refresh attempt, abort the sibling when an attempt fails, and wait for both operations to settle before scheduling again. Add a finite fetch timeout so a hung sibling cannot indefinitely prevent recovery. Preserve the effect-level cleanup when switching labs, filters, or live mode.

**Executed reproduction:** Extracted the actual `refresh` function body from App.jsx and ran it with a rejecting requests mock, unresolved stats mock, and controllable timer. After the first attempt there was one pending stats request and a 2500 ms timer; firing that timer produced two pending stats requests and another timer. This is a deterministic control-flow harness, not a browser/network integration test.

**Acceptance test:** Under partial failure and delayed responses, there is at most one refresh attempt's worth of active work, retry eventually occurs, and unmount/lab switch cancels outstanding work.

## Strengths and threat-model assessment

- Exact body bytes are retained as base64 independently of JSON parsing, including malformed JSON and binary payloads. Downloads reconstruct bytes rather than downloading the UTF-8 preview.
- Captures are acknowledged only after the insert succeeds. Concurrent duplicate deliveries remain separate records; provider IDs do not impose a uniqueness constraint.
- Parameterized SQL, literal wildcard escaping, UUID validation, lab-scoped detail reads, and React text rendering reduce common injection and cross-lab mistakes.
- Default loopback binding, a body-size ceiling, rate limiting, and pre-storage redaction are sensible protections for the documented local workflow.
- The ordinary polling path cancels obsolete reads on dependency changes and avoids scheduling a new successful poll before both reads finish.
- The test suite checks useful behavior: persistence across actual reopen, storage failure acknowledgment, duplicate concurrency, and binary preservation. CI config includes a separate PostgreSQL service job.

No new claim of comprehensive security assurance is made. Tokens are routing identifiers and the default token is predictable by design. Arbitrary payloads/custom headers can contain sensitive content, as documented. No outbound requests exist, so SSRF through a replay feature is a future design concern rather than a current bug.

## Optional engineering improvements — not blocking defects

1. **Split stateful concerns before expanding replay.** Extract `useLabs`, `useInbox`, and `useCapture`, then separate the modal, inspector, and inbox components. The goal is explicit loading/error/retry ownership, not merely shorter files. Keep a lightweight React test harness around these boundaries.
2. **Profile duplicate queries before optimizing.** The repeated-ID filter runs a correlated count for each candidate row, and displayed occurrences also use correlated counts. A large repeated-ID group can require repeated scans even with the event index. The documented small synthetic workload does not establish a present performance incident. Benchmark representative repeat-heavy histories and compare a grouped aggregate joined to the page; choose a change using EXPLAIN evidence.
3. **Introduce numbered migrations before adding delivery tables.** `CREATE TABLE IF NOT EXISTS` is enough for this unchanged initial schema, but it cannot evolve an existing installation. Keep migration history and test upgrades against both adapters before the next schema revision.
4. **Complete the tabs keyboard interaction.** Inspector buttons declare tab semantics but have no roving tab index or arrow/Home/End handling. All tabs remain reachable with Tab and activate normally; implement the expected tab interaction and verify keyboard focus when adding UI tests.
5. **Stabilize historical browsing when volume warrants it.** Offset shifting under writes is accurately documented and is not an undisclosed defect. Cursor pagination plus a frozen browsing boundary would make an eventual busy inbox easier to inspect.

## Test assessment and checks performed

Executed locally during this review:

- `npm run verify`: ESLint passed; Prettier passed; all **12 tests** passed; Vite production build passed.
- Actual application `app.inject` reproductions against a fresh in-memory PGlite database for U+0000 metadata and colliding long IDs.
- A controlled JavaScript harness using the application's refresh function to demonstrate overlap after a parallel request rejects.
- Compared application source with the stated baseline; subsequent documentation work did not change the server, web, test, or package source under review.

No tracked application files were edited. The normal build generated ignored `dist` output. Reproductions used in-memory storage, not the user's persisted captures.

Limitations: Astra did not perform a fresh external PostgreSQL run, Docker run, browser E2E run, accessibility scan, dependency vulnerability audit, sustained load test, or operating-system crash/durability test. Earlier browser/PostgreSQL verification in project documentation is historical evidence, not a check performed by Astra. UI findings above are directly supported by source analysis; the coordinating agent additionally reproduced findings 1 and 2 in a browser as described there. The draft PR's GitHub Actions checks passed both the embedded and PostgreSQL jobs, but those existing checks do not cover the new review reproductions. Automated browser regressions are recommended. Existing pagination tests check a static dataset; they do not establish stability during concurrent arrivals. Existing concurrency coverage is valuable for inserts but does not cover UI fetching or a failure in only one polling endpoint.

## Prioritized roadmap

Fix findings 1–4 and add focused regression tests first; resolve polling cancellation alongside the new fetching tests. These are repairs within the existing capture milestone. The following are proposed features, not capabilities present today.

| Order | Feature and user value                                                                                                                                     | Dependencies                                                                                                 | Suggested acceptance criteria                                                                                                                                                                                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **Local data lifecycle:** clear captures, delete/rename labs, and optional retention. Developers can reset experiments and control disk use.               | Numbered migrations where needed; deliberate destructive-action UX; handle a selected capture disappearing.  | Clear/delete is scoped to the selected lab; destructive intent is explicit; default playground behavior is defined; retention is disabled by default or clearly configured; UI totals and inspector recover after deletion; both adapters tested.                                                        |
| 2     | **Manual replay to a configured local test receiver:** compare what was captured with what a receiver gets.                                                | Delivery-run and attempt model; byte-preserving transport; target configuration; migration infrastructure.   | Replay creates a new run without mutating the capture; recorded body bytes arrive unchanged; response status, bounded response body, timing, timeout, and errors are visible; hop-by-hop and redacted credentials are not blindly forwarded; a configured mock receiver is enough for the first release. |
| 3     | **Durable queued delivery and retries:** experiments survive restarts and expose real delivery behavior.                                                   | Feature 2; transactional outbox; dispatcher; BullMQ/Redis if retained as the chosen queue; worker lifecycle. | Kill/restart tests at transaction, enqueue, and acknowledgment boundaries leave no silently lost planned deliveries; every attempt is recorded; backoff and maximum attempts are finite; duplicate execution is modeled explicitly; no exactly-once claim.                                               |
| 4     | **Deterministic failure scenarios and mock receiver:** reproduce retries, slow acknowledgments, duplicate delivery, and out-of-order arrival.              | Basic replay; durable worker for multi-attempt scenarios; scenario configuration persisted with each run.    | A saved scenario can fail the first N requests or delay a response; attempts and final outcome match its settings; order/duplicates are visible; scenarios have bounded concurrency/duration; an idempotent receiver demo verifies one business effect despite repeated delivery.                        |
| 5     | **Investigation tools:** stable history, request comparison, and export. Developers can explain how retries differ and share reproducible synthetic cases. | Cursor/snapshot browsing policy; full event-identity handling from finding 4; bounded export format.         | New captures do not reshuffle an explicitly frozen browsing session; compare any two captures including headers and exact-body differences; exports label redaction and preserve binary body bytes; import/export round-trip tests cover malformed JSON and duplicate IDs.                               |

A public/hosted edition should be a separate milestone requiring authentication/authorization, isolation, retention quotas, and restricted outbound networking before arbitrary replay targets are exposed. It should not delay the useful local replay path or be represented as a bug in today's intentionally local release.

## Concise Greek summary

Η βάση του Webhook Lab είναι σωστά περιορισμένη στο τοπικό capture/inspection και το `npm run verify` πέρασε με 12/12 tests. Βρέθηκαν τέσσερα θέματα P2: δεύτερο κλικ στο ίδιο request αφήνει τον inspector σε loading, το Retry δεν επαναλαμβάνει αποτυχημένο detail fetch, `\u0000` στα metadata προκαλεί 500 αντί για αποθήκευση, και το κόψιμο των IDs στους 200 χαρακτήρες δημιουργεί ψευδή duplicates. Υπάρχει επίσης P3 θέμα επικάλυψης polling όταν αποτύχει μόνο ένα από τα δύο παράλληλα requests. Δεν εντοπίστηκε τεκμηριωμένο P1 στο προβλεπόμενο local μοντέλο και δεν έγιναν διορθώσεις σε αυτό το review.

Προτεινόμενη συνέχεια: πρώτα οι διορθώσεις και UI regression tests, μετά διαχείριση τοπικών δεδομένων, manual replay σε mock receiver, ανθεκτικός worker/outbox με retries, ελεγχόμενα failure scenarios και εργαλεία σύγκρισης/export. Auth και hosted ασφάλεια παραμένουν ξεχωριστό μελλοντικό milestone.
