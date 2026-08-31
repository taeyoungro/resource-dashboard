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
// Why memory rather than a bucket
// -------------------------------
// The durable half is already durable: the marker is in S3 and the sweep finds it whatever happens
// here. What this adds is the REASON, and losing it on a restart costs a sentence rather than a
// fact - the row still says a task did not finish. Writing it to S3 would make the dashboard an
// author of bucket state, which is the thing this tier is built not to be.
//
// Why the retry is a person pressing a button
// -------------------------------------------
// Re-putting the object automatically would run forever on a deterministic failure: the task fails,
// the object is re-put, the rule fires, the task fails. A person reads the reason and decides
// whether re-running is the right answer at all - often something has to be fixed first, and
// sometimes no number of attempts clears it.

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

export class TaskFailureError extends Error {}

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
export function makeTaskFailures({ limit = MAX_REPORTS } = {}) {
  const byKey = new Map();

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
      return entry;
    },

    /** Mark one as retried. Returns the entry, or null when nothing knows about it. */
    retried(id, reviewer, now) {
      const entry = byKey.get(id);
      if (!entry) return null;
      const next = { ...entry, retried_at: now, retried_by: reviewer };
      byKey.set(id, next);
      return next;
    },

    get(id) {
      return byKey.get(id) ?? null;
    },

    list() {
      return [...byKey.values()].reverse();
    },
  };
}
