# Local verification — October 2, 2026

Validated on macOS using Node.js 26.0.0.

- `npm run verify`: lint, formatting, 12 passing tests, and a production Vite build.
- The same 12-test suite passed using a native PostgreSQL 17.10 server through the `pg` adapter. The server and database were temporary and stopped after verification. Docker Compose itself was not run because Docker is not installed on this machine.
- Browser checks covered real sample sending, payload and header inspection, two captures with the same event ID, search with no results, repeated-ID filtering, lab creation and isolation, and the quick-start view.
- The copied curl command was executed against the live API. Quotes, dollar signs, and backticks in the JSON body were retained literally.
- At 375, 768, and 1024 px, the page loaded with meaningful content and no document-level horizontal overflow. Desktop layout was also inspected at 1440 px.
- Automated axe-core checks found zero violations on the populated inbox at both 375 and 1440 px. Each report retained one incomplete rule requiring manual review; this is not a claim of full accessibility conformance.
- No browser JavaScript errors were reported in the verified flow.

The local inbox contains three synthetic requests sent during browser and curl verification. They are runtime data in `.data/`, excluded from version control; the application does not seed them on a new installation.

At the time of this October 2 verification, GitHub Actions was configured but had not run remotely, and the project had not been published to GitHub or deployed. Current CI results are available in the [GitHub Actions workflow](https://github.com/Taketsuru4/webhook-lab/actions/workflows/ci.yml).

## Publication checks — October 6, 2026

- `npm run verify` passed again before publication: lint, formatting, all 12 tests, and a production build.
- Local database files, `.env`, dependencies, and generated build artifacts are excluded from Git.

## Local MVP checks — October 6, 2026

- The final implementation passed 28 API tests and 18 UI tests, alongside lint, formatting and a production build.
- New API integration tests send real HTTP requests over loopback. They verify original JSON, malformed JSON, binary and empty bytes; separate 500/200 attempts; timeout uncertainty; bounded responses; stalled bodies; concurrency checks; scoped cleanup; history pagination; and persistence after close/reopen.
- Failure tests verify that an unavailable run INSERT prevents sending, while a failed result UPDATE after delivery leaves an uncertain running record that is later marked interrupted. Recovery never resends it.
- Legacy migration tests restore complete IDs from original bodies and adopt all three schema versions idempotently.
- UI tests cover receiver configuration, saved scenarios, pending replay, uncertain errors, late results after selection changes, typed-name deletion, deletion failure recovery, and keeping an in-flight deletion dialog open on Escape.
- Browser verification used an isolated temporary PGlite directory and a server on port 4311, leaving application captures separate. The UI sent a real sample, replayed it successfully, configured first-request failure, observed 500 then 200, and recorded a roughly 2000 ms timeout with 3000 ms receiver delay.
- Reload retained all four attempt records. Typed-name confirmation rejected a wrong name, then clearing removed captures and attempt history while preserving the lab.
- No browser JavaScript errors were reported. Screenshots were visually inspected at 1440 and 375 px; checks at 375 and 768 px found no document-level horizontal overflow. No new accessibility audit was performed for the replay UI.
- GitHub CI independently validates the same code against embedded PostgreSQL and native PostgreSQL 17; use the linked PR checks for remote results.

## Receiver idempotency checks — October 6, 2026

- 35 API tests and 19 UI tests passed, with lint, formatting and production build.
- Six concurrent identical receiver requests produce one demo effect and five duplicate acknowledgements. Tests cover configured 500 before processing, changed-body conflicts, timeout followed by a safe retry, missing keys, complete 16 KiB event IDs, lab isolation, complete-key checking, atomic rollback and keys surviving restart.
- Saving settings preserves existing protection records. Confirmed cleanup deletes them; a subsequent experiment can process that key again.
- An isolated browser flow enabled protection and replayed one capture twice: the dashboard reported one demo action and one skipped duplicate, while both attempts returned HTTP 200. The history distinguished the new action from duplicate acknowledgement.
- The mobile screenshot was inspected at 375 px; no document-level horizontal overflow or browser JavaScript errors were reported. Browser data was separate from the application's data directory and the temporary server/browser were closed after checks.
