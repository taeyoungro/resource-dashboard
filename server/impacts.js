// Impact assessments this process was handed, so the page does not fetch them.
//
// The querier pushes the assessment when it finishes. That is the delivery path, not an
// accelerator on top of one: the alternative was a GetObject per open plan on every sweep, which
// costs a call for every plan whether or not anybody is looking at it.
//
// It is still not authoritative, and the distinction survives intact:
//
//   presence    S3 decides. impact.json in the plan prefix is the record, and the impact/ marker
//               says an assessment is outstanding. A push that never arrives changes neither
//   contents    this cache, and a GetObject only for what is not in it
//
// So losing every push costs latency and one call per plan somebody actually opens. It cannot
// produce a wrong answer, which is what allows the querier to post once and never retry.
//
// Keyed by request id rather than by plan id, deliberately. A plan prefix is overwritten in place
// by every new inspection, so one plan id has many assessments over its life and only the one
// belonging to the CURRENT request.json is the one on screen. Keyed by plan id, a stale push would
// overwrite a fresh one and the page would show an assessment of a plan that no longer exists.
//
// Bounded. An assessment carries resource ARNs, so a wide grant on a busy account is far larger
// than a marker body - the default holds fewer entries for that reason, and eviction costs one
// GetObject.

const REQUEST_ID = /^\d{12}-[0-9a-f]{16}$/;
const ACCOUNT_ID = /^\d{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export class ImpactError extends Error {}

function text(body, field, pattern, { required = true } = {}) {
  const value = body?.[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw new ImpactError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new ImpactError(`${field} must be a string`);
  if (pattern && !pattern.test(value)) {
    throw new ImpactError(`${field} is not the shape it must be: ${value.slice(0, 64)}`);
  }
  return value;
}

/** Validate one pushed assessment. Everything here arrives from a machine holding the ingest key.
 *
 * Rejected rather than coerced. The ingest key opens exactly one route and this is what that route
 * accepts; a body that does not fit is a version mismatch between the two, and reading it on a
 * best-effort basis would mean the page displaying fields that may not mean what they are read as.
 */
export function parse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ImpactError('the body must be an object');
  }
  if (body.schema !== 1) {
    throw new ImpactError(`schema is ${JSON.stringify(body.schema)}, and this server understands 1`);
  }
  if (body.kind !== 'impact') {
    throw new ImpactError(`kind is ${JSON.stringify(body.kind)}, not "impact"`);
  }

  const plan = body.plan;
  if (!plan || typeof plan !== 'object') throw new ImpactError('plan is required');

  const summary = body.summary;
  if (!summary || typeof summary !== 'object') throw new ImpactError('summary is required');

  // Present unless it was too large for a request body. Absent is not an error and not a gap: the
  // object is in the bucket and the fallback read is what it is for.
  const omitted = body.body_omitted === true;
  const impact = body.impact ?? null;
  if (!omitted && (!impact || typeof impact !== 'object')) {
    throw new ImpactError('impact is required unless body_omitted is true');
  }

  return {
    request_id: text(body, 'request_id', REQUEST_ID),
    account_id: text(body, 'account_id', ACCOUNT_ID),
    resource: text(body, 'resource'),
    impact_sha256: text(body, 'impact_sha256', DIGEST),
    assessed_at: text(body, 'assessed_at', null, { required: false }),
    plan: {
      bucket: text(plan, 'bucket'),
      prefix: text(plan, 'prefix'),
    },
    summary,
    impact: omitted ? null : impact,
    body_omitted: omitted,
    received_at: new Date().toISOString(),
  };
}

export function makeImpacts({ limit = 50 } = {}) {
  const entries = new Map();

  /** Remember one. Callers pass what they were handed - nothing here fetches. */
  function put(entry) {
    // Delete before set so insertion order is recency, which is what makes eviction "oldest".
    entries.delete(entry.request_id);
    entries.set(entry.request_id, entry);
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }

  /** The entry, or null. Null means read the object - it does not mean there is no assessment. */
  function get(requestId) {
    return entries.get(requestId) ?? null;
  }

  function has(requestId) {
    return entries.has(requestId);
  }

  /** Just the digest and the counts, for the plan list. Never the resource ARNs. */
  function summaries() {
    const out = {};
    for (const [requestId, entry] of entries) {
      out[requestId] = {
        impact_sha256: entry.impact_sha256,
        assessed_at: entry.assessed_at,
        body_omitted: entry.body_omitted,
        summary: entry.summary,
      };
    }
    return out;
  }

  return { put, get, has, summaries, size: () => entries.size };
}
