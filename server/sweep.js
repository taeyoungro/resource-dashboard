// The sweep: what the two buckets say, turned into what the page shows.
//
// This is the whole reason the dashboard holds a role. Nothing pushes state here that has to be
// believed - the buckets are read directly, on startup and on an interval, so a notification that
// never arrives costs one interval and an instance replacement costs nothing.
//
// Two questions are answered, and they come from different places:
//
//   which tasks failed      a marker that outlived its task. A container that could not pull its
//                           image, had no route out, was killed, or was stopped before it started
//                           writes no log and chooses no exit code. The marker is the only thing
//                           it leaves, so the marker is the only way to see it.
//   what awaits a decision  a plan prefix in the state bucket with no approval marker beside it
//                           and no outcome.json in it.
//
// The second one used to have a hole: the applier deletes its marker when it finishes, so an
// applied plan was indistinguishable from one nobody had looked at. That is closed. The applier
// writes outcome.json into the plan prefix before it deletes the marker, and one record replaces
// the other - so a plan that has been dealt with says so, and says by whom.

import { digest, getBytes, getJson, listPrefix } from './s3.js';

const MARKER_SUFFIX = '.json';

// Which artifact decides that a plan prefix is a plan at all. main.tf.json is the one that names
// the account and resource, so it is also the one worth failing on if it is missing.
const CONFIG_ARTIFACT = 'main.tf.json';
const PLAN_ARTIFACT = 'tfplan';

// Written last by the inspector, and therefore what says the prefix holds a finished plan rather
// than an upload in progress. It also carries the request id, which stopped being part of the key
// when plans moved to one-per-governed-resource.
const MANIFEST_ARTIFACT = 'request.json';

// Written by the applier when a decision is finished with - applied, or denied. This is what
// closes the hole described at the top of this file: the applier deletes its marker when it
// finishes, so without a terminal object an applied plan looked exactly like one nobody had
// looked at. It is also the surviving copy of the decision, because deleting the approval marker
// destroys the only other one - CloudTrail records that the object went, not what was in it.
//
// Compared against the manifest's request id, not just read. The plan prefix is overwritten in
// place by every new inspection, so an outcome left over from a previous plan would otherwise
// make a fresh plan look already decided.
const OUTCOME_ARTIFACT = 'outcome.json';

// The inspector's reduction of what the plan will DO, written beside the plan. See event_pipeline
// code/inspector/generator/digest.py.
//
// An approval carries two values, and they answer two different questions:
//
//   tfplan_sha256    the binary the applier runs is the binary that was approved
//   changes_sha256   the plan.txt and plan.json a person read describe that binary
//
// The applier runs the inspector's saved plan file unchanged - the generated document names a
// profile rather than a role, so the plan is portable between the two containers - which is what
// makes the first value the binding. The second is not implied by it: a plan prefix is six
// separate objects and a new inspection overwrites them in place, so a partial overwrite could
// leave a tfplan from one plan beside a plan.txt from another. The approver would then have read
// a true-looking description of something else.
//
// This value is COPIED here, never computed. The dashboard is the component that is not trusted,
// so it must not author the value that authorises its own approval - it carries the inspector's.
const DIGEST_ARTIFACT = 'changes.sha256';

/** The request id in a marker key, or null when the key is not a marker at all.
 *
 * Not everything under a prefix is a marker. Creating inspector/ or applier/ as a folder in the S3
 * console leaves a zero byte object whose key IS the prefix, and a listing returns it like any
 * other object. Reading that as JSON fails with "Unexpected end of JSON input", which is what it
 * did - twice, once per prefix, reported on the page as two things the sweep could not read.
 *
 * So the shape is decided here and only here: the prefix, then a non-empty name with no slash in
 * it, then .json. The folder placeholder has an empty name and is skipped; anything nested deeper
 * is not a marker either.
 */
export function requestIdFromMarkerKey(key, prefix) {
  if (!key.startsWith(prefix) || !key.endsWith(MARKER_SUFFIX)) return null;
  const name = key.slice(prefix.length, -MARKER_SUFFIX.length);
  if (!name || name.includes('/')) return null;
  return name;
}

// <account id>/<resource>/plan/<artifact>. Everything terraform produces for one governed resource
// lives under <account id>/<resource>/, so this listing also returns terraform.tfstate and anything
// else that ends up there; the pattern is what decides which keys are plan artifacts.
//
// The resource is an IAM policy name, whose character set is [\w+=,.@-]. That excludes / and :,
// which is what makes both the split below and the : in a plan id unambiguous.
const PLAN_KEY = /^(\d{12})\/([\w+=,.@-]{1,96})\/plan\/([^/]+)$/;

/** A plan id and an artifact name, or null when the key is not a plan artifact.
 *
 * The plan id is <account id>:<resource>, not the request id. Plans are keyed by the governed
 * resource now - one resource, one state, one plan - so the request id is no longer in the key at
 * all. It is read from request.json, because the approval marker is still named by it.
 *
 * A colon rather than a slash because this value travels in a URL path segment, and the router
 * splits those on /. A colon is a legal path character and cannot occur in an IAM policy name.
 */
export function planIdFromKey(key) {
  const match = PLAN_KEY.exec(key);
  if (!match) return null;
  return { planId: `${match[1]}:${match[2]}`, artifact: match[3] };
}

/** The prefix a plan id points at, or null if it is not a plan id. */
export function planPrefixFromId(planId) {
  const colon = String(planId ?? '').indexOf(':');
  if (colon !== 12) return null;
  const prefix = `${planId.slice(0, colon)}/${planId.slice(colon + 1)}/plan/`;
  // Built and then checked against the same pattern that reads keys, so the two cannot drift and
  // a crafted id cannot produce a key shape the reader would never have accepted.
  return planIdFromKey(`${prefix}tfplan`) ? prefix : null;
}

/** The backend key is <account id>/<resource>/terraform.tfstate - see generator/twin.py.
 *
 * Read from the generated configuration rather than from the request id, which stopped carrying
 * the resource name when it had to fit in 36 characters of ECS startedBy.
 */
export function identityFromConfig(configJson) {
  const key = configJson?.terraform?.backend?.s3?.key;
  if (typeof key !== 'string') return { accountId: null, resource: null };
  const parts = key.split('/');
  if (parts.length < 3) return { accountId: null, resource: null };
  return { accountId: parts[0], resource: parts[1] };
}

/** One line per resource the plan changes, from the machine-readable rendering. */
export function changesFromPlan(planJson) {
  const changes = [];
  for (const change of planJson?.resource_changes ?? []) {
    const actions = change?.change?.actions ?? [];
    if (actions.length === 1 && actions[0] === 'no-op') continue;
    changes.push({
      address: change.address ?? '?',
      type: change.type ?? '?',
      name: change.name ?? '?',
      actions,
    });
  }
  return changes;
}

/** The body of every marker, from the cache where possible and S3 for the rest.
 *
 * The cache holds what this process was already given: the listener announces an inspector marker
 * with its body at the moment it dispatches, and the applier markers are ones this process wrote
 * itself. In a healthy system that is all of them, and this function makes no S3 call at all.
 *
 * The fallback is what keeps the announcement from being load-bearing. A dropped push, a restarted
 * dashboard, an evicted entry - each costs one GetObject and produces the same answer. Lose every
 * push and this behaves exactly as it did before the announcement path existed.
 */
async function readMarkerBodies(s3, config, markers, bodies, errors) {
  const out = new Map();
  const missing = [];

  for (const marker of markers) {
    const requestId = requestIdFromMarkerKey(marker.key, marker.prefix);
    const cached = requestId ? bodies?.get(marker.kind, requestId) : null;
    if (cached) out.set(marker.key, cached);
    else missing.push(marker);
  }

  // Oldest first: if the cap bites, the bodies worth having are the ones that have been stuck
  // longest, not whichever the listing happened to return.
  const ordered = [...missing].sort((a, b) => (a.lastModified ?? '').localeCompare(b.lastModified ?? ''));
  const capped = ordered.slice(0, config.maxBodiesPerSweep);
  if (ordered.length > capped.length) {
    errors.push(
      `fetched ${capped.length} of ${ordered.length} marker bodies that were not already held ` +
        '(OPT_MAX_BODIES_PER_SWEEP); the rest are listed without their contents',
    );
  }

  for (const marker of capped) {
    try {
      out.set(marker.key, await getJson(s3, config.markerBucket, marker.key));
    } catch (err) {
      // A body that will not read is still a marker that is still there, which is the fact that
      // matters. Recorded and carried on with.
      errors.push(`${marker.key}: ${err.message}`);
    }
  }
  return { bodies: out, fetched: capped.length, held: markers.length - missing.length };
}

function describeMarkers(markers, bodies, kind, prefix, nowMs, graceSeconds) {
  const rows = [];
  for (const marker of markers) {
    const requestId = requestIdFromMarkerKey(marker.key, prefix);
    if (!requestId) continue;
    const body = bodies.get(marker.key) ?? null;
    const ageSeconds = marker.lastModified
      ? Math.max(0, Math.round((nowMs - Date.parse(marker.lastModified)) / 1000))
      : null;
    rows.push({
      kind,
      key: marker.key,
      request_id: requestId,
      account_id: body?.account_id ?? null,
      resource: body?.resource ?? null,
      request_kind: body?.kind ?? null,
      reviewer: body?.reviewer ?? null,
      decision: body?.decision ?? null,
      last_modified: marker.lastModified,
      age_seconds: ageSeconds,
      // Below the grace period the task is presumed to be running. Saying "failed" about a task
      // that is two minutes into a terraform plan would train everyone to ignore the list.
      state: ageSeconds !== null && ageSeconds < graceSeconds ? 'running' : 'failed',
      body_read: body !== null,
      event_count: Array.isArray(body?.events) ? body.events.length : null,
      first_event_at: body?.first_event_at ?? null,
      last_event_at: body?.last_event_at ?? null,
    });
  }
  return rows;
}

async function collectPlans(s3, config, decidedRequestIds, errors) {
  // No prefix. Plans are keyed by the governed resource, so they are spread across one prefix per
  // account rather than gathered under one - there is nothing narrower to ask for. The listing
  // returns state files too and the pattern in planIdFromKey drops them.
  const objects = await listPrefix(s3, config.stateBucket, '');

  const byPlan = new Map();
  for (const object of objects) {
    const parsed = planIdFromKey(object.key);
    // Not a plan artifact: terraform.tfstate, its lock file, a folder placeholder made in the
    // console, anything nested deeper. Skipped silently - these are normal contents of this
    // bucket, and calling them errors would train everyone to ignore the banner.
    if (!parsed) continue;
    const entry = byPlan.get(parsed.planId) ?? { planId: parsed.planId, artifacts: new Map() };
    entry.artifacts.set(parsed.artifact, object);
    byPlan.set(parsed.planId, entry);
  }

  const plans = [];
  for (const { planId, artifacts } of byPlan.values()) {
    const prefix = planPrefixFromId(planId);
    const plan = artifacts.get(PLAN_ARTIFACT);
    const configObject = artifacts.get(CONFIG_ARTIFACT);
    const manifestObject = artifacts.get(MANIFEST_ARTIFACT);

    // request.json is written last, so a prefix without it is an upload in progress rather than a
    // plan. That distinction matters more now than it did: the prefix is overwritten in place by
    // every new inspection, so "incomplete" is a state a healthy system passes through, and only
    // one that persists is a fault. It is still reported - a half-written plan nobody can see is
    // worse than a noisy row - and it resolves itself on the next sweep.
    if (!plan || !configObject || !manifestObject) {
      errors.push(
        `${prefix} is incomplete (${[...artifacts.keys()].sort().join(', ') || 'empty'})`,
      );
      continue;
    }

    let identity = { accountId: null, resource: null };
    try {
      identity = identityFromConfig(await getJson(s3, config.stateBucket, configObject.key));
    } catch (err) {
      errors.push(`${configObject.key}: ${err.message}`);
    }

    let manifest = null;
    try {
      manifest = await getJson(s3, config.stateBucket, manifestObject.key);
    } catch (err) {
      errors.push(`${manifestObject.key}: ${err.message}`);
    }

    const requestId = typeof manifest?.request_id === 'string' ? manifest.request_id : null;

    let outcome = null;
    const outcomeObject = artifacts.get(OUTCOME_ARTIFACT);
    if (outcomeObject) {
      try {
        outcome = await getJson(s3, config.stateBucket, outcomeObject.key);
      } catch (err) {
        errors.push(`${outcomeObject.key}: ${err.message}`);
      }
    }

    plans.push({
      plan_id: planId,
      // Which inspection produced this plan. Not part of the key any more, but still what the
      // approval marker is named by, and still what ties a plan back to a task in the logs.
      request_id: requestId,
      account_id: identity.accountId,
      resource: identity.resource,
      planned_at: manifest?.planned_at ?? plan.lastModified,
      plan_etag: plan.etag,
      plan_bytes: plan.size,
      artifacts: [...artifacts.keys()].sort(),
      state: planState(manifest, outcome, requestId, decidedRequestIds),
      outcome: outcomeFor(outcome, requestId),
    });
  }

  plans.sort((a, b) => (b.planned_at ?? '').localeCompare(a.planned_at ?? ''));
  return plans;
}

/** The applier's record for THIS plan, or null.
 *
 * An outcome whose request id is not the stored plan's belongs to a plan this one replaced. It is
 * left in the bucket - the applier writes one per apply and overwrites - but it says nothing about
 * what is there now, so it is not shown.
 */
function outcomeFor(outcome, requestId) {
  if (!outcome || !requestId || outcome.request_id !== requestId) return null;
  return {
    decision: outcome.decision ?? null,
    reviewer: outcome.reviewer ?? null,
    applied: outcome.applied === true,
    detail: typeof outcome.detail === 'string' ? outcome.detail : '',
    finished_at: outcome.finished_at ?? null,
  };
}

/** What this plan is waiting for, if anything.
 *
 * The order matters. An outcome is terminal and is checked first: once the applier has finished
 * with a decision there is nothing left to wait for, and the approval marker it consumed is gone.
 *
 * no_changes is not a decision anybody has to make: the twin already matches the spec. The
 * inspector stores such a plan anyway, because the prefix holds exactly one plan per resource and
 * skipping the write would leave the PREVIOUS plan standing - one that does have changes and is
 * approvable, describing an edit the administrator may since have reverted.
 */
function planState(manifest, outcome, requestId, decidedRequestIds) {
  const mine = outcomeFor(outcome, requestId);
  if (mine) return mine.applied ? 'applied' : 'closed';
  if (manifest?.has_changes === false) return 'no_changes';
  // Decided means an approval marker is sitting in applier/ and the applier has not finished with
  // it yet. It disappears when the applier does, and outcome.json takes its place.
  if (requestId && decidedRequestIds.has(requestId)) return 'decided';
  return 'awaiting_decision';
}

export async function sweep(s3, config, { now = Date.now(), bodies = null } = {}) {
  const errors = [];

  const [inspectorListing, applierListing] = await Promise.all([
    listPrefix(s3, config.markerBucket, config.inspectorPrefix),
    listPrefix(s3, config.markerBucket, config.applierPrefix),
  ]);

  // Decide what is a marker once, before anything reads a body. Filtering in describeMarkers and
  // not here is what let a folder placeholder through to getJson: the listing was passed to the
  // reader raw, so the reader tried to parse an object the describer would have skipped.
  // The prefix and kind travel with each object so the body lookup can be keyed by request id
  // rather than by S3 key - the cache is filled by writers who never saw a key.
  const isMarker = (prefix) => (o) => requestIdFromMarkerKey(o.key, prefix) !== null;
  const tag = (kind, prefix) => (o) => ({ ...o, kind, prefix });
  const inspectorMarkers = inspectorListing
    .filter(isMarker(config.inspectorPrefix)).map(tag('inspector', config.inspectorPrefix));
  const applierMarkers = applierListing
    .filter(isMarker(config.applierPrefix)).map(tag('applier', config.applierPrefix));

  const skipped =
    (inspectorListing.length - inspectorMarkers.length) +
    (applierListing.length - applierMarkers.length);

  const read = await readMarkerBodies(
    s3, config, [...inspectorMarkers, ...applierMarkers], bodies, errors,
  );

  const markers = [
    ...describeMarkers(inspectorMarkers, read.bodies, 'inspector', config.inspectorPrefix,
                       now, config.markerGraceSeconds),
    ...describeMarkers(applierMarkers, read.bodies, 'applier', config.applierPrefix,
                       now, config.markerGraceSeconds),
  ];
  markers.sort((a, b) => (b.age_seconds ?? 0) - (a.age_seconds ?? 0));

  const decided = new Set(
    applierMarkers
      .map((m) => requestIdFromMarkerKey(m.key, config.applierPrefix))
      .filter(Boolean),
  );

  const plans = await collectPlans(s3, config, decided, errors);

  return {
    swept_at: new Date(now).toISOString(),
    markers,
    plans,
    // Not hidden. A sweep that half worked and reports nothing is indistinguishable from a
    // system with nothing wrong, which is the failure this whole mechanism exists to avoid.
    //
    // Keys that are not markers are not in here. A folder placeholder is a normal thing to find
    // in a bucket somebody made through the console, and calling it an error trains everyone to
    // ignore the banner. It is counted instead, and the count goes to the log.
    errors,
    skipped_keys: skipped,
    // How many marker bodies this sweep already held versus had to fetch. Zero fetched is the
    // healthy shape; a number that climbs means announcements are not arriving, which is worth
    // seeing before it becomes a body-read cap warning.
    bodies: { held: read.held, fetched: read.fetched },
    counts: {
      failed: markers.filter((m) => m.state === 'failed').length,
      running: markers.filter((m) => m.state === 'running').length,
      awaiting_decision: plans.filter((p) => p.state === 'awaiting_decision').length,
    },
  };
}

/** Everything needed to show one plan, read live rather than from the sweep. */
export async function readPlan(s3, config, planId) {
  const prefix = planPrefixFromId(planId);
  if (!prefix) return null;
  const objects = await listPrefix(s3, config.stateBucket, prefix);
  if (objects.length === 0) return null;

  const byName = new Map(objects.map((o) => [o.key.slice(prefix.length), o]));
  const planObject = byName.get(PLAN_ARTIFACT);

  const [planText, configJson, planJson, planBytes, digestText, manifest, outcome] =
    await Promise.all([
    byName.has('plan.txt')
      ? getBytes(s3, config.stateBucket, `${prefix}plan.txt`).then((b) => b.toString('utf-8'))
      : Promise.resolve(''),
    byName.has(CONFIG_ARTIFACT)
      ? getJson(s3, config.stateBucket, `${prefix}${CONFIG_ARTIFACT}`)
      : Promise.resolve(null),
    byName.has('plan.json')
      ? getJson(s3, config.stateBucket, `${prefix}plan.json`)
      : Promise.resolve(null),
    planObject
      ? getBytes(s3, config.stateBucket, `${prefix}${PLAN_ARTIFACT}`)
      : Promise.resolve(null),
    byName.has(DIGEST_ARTIFACT)
      ? getBytes(s3, config.stateBucket, `${prefix}${DIGEST_ARTIFACT}`).then((b) =>
          b.toString('utf-8').trim())
      : Promise.resolve(null),
    byName.has(MANIFEST_ARTIFACT)
      ? getJson(s3, config.stateBucket, `${prefix}${MANIFEST_ARTIFACT}`)
      : Promise.resolve(null),
    byName.has(OUTCOME_ARTIFACT)
      ? getJson(s3, config.stateBucket, `${prefix}${OUTCOME_ARTIFACT}`)
      : Promise.resolve(null),
  ]);

  const identity = identityFromConfig(configJson);
  return {
    plan_id: planId,
    // From request.json, not from the key. A plan is keyed by the governed resource; the request
    // id says which inspection produced the one currently stored, and it is what the approval
    // marker gets named by.
    request_id: typeof manifest?.request_id === 'string' ? manifest.request_id : null,
    // The inspector's own word on whether there is anything to do. A plan with none is stored so
    // that it replaces the previous one, not because it is waiting for somebody.
    has_changes: manifest?.has_changes !== false,

    // What the applier did, if it has finished with this plan. Terminal: a plan with an outcome
    // has been dealt with and is not awaiting anything.
    outcome: outcomeFor(outcome, typeof manifest?.request_id === 'string'
      ? manifest.request_id : null),
    account_id: identity.accountId,
    resource: identity.resource,
    planned_at: manifest?.planned_at ?? planObject?.lastModified ?? null,
    plan_etag: planObject?.etag ?? null,
    plan_bytes: planObject?.size ?? null,

    // Read from the bucket, not computed. Null when the plan predates the inspector writing it,
    // and such a plan cannot be approved: nothing would establish that the plan.txt shown on this
    // page describes the file the applier is about to run.
    changes_sha256: isDigest(digestText) ? digestText : null,

    // The hash of the saved plan file - the file the applier runs, unchanged. This is what the
    // approval binds to. The ETag would not do: it is an MD5, and this is the one place in the
    // system where the question is whether a file was replaced on purpose.
    plan_file_sha256: planBytes ? digest(planBytes) : null,

    plan_text: planText,
    config_json: configJson ? JSON.stringify(configJson, null, 2) : '',
    changes: changesFromPlan(planJson),
    artifacts: [...byName.keys()].sort(),
  };
}

/** 64 lowercase hex characters and nothing else.
 *
 * The file is read from a bucket and its contents end up in an approval marker that a container
 * with write access to member accounts acts on. Checking the shape here costs nothing and means a
 * truncated or half-written object cannot become an approval that matches nothing.
 */
export function isDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
