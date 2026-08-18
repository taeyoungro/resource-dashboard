// Work that outlives the request that asked for it.
//
// The analysis was a single POST that called the model once per batch, in sequence, with no bound
// on how long that took. Twenty-one candidates is three batches, each generating thousands of
// tokens of Korean prose, and the whole thing ran for minutes inside one HTTP request. Whatever
// terminates TLS in front of the dashboard gave up first:
//
//     504 Gateway Time-out
//
// Two things were wrong and only one of them was the timeout. The proxy's limit can be raised, but
// the request still holds a connection open for minutes and still says nothing while it does; and
// when the proxy DID give up, the browser saw a failure while the server carried on calling Bedrock
// for an answer nobody was waiting for. The money was spent and the result was dropped on the floor.
//
// So the run is detached from the request. Asking starts it and returns what is already known - the
// rule findings, which are deterministic and cost nothing - and the page polls for the model half.
// Every request is short. The result is kept, so a poll that arrives after a browser reload still
// finds it, and a run whose asker walked away finishes and is there for the next one.
//
// In memory, deliberately. Persisting it would mean a bucket write per run and a lifecycle to argue
// about, and the thing being stored is a model's opinion that can be asked for again. A restart
// loses what was in flight, and the poll says so rather than hanging.

/** How a run can end. `running` is the only state with no answer attached. */
export const RUNNING = 'running';
export const DONE = 'done';
export const FAILED = 'failed';

/**
 * The runs this process has going and the ones it finished recently.
 *
 * `now` and the caps are injected so the eviction rules are testable without waiting.
 */
export function runStore({ now = () => Date.now(), ttlMs = 30 * 60_000, max = 8 } = {}) {
  /** planId -> entry. One run per plan: a second ask while one is in flight joins the first. */
  const runs = new Map();

  function evict() {
    // Age first, then count. A finished run past its age is gone whatever the size, and a running
    // one is never evicted - it holds the only reference to work that is still burning tokens.
    const deadline = now() - ttlMs;
    for (const [id, entry] of runs) {
      if (entry.state !== RUNNING && entry.finishedAt < deadline) runs.delete(id);
    }
    if (runs.size <= max) return;
    const finished = [...runs.entries()]
      .filter(([, e]) => e.state !== RUNNING)
      .sort((a, b) => a[1].finishedAt - b[1].finishedAt);
    for (const [id] of finished.slice(0, runs.size - max)) runs.delete(id);
  }

  return {
    /**
     * The run for this plan, if it is about the same assessment.
     *
     * `key` is the assessment digest. A run about an older assessment is not this plan's answer
     * even though it is under this plan's id - the assessment can be replaced while a run is in
     * flight - so it is reported as absent and a fresh one replaces it.
     */
    get(planId, key) {
      const entry = runs.get(planId);
      if (!entry || (key != null && entry.key !== key)) return null;
      return entry;
    },

    /**
     * Start a run, or join the one already going.
     *
     * `task` is called with a progress reporter and must resolve to the finished answer. It is NOT
     * awaited here: that is the whole point. Its rejection is captured onto the entry, so a failure
     * shows up on the next poll instead of as an unhandled rejection that takes the process with it.
     */
    start(planId, key, task) {
      const existing = this.get(planId, key);
      if (existing && existing.state === RUNNING) return existing;

      const entry = {
        planId,
        key,
        state: RUNNING,
        startedAt: now(),
        finishedAt: null,
        // What the caller can show while it waits. Filled by the task through report().
        progress: { batches: null, done: 0 },
        answer: null,
        error: null,
      };
      runs.set(planId, entry);
      evict();

      const report = (progress) => {
        if (entry.state === RUNNING) entry.progress = { ...entry.progress, ...progress };
      };

      Promise.resolve()
        .then(() => task(report))
        .then((answer) => {
          entry.answer = answer;
          entry.state = DONE;
        })
        .catch((error) => {
          entry.error = error?.message ?? String(error);
          entry.state = FAILED;
        })
        .finally(() => {
          entry.finishedAt = now();
        });

      return entry;
    },

    /** How long a run has been going, or how long it took. Milliseconds. */
    elapsed(entry) {
      return (entry.finishedAt ?? now()) - entry.startedAt;
    },

    /** For the health line and the tests. */
    size() {
      return runs.size;
    },
  };
}

/** The entry as the page receives it. Never the task, never the raw error object. */
export function asJson(entry, elapsedMs) {
  return {
    state: entry.state,
    started_at: new Date(entry.startedAt).toISOString(),
    elapsed_ms: elapsedMs,
    // null batches means the run has not worked out how many there are yet.
    progress: entry.progress,
    error: entry.error,
  };
}
