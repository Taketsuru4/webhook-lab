export default function VersionGuide() {
  return (
    <section className="guide-card wide version-guide" aria-label="Versions and limits">
      <span className="eyebrow">WHAT YOU CAN USE TODAY</span>
      <h2>Demo vs local app</h2>
      <p>
        The browser demo simulates the workflow. The local app captures real HTTP requests, keeps a
        database and tests your own webhook handler.
      </p>
      <table className="capability-table">
        <caption>Available features in each version</caption>
        <thead>
          <tr>
            <th scope="col">Feature</th>
            <th scope="col">Browser demo</th>
            <th scope="col">Local app</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Labs, inbox & inspection</th>
            <td>Synthetic captures and editable sample events</td>
            <td>Real POST capture, original bytes, headers, search, filters and statistics</td>
          </tr>
          <tr>
            <th scope="row">Saved data</th>
            <td>Tab memory; reload resets everything</td>
            <td>PostgreSQL persistence across restarts</td>
          </tr>
          <tr>
            <th scope="row">Replay</th>
            <td>Simulated mock responses</td>
            <td>Real HTTP to the built-in mock or your selected localhost receiver</td>
          </tr>
          <tr>
            <th scope="row">Automatic retries</th>
            <td>Simulated timers while the tab stays open</td>
            <td>Persisted jobs, backoff, cancellation and restart recovery</td>
          </tr>
          <tr>
            <th scope="row">Idempotency experiment</th>
            <td>Simulated duplicate/action counters</td>
            <td>Transactional duplicate protection in the built-in mock</td>
          </tr>
        </tbody>
      </table>
      <h3>Limits of the local app</h3>
      <ul className="version-limits">
        <li>
          Single user on your computer. No login, permissions or shared team workspace. Keep its
          management API on localhost.
        </li>
        <li>
          No built-in public capture URL. External internet services cannot call your localhost
          endpoint directly.
        </li>
        <li>
          Custom receivers accept HTTP localhost or 127.0.0.1 with an explicit port. HTTPS, IPv6 and
          internet destinations are not supported.
        </li>
        <li>
          Mock duplicate protection does not protect your own API. Your handler must implement its
          own idempotency.
        </li>
        <li>
          Provider signature verification is not implemented. Captured credentials and provider
          signature headers are excluded from replay.
        </li>
      </ul>
      <a
        className="button secondary"
        href="https://github.com/Taketsuru4/webhook-lab"
        target="_blank"
        rel="noreferrer"
      >
        Install the local app from GitHub
      </a>
    </section>
  );
}
