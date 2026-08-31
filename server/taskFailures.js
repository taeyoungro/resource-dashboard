// What a container's failure was, and what re-running it means.
//
// A container that fails leaves its marker in the bucket. That is the whole signal and it says only
// THAT: a plan lock timeout and a task killed before it ran a line produce the same object. The
// sentence telling them apart - stopCode, exitCode, stoppedReason - lives in the ECS task state
// change event, which nothing here can see.
//
//   무엇인가   한 컨테이너 실행이 왜 나빴는가. 마커가 말할 수 없는 세 가지 — 종료 코드, 중단 코드,
//              중단 사유 — 와 그 작업을 시작시킨 객체
//   어디 있나  이 프로세스의 메모리. 아래 makeTaskFailures 의 저장소이고, 다시 시작하면 사라진다
//   누가 쓰나  opt-SolutionTaskFailureNotifier 하나. EventBridge 가 건네준 사건을 그대로 옮긴다
//   누가 읽나  마커 화면(어느 마커가 왜 실패했는가)과 재실행 경로(무엇을 다시 넣을 것인가)
//
// Why a file on this host rather than a bucket
// --------------------------------------------
// The durable half is already durable: the marker is in S3 and the sweep finds it whatever happens
// here. What this adds is the REASON, so losing it costs a sentence rather than a fact - the row
// still says a task did not finish, it just stops saying why.
//
// A restart used to lose it, and restarts are not rare: every deploy is one. So it is written to
// the directory systemd makes for this service, and read back at startup.
//
// NOT to S3, and the reason has moved since this file was written. It used to be "the dashboard
// must not author bucket state", which is no longer literally true - this tier writes approval
// markers, and re-puts objects to re-run a task. What is still true is narrower and is the thing
// worth keeping: it cannot fabricate or erase a CONTAINER's record of what it did. A dashboard-owned
// note in a dashboard-owned place does not touch that. What decided it instead is the bucket: the
// marker bucket has versioning and lifecycle expiry deliberately OFF, so an object meant to be
// overwritten again and again would be the only one there playing by different rules.
//
// What that gives up, stated: the host. An instance replaced loses these reasons, exactly as it
// loses the journal. That is one problem, not two, and it is fixed by shipping host state off the
// box rather than by making this one record special.
//
// Why the retry is a person pressing a button
// -------------------------------------------
// Re-putting the object automatically would run forever on a deterministic failure: the task fails,
// the object is re-put, the rule fires, the task fails. A person reads the reason and decides
// whether re-running is the right answer at all - often something has to be fixed first, and
// sometimes no number of attempts clears it.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The marker prefixes whose objects start a task when they are written. */
const MARKER_PREFIXES = ['inspector/', 'applier/', 'impact/', 'inline_writer/'];

/** The one object in the state bucket whose write starts a task.
 *
 * The impact querier is the odd one of the four: its rule watches the STATE bucket for the plan
 * manifest the inspector writes at the end of an inspection, so re-running it means re-putting that
 * object rather than a marker.
 *
 * Anchored on the whole key, and that is the assertion that matters most in this file. `plan/`
 * also holds tfplan, plan.json, plan.txt and changes.sha256 - the objects an approval BINDS to - and
 * a dashboard that could rewrite those could show one plan and apply another. assess.json is a
 * manifest that says "assess this plan" and binds nothing.
 */
const ASSESS_KEY = /^\d{12}\/[\w+=,.@-]{1,128}\/plan\/assess\.json$/;

/** <prefix><name>.json with no slash in the name - the shape every marker key has. */
const MARKER_KEY = /^[a-z_]+\/[^/]+\.json$/;

const MAX_TEXT = 512;
const MAX_REPORTS = 200;

/** The file's own version. A shape this does not recognise is dropped, not guessed at. */
const FILE_SCHEMA = 1;

export class TaskFailureError extends Error {}

/**
 * One stored row, or null if the file has something this cannot render.
 *
 * Checked even though this process wrote it. Not because the file is hostile - anyone who can edit
 * it already owns the host - but because a truncated write, a half-full disk or a version of this
 * code that wrote a different shape must cost one row rather than the startup. A dashboard that
 * refuses to boot over its own scratch file is worse than one that forgets a sentence.
 */
function storedEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const lastSeen = Number.isFinite(raw.last_seen) ? raw.last_seen : null;
  if (!id || lastSeen === null) return null;
  const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    id,
    task_arn: str(raw.task_arn) ?? id,
    task_definition_arn: str(raw.task_definition_arn),
    cluster_arn: str(raw.cluster_arn),
    stop_code: str(raw.stop_code),
    stopped_reason: str(raw.stopped_reason),
    stopped_at: str(raw.stopped_at),
    exit_codes: Array.isArray(raw.exit_codes) ? raw.exit_codes.filter(Number.isInteger) : [],
    marker_bucket: str(raw.marker_bucket),
    marker_key: str(raw.marker_key),
    first_seen: Number.isFinite(raw.first_seen) ? raw.first_seen : lastSeen,
    last_seen: lastSeen,
    attempts: Number.isInteger(raw.attempts) && raw.attempts > 0 ? raw.attempts : 1,
    retried_at: Number.isFinite(raw.retried_at) ? raw.retried_at : null,
    retried_by: str(raw.retried_by),
  };
}

function text(value, field, { required = true, max = MAX_TEXT } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TaskFailureError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new TaskFailureError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new TaskFailureError(`${field} is required`);
    return null;
  }
  if (trimmed.length > max) throw new TaskFailureError(`${field} is longer than ${max}`);
  return trimmed;
}

/**
 * One report from the notifier, checked.
 *
 * Checked rather than trusted even though the ingest key authorises it: the key says the caller is
 * a machine of ours, not that the body is a shape this code can render. Everything optional is
 * optional because the event legitimately omits it - a task that never ran has no exit code, and a
 * task started by hand has no marker at all.
 */
export function parseReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TaskFailureError('the report is not an object');
  }
  const codes = Array.isArray(body.exit_codes) ? body.exit_codes : [];
  return {
    task_arn: text(body.task_arn, 'task_arn'),
    task_definition_arn: text(body.task_definition_arn, 'task_definition_arn', { required: false }),
    cluster_arn: text(body.cluster_arn, 'cluster_arn', { required: false }),
    // The three a marker cannot say. Each is optional on its own and the report is worthless
    // without all of them, which is a judgement for the reader rather than a refusal here.
    stop_code: text(body.stop_code, 'stop_code', { required: false }),
    stopped_reason: text(body.stopped_reason, 'stopped_reason', { required: false }),
    stopped_at: text(body.stopped_at, 'stopped_at', { required: false }),
    exit_codes: codes.filter((c) => Number.isInteger(c)),
    // What to re-put. Null is legitimate - a task nobody started from an object has nothing to
    // re-put - and the row then shows the failure without a retry.
    marker_bucket: text(body.marker_bucket, 'marker_bucket', { required: false }),
    marker_key: text(body.marker_key, 'marker_key', { required: false }),
  };
}

/**
 * The object this report says to re-put, or null if there is nothing retryable in it.
 *
 * THE FENCE IN THE CODE. The other one is IAM: the dashboard's role holds s3:PutObject on exactly
 * these prefixes and on that one key, so a defect here cannot reach an object the role does not
 * name. Both exist because they fail differently - IAM refuses the call, this refuses to make it,
 * and only this one can say why on a screen.
 *
 * The bucket is compared against the CONFIGURED names rather than accepted from the report. The
 * report arrives over the network from a function whose environment somebody else deploys; the two
 * bucket names are the ones this process was started with.
 */
export function retryTarget(report, config) {
  const bucket = report?.marker_bucket;
  const key = report?.marker_key;
  if (!bucket || !key) return null;
  if (key.includes('..')) return null;

  if (bucket === config.markerBucket) {
    if (!MARKER_KEY.test(key)) return null;
    if (!MARKER_PREFIXES.some((prefix) => key.startsWith(prefix))) return null;
    return { bucket, key };
  }
  if (bucket === config.stateBucket) {
    return ASSESS_KEY.test(key) ? { bucket, key } : null;
  }
  return null;
}

/**
 * What has failed lately, newest first.
 *
 * Keyed by marker key so a task retried three times leaves one row rather than three: the question
 * a person asks is "what is wrong with this request", and three copies of one answer is noise. A
 * report with no marker is kept under its task arn, which is unique per attempt - those really are
 * separate failures with nothing joining them.
 */
export function makeTaskFailures({ limit = MAX_REPORTS, dir = null, log = null } = {}) {
  const byKey = new Map();
  // Null when the unit provisioned nowhere to write, which is the case in tests and in a developer's
  // checkout. Everything below then behaves exactly as it did before any of this existed.
  const file = dir ? join(dir, 'task-failures.json') : null;
  const tmp = file ? `${file}.tmp` : null;

  /** Read what the last run left, once. A file that is not there is the normal first boot. */
  function load() {
    if (!file) return;
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') log?.warn?.('task failures could not be read: %s', err.message);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log?.warn?.('task failures file is not JSON, starting empty: %s', err.message);
      return;
    }
    if (parsed?.schema !== FILE_SCHEMA || !Array.isArray(parsed.entries)) {
      log?.warn?.('task failures file is schema %s, not %s - starting empty',
                  parsed?.schema, FILE_SCHEMA);
      return;
    }
    // Oldest first, so the Map's insertion order comes out as the last-seen order that list()
    // reverses. Sorted rather than trusted: the file is written in that order, and a read that
    // depends on the writer having got it right is a read that breaks quietly when it did not.
    const entries = parsed.entries.map(storedEntry).filter(Boolean)
      .sort((a, b) => a.last_seen - b.last_seen);
    for (const entry of entries.slice(-limit)) byKey.set(entry.id, entry);
    log?.info?.('task failures restored %d of %d from %s',
                byKey.size, parsed.entries.length, file);
  }

  /**
   * Write what is held, atomically, and never let a failure reach the caller.
   *
   * Temp file then rename, because the alternative - truncating the real file and writing into it -
   * leaves half a file behind exactly when the machine is having the kind of day that makes this
   * record worth having.
   *
   * A failed write is logged and swallowed. The report has already been accepted into memory and
   * the marker is already in S3, so refusing the notifier over a full disk would turn a lost
   * sentence into a lost fact and fill the dead-letter queue doing it.
   */
  function save() {
    if (!file) return;
    try {
      writeFileSync(tmp, `${JSON.stringify({
        schema: FILE_SCHEMA, entries: [...byKey.values()],
      })}\n`);
      renameSync(tmp, file);
    } catch (err) {
      log?.warn?.('task failures could not be saved to %s: %s', file, err.message);
    }
  }

  load();

  return {
    record(report, now) {
      const id = report.marker_key ?? report.task_arn;
      const previous = byKey.get(id);
      const entry = {
        ...report,
        id,
        first_seen: previous?.first_seen ?? now,
        last_seen: now,
        // How many times this same request has come back. A number climbing here is a retry loop
        // somebody is driving by hand, which is worth seeing before they drive it again.
        attempts: (previous?.attempts ?? 0) + 1,
        // Set by the retry route, so the row can say a retry was already sent and by whom.
        retried_at: previous?.retried_at ?? null,
        retried_by: previous?.retried_by ?? null,
      };
      // Delete first so the insertion order is the last-seen order.
      byKey.delete(id);
      byKey.set(id, entry);
      while (byKey.size > limit) byKey.delete(byKey.keys().next().value);
      save();
      return entry;
    },

    /** Mark one as retried. Returns the entry, or null when nothing knows about it. */
    retried(id, reviewer, now) {
      const entry = byKey.get(id);
      if (!entry) return null;
      const next = { ...entry, retried_at: now, retried_by: reviewer };
      byKey.set(id, next);
      // Saved too. Who pressed it and when is the half of this record a person is answerable for,
      // and losing it to a restart is how the same failure gets retried twice by two people.
      save();
      return next;
    },

    get(id) {
      return byKey.get(id) ?? null;
    },

    /**
     * When a task started from this object was last reported stopped, in epoch milliseconds, or
     * null if nothing has been reported about it.
     *
     *   무엇인가   이 마커로 시작된 작업이 언제 죽었나. 「죽었는가」가 아니라 「언제」인 것이
     *              요점이다 — 부르는 쪽이 그것을 마커의 마지막 쓰기와 견주기 때문이다
     *   어디 있나  이 저장소의 항목. stopped_at 은 ECS 가 말한 시각이고, last_seen 은 이 프로세스가
     *              보고를 받은 시각이다
     *   누가 쓰나  record() 하나. opt-SolutionTaskFailureNotifier 가 보낸 것을 그대로 옮긴다
     *   누가 읽나  sweep.js 의 classify - 마커가 실행 중인지 실패인지 정하는 곳
     *
     * ECS's own timestamp is preferred over ours: the report can be delayed by a retry or by the
     * dashboard restarting, and what the caller is asking is when the TASK stopped, not when we
     * heard. last_seen is the fallback for an event that carried no stoppedAt or an unparseable one.
     */
    stoppedAt(key) {
      const entry = byKey.get(key);
      if (!entry) return null;
      const reported = entry.stopped_at ? Date.parse(entry.stopped_at) : NaN;
      return Number.isFinite(reported) ? reported : entry.last_seen;
    },

    list() {
      return [...byKey.values()].reverse();
    },
  };
}
