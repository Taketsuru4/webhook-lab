// Browser-only simulation. No HTTP delivery, server, database or credentials are involved.
export function createDemoApi({
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const labs = [];
  const captures = [];
  const runs = [];
  const jobs = [];
  const uuid = () => crypto.randomUUID();
  const now = () => new Date().toISOString();
  const active = (job) => ['queued', 'running', 'waiting_retry'].includes(job.state);
  const bytes = (body) => new TextEncoder().encode(body);
  const base64 = (body) =>
    btoa(Array.from(bytes(body), (byte) => String.fromCharCode(byte)).join(''));
  const fail = (message) => {
    throw new Error(message);
  };
  function addLab(name) {
    if (labs.length >= 10) fail('Demo limit: 10 labs. Reload to reset the playground.');
    if (!name?.trim() || name.trim().length > 60) fail('Give your lab a name (1–60 characters).');
    const lab = {
      id: uuid(),
      name: name.trim(),
      token: uuid(),
      created_at: now(),
      config: { fail_first: 0, delay_ms: 0, idempotency_enabled: false, received_count: 0 },
      effects: [],
      duplicates: 0,
      conflicts: 0,
    };
    labs.push(lab);
    return viewLab(lab);
  }
  const viewLab = (lab) => ({
    id: lab.id,
    name: lab.name,
    token: lab.token,
    created_at: lab.created_at,
    endpoint: `/demo-hooks/${lab.token}`,
  });
  const receiver = (lab) => ({
    ...lab.config,
    processed_count: lab.effects.length,
    deduplicated_count: lab.duplicates,
    conflict_count: lab.conflicts,
  });
  function capture(lab, body) {
    if (captures.length >= 200)
      fail('Demo limit: 200 captures. Clear an inbox or reload to reset.');
    if (bytes(body).length > 256 * 1024) fail('Body limit: 256 KiB.');
    let payload = null,
      is_json = false;
    try {
      payload = JSON.parse(body);
      is_json = true;
    } catch {
      /* Malformed bodies can still be inspected. */
    }
    const record = {
      id: uuid(),
      lab_id: lab.id,
      event_id: typeof payload?.id === 'string' ? payload.id : null,
      event_type: typeof payload?.type === 'string' ? payload.type : 'untyped',
      headers: { 'content-type': 'application/json' },
      raw_body: body,
      raw_body_base64: base64(body),
      size_bytes: bytes(body).length,
      content_type: 'application/json',
      payload,
      is_json,
      received_at: now(),
    };
    captures.unshift(record);
    return { accepted: true, request_id: record.id };
  }
  function idle(lab) {
    if (
      runs.some((run) => run.lab_id === lab.id && run.state === 'running') ||
      jobs.some((job) => job.lab_id === lab.id && active(job))
    )
      fail('Wait for the current experiment to finish or cancel its retries.');
  }
  async function attempt(lab, record, timeout, job) {
    if (runs.length >= 300) fail('Demo history limit reached. Clear an inbox or reload.');
    const run = {
      id: uuid(),
      lab_id: lab.id,
      capture_id: record.id,
      state: 'running',
      timeout_ms: timeout,
      started_at: now(),
      target_mode: 'mock',
      target_url: 'Browser mock (simulation)',
      response_body: '',
      delivery_job_id: job?.id ?? null,
      attempt_number: job?.attempt_count ?? null,
    };
    runs.unshift(run);
    const config = { ...lab.config };
    const received = ++lab.config.received_count;
    let status = received <= config.fail_first ? 500 : 200;
    let outcome = 'failed';
    if (status === 200) {
      const key = config.idempotency_enabled && record.event_id;
      const effect = key && lab.effects.find((item) => item.key === key);
      if (effect) {
        if (effect.body !== record.raw_body) {
          status = 409;
          outcome = 'conflict';
          lab.conflicts++;
        } else {
          outcome = 'duplicate';
          lab.duplicates++;
        }
      } else {
        outcome = config.idempotency_enabled && !key ? 'processed_without_key' : 'processed';
        lab.effects.push({ key: key || null, body: record.raw_body });
      }
    }
    await pause(Math.min(config.delay_ms, timeout));
    Object.assign(run, {
      state: config.delay_ms > timeout ? 'timeout' : status < 300 ? 'succeeded' : 'failed',
      http_status: config.delay_ms > timeout ? null : status,
      duration_ms: Math.min(config.delay_ms, timeout),
      finished_at: now(),
      response_body:
        config.delay_ms > timeout
          ? ''
          : JSON.stringify({ simulated: true, outcome, processed_count: lab.effects.length }),
      error:
        config.delay_ms > timeout
          ? 'Simulated timeout: the browser mock may already have processed the event.'
          : null,
      response_truncated: false,
    });
    return run;
  }
  async function work(lab, record, job) {
    try {
      while (active(job)) {
        await pause(30);
        if (!active(job)) return;
        job.state = 'running';
        job.attempt_count++;
        const result = await attempt(lab, record, job.timeout_ms, job);
        if (job.cancel_requested) job.state = 'cancelled';
        else if (result.state === 'succeeded') job.state = 'succeeded';
        else if (result.http_status === 409 || job.attempt_count >= job.max_attempts)
          job.state = 'failed';
        else {
          job.state = 'waiting_retry';
          const wait = Math.min(5000, job.retry_delay_ms * 2 ** (job.attempt_count - 1));
          job.next_attempt_at = new Date(Date.now() + wait).toISOString();
          await pause(wait);
          continue;
        }
        job.finished_at = now();
      }
    } catch (error) {
      job.state = 'failed';
      job.last_error = error.message;
      job.finished_at = now();
    }
  }
  const first = addLab('Payment playground');
  const lab = labs[0];
  for (const body of [
    '{"id":"evt_demo_001","type":"payment.succeeded","data":{"amount":4900,"currency":"eur"}}',
    '{"id":"evt_demo_001","type":"payment.succeeded","data":{"amount":4900,"currency":"eur"}}',
    '{"id":"evt_demo_002","type":"order.created","data":{"order_id":"demo_order_42"}}',
  ])
    capture(lab, body);
  async function route(path, options = {}) {
    options.signal?.throwIfAborted();
    const url = new URL(path, 'https://demo.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = options.method ?? 'GET';
    let body = {};
    if (options.body && parts[0] !== 'hooks') body = JSON.parse(options.body);
    if (parts[0] === 'hooks') {
      const lab = labs.find((item) => item.token === parts[1]);
      if (!lab) fail('Lab not found.');
      return capture(lab, String(options.body || ''));
    }
    if (url.pathname === '/api/labs')
      return method === 'POST' ? addLab(body.name) : { labs: labs.map(viewLab), database: 'demo' };
    const lab = labs.find((item) => item.id === parts[2]);
    if (!lab) fail('Lab not found.');
    const all = captures.filter((record) => record.lab_id === lab.id);
    const pending = jobs.find((job) => job.lab_id === lab.id && active(job));
    if (parts[3] === 'stats') {
      const ids = all.filter((record) => record.event_id).map((record) => record.event_id);
      const recent = all.filter((record) => Date.now() - new Date(record.received_at) < 3600000);
      return {
        total: all.length,
        duplicates: ids.length - new Set(ids).size,
        bytes: all.reduce((n, r) => n + r.size_bytes, 0),
        last_hour: recent.length,
        traffic: Array.from({ length: 12 }, (_, bucket) => ({
          bucket,
          count: recent.filter(
            (r) =>
              Math.min(11, Math.floor((Date.now() - new Date(r.received_at)) / 300000)) ===
              11 - bucket,
          ).length,
        })),
      };
    }
    if (parts[3] === 'delivery-target') {
      if (method === 'PUT' && body.mode !== 'mock')
        fail('Use the local app to replay to your own receiver.');
      return { mode: 'mock', url: null };
    }
    if (parts[3] === 'receiver') {
      if (method === 'PUT') {
        idle(lab);
        if (
          !Number.isInteger(body.fail_first) ||
          body.fail_first < 0 ||
          body.fail_first > 10 ||
          !Number.isInteger(body.delay_ms) ||
          body.delay_ms < 0 ||
          body.delay_ms > 5000
        )
          fail('Invalid receiver settings.');
        Object.assign(lab.config, { ...body, received_count: 0 });
      }
      return receiver(lab);
    }
    if (parts[3] === 'requests' && !parts[4]) {
      if (method === 'DELETE') {
        idle(lab);
        if (body.confirm !== lab.name) fail('Type the lab name to confirm.');
        for (const array of [captures, runs, jobs])
          for (let i = array.length - 1; i >= 0; i--)
            if (array[i].lab_id === lab.id) array.splice(i, 1);
        lab.effects = [];
        lab.duplicates = 0;
        lab.conflicts = 0;
        lab.config.received_count = 0;
        return { cleared: all.length };
      }
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const filter = url.searchParams.get('filter');
      const offset = Number(url.searchParams.get('offset') || 0);
      const list = all
        .map((record) => ({
          ...record,
          occurrences: record.event_id
            ? all.filter((r) => r.event_id === record.event_id).length
            : 1,
        }))
        .filter(
          (record) =>
            [record.event_type, record.event_id, record.id].some((text) =>
              text?.toLowerCase().includes(q),
            ) &&
            (filter !== 'duplicates' || record.occurrences > 1) &&
            (filter !== 'untyped' || record.event_type === 'untyped'),
        );
      return { requests: list.slice(offset, offset + 50), total: list.length, offset };
    }
    const record = all.find((record) => record.id === parts[4]);
    if (!record) fail('Request not found.');
    if (!parts[5]) return record;
    if (parts[5] === 'replays') {
      if (method === 'POST') {
        idle(lab);
        return attempt(lab, record, Number(body.timeout_ms || 2000));
      }
      const list = runs.filter((run) => run.capture_id === record.id && !run.delivery_job_id);
      const offset = Number(url.searchParams.get('offset') || 0);
      return { runs: list.slice(offset, offset + 20), total: list.length, offset };
    }
    if (parts[5] === 'jobs') {
      if (parts[7] === 'cancel') {
        const job = jobs.find((job) => job.id === parts[6] && job.capture_id === record.id);
        if (!job) fail('Job not found.');
        if (active(job)) {
          job.cancel_requested = true;
          if (job.state !== 'running') job.state = 'cancelled';
        }
        return job;
      }
      if (method === 'POST') {
        idle(lab);
        if (jobs.length >= 100) fail('Demo limit: 100 jobs. Clear an inbox or reload.');
        const job = {
          id: uuid(),
          lab_id: lab.id,
          capture_id: record.id,
          state: 'queued',
          attempt_count: 0,
          max_attempts: Number(body.max_attempts || 3),
          timeout_ms: Number(body.timeout_ms || 2000),
          retry_delay_ms: Number(body.retry_delay_ms || 500),
          created_at: now(),
          cancel_requested: false,
          target_mode: 'mock',
          target_url: null,
        };
        jobs.unshift(job);
        void work(lab, record, job);
        return job;
      }
      const list = jobs
        .filter((job) => job.capture_id === record.id)
        .map((job) => ({
          ...job,
          attempts: runs.filter((run) => run.delivery_job_id === job.id).toReversed(),
        }));
      const offset = Number(url.searchParams.get('offset') || 0);
      return {
        jobs: list.slice(offset, offset + 10),
        total: list.length,
        offset,
        active_job: pending || null,
      };
    }
    fail('This action is available in the local application.');
  }
  return {
    firstLab: first,
    api: async (path, options) => structuredClone(await route(path, options)),
  };
}
