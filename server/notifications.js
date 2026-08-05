// What the listener announces when it dispatches an inspection.
//
// The rule this whole path obeys, and the reason it is safe to add at all:
//
//     **An announcement is not a state.**
//
// Nothing on this page believes a notification. The buckets are still swept and the sweep is still
// the only thing that decides what exists, what is running, and what awaits a decision. A
// notification does two things and neither of them is authority:
//
//   1. it tells the dashboard that work just started, so the sweep can run now rather than at the
//      next interval - the difference between a page that is live and one that is a day old
//   2. it feeds a panel that says what happened recently, which the buckets cannot answer at all,
//      because a completed inspection deletes its marker and leaves the plan prefix looking the
//      same as it would have if nothing had ever run
//
// That framing is what bounds the damage from the ingest key. Somebody holding it can post noise
// into the panel. They cannot make a plan appear, cannot make one disappear, cannot mark anything
// approved, and cannot stop the sweep from contradicting them on the next pass.
//
// Stored in memory and never written anywhere. A restart empties the panel and the sweep repopulates
// everything that matters, because everything that matters was in S3 the whole time.

const SCHEMA = 1;

// The listener's request id: <12 digit account>-<16 hex>. The same shape the marker key carries.
const REQUEST_ID = /^\d{12}-[0-9a-f]{16}$/;
const ACCOUNT = /^\d{12}$/;
const RESOURCE = /^[\w+=,.@-]{1,128}$/;

// Which container the announcement is about. Only the listener posts today; applier and
// inline_writer are listed so the shape does not have to change when they do.
const KINDS = ['inspector', 'applier', 'inline_writer'];

const MAX_EVENT_NAMES = 20;
const MAX_TEXT = 256;

export class NotificationError extends Error {}

function text(value, field, pattern, { required = true, max = MAX_TEXT } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new NotificationError(`${field} is missing`);
    return null;
  }
  if (typeof value !== 'string') throw new NotificationError(`${field} is not a string`);
  if (value.length > max) throw new NotificationError(`${field} is longer than ${max}`);
  if (pattern && !pattern.test(value)) {
    throw new NotificationError(`${field} is not the shape it must be`);
  }
  return value;
}

/** The announcement, reduced to the fields the panel shows. Throws on anything else.
 *
 * Validated rather than trusted even though the caller had to present a key. The key says the
 * caller reached this box with a secret; it does not say the payload is well formed, and every
 * value here ends up rendered in a browser or compared against a marker key.
 */
export function parse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new NotificationError('the body is not an object');
  }
  if (body.schema !== SCHEMA) {
    throw new NotificationError(`schema is ${JSON.stringify(body.schema)}, expected ${SCHEMA}`);
  }

  const kind = text(body.kind, 'kind');
  if (!KINDS.includes(kind)) {
    throw new NotificationError(`kind is ${JSON.stringify(kind)}, not one of ${KINDS.join(', ')}`);
  }

  const requestId = text(body.request_id, 'request_id', REQUEST_ID);

  const marker = body.marker ?? {};
  if (typeof marker !== 'object' || Array.isArray(marker)) {
    throw new NotificationError('marker is not an object');
  }
  const markerKey = text(marker.key, 'marker.key');

  // The key has to be the one this announcement is about. They come from one writer and cannot
  // differ by accident, so a mismatch means the announcement names one request and points at
  // another - and the panel's whole value is that its link goes where it says.
  if (markerKey !== `${kind}/${requestId}.json`) {
    throw new NotificationError(
      `marker.key is ${JSON.stringify(markerKey)} but the request is ${kind}/${requestId}.json`,
    );
  }

  const events = body.events ?? {};
  const names = Array.isArray(events.names)
    ? events.names.filter((n) => typeof n === 'string').slice(0, MAX_EVENT_NAMES)
    : [];

  return {
    kind,
    request_id: requestId,
    account_id: text(body.account_id, 'account_id', ACCOUNT),
    resource: text(body.resource, 'resource', RESOURCE),
    request_kind: text(body.request_kind, 'request_kind', null, { required: false }),
    marker_bucket: text(marker.bucket, 'marker.bucket', null, { required: false }),
    marker_key: markerKey,
    task_arn: text(body.task?.arn, 'task.arn', null, { required: false, max: 2048 }),
    event_count: Number.isInteger(events.count) ? events.count : names.length,
    event_names: names,
    first_event_at: text(events.first_at, 'events.first_at', null, { required: false }),
    last_event_at: text(events.last_at, 'events.last_at', null, { required: false }),
    buffer_reason: text(body.buffer?.reason, 'buffer.reason', null, { required: false, max: 32 }),
    held_seconds: typeof body.buffer?.held_seconds === 'number' ? body.buffer.held_seconds : null,
    dispatched_at: text(body.dispatched_at, 'dispatched_at', null, { required: false }),
  };
}

/** A bounded, newest-first list of what was announced.
 *
 * Keyed by kind and request id rather than appended blindly. A redelivered SQS message dispatches
 * the same request again - the deterministic marker key absorbs that everywhere else, and this is
 * where it would otherwise show up as two identical rows that look like two pieces of work.
 */
export function makeNotifications({ limit = 200 } = {}) {
  const byId = new Map();

  function record(entry, now) {
    const id = `${entry.kind}:${entry.request_id}`;
    const existing = byId.get(id);
    // Delete before set so the insertion order puts the newest last, which is what makes list()
    // newest-first without sorting on every read.
    byId.delete(id);
    byId.set(id, {
      ...entry,
      id,
      received_at: new Date(now).toISOString(),
      first_received_at: existing?.first_received_at ?? new Date(now).toISOString(),
      repeats: (existing?.repeats ?? 0) + (existing ? 1 : 0),
    });

    // Oldest out. A cap rather than growth without bound: this process is long lived and the
    // panel is a recent-activity view, not a log.
    while (byId.size > limit) {
      const oldest = byId.keys().next().value;
      byId.delete(oldest);
    }
    return byId.get(id);
  }

  function list() {
    return [...byId.values()].reverse();
  }

  return { record, list, size: () => byId.size };
}
