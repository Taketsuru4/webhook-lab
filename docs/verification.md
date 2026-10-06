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
