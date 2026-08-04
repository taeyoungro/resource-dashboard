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
//   what awaits a decision  a plan prefix in the state bucket with no approval marker beside it.
//
// The second one has a known hole, and it is not papered over here: the applier deletes its
// marker when it finishes, so an applied plan becomes indistinguishable from one nobody has
// looked at yet. The state is reported as it is and the page says so. The fix belongs in the
// applier - a terminal object written into the plan prefix - and is recorded in event_pipeline
// under code/README.md.

import { digest, getBytes, getJson, listPrefix } from './s3.js';

const MARKER_SUFFIX = '.json';

// Which artifact decides that a plan prefix is a plan at all. main.tf.json is the one that names
// the account and resource, so it is also the one worth failing on if it is missing.
const CONFIG_ARTIFACT = 'main.tf.json';
const PLAN_ARTIFACT = 'tfplan';

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
// makes the first value the binding. The second is not implied by it: a plan prefix is five
// separate objects, and a partial overwrite could leave a tfplan from one plan beside a plan.txt
// from another. The approver would then have read a true-looking description of something else.
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

function requestIdFromPlanKey(key, prefix) {
  const rest = key.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? null : rest.slice(0, slash);
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

async function readMarkerBodies(s3, config, markers, errors) {
  // Oldest first: if the cap bites, the bodies worth having are the ones that have been stuck
  // longest, not whichever the listing happened to return.
  const ordered = [...markers].sort((a, b) => (a.lastModified ?? '').localeCompare(b.lastModified ?? ''));
  const capped = ordered.slice(0, config.maxBodiesPerSweep);
  if (ordered.length > capped.length) {
    errors.push(
      `read ${capped.length} of ${ordered.length} marker bodies (OPT_MAX_BODIES_PER_SWEEP);` +
        ' the rest are listed without their contents',
    );
  }

  const out = new Map();
  for (const marker of capped) {
    try {
      out.set(marker.key, await getJson(s3, config.markerBucket, marker.key));
    } catch (err) {
      // A body that will not read is still a marker that is still there, which is the fact that
      // matters. Recorded and carried on with.
      errors.push(`${marker.key}: ${err.message}`);
    }
  }
  return out;
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
  const objects = await listPrefix(s3, config.stateBucket, config.planPrefix);

  const byRequest = new Map();
  for (const object of objects) {
    const requestId = requestIdFromPlanKey(object.key, config.planPrefix);
    if (!requestId) continue;
    const name = object.key.slice(config.planPrefix.length + requestId.length + 1);
    // The same folder-placeholder problem as the marker prefixes: a key ending at the directory
    // has no artifact name. Without this it lands in the map as "", and the incomplete-prefix
    // message then lists an empty artifact.
    if (!name) continue;
    const entry = byRequest.get(requestId) ?? { requestId, artifacts: new Map() };
    entry.artifacts.set(name, object);
    byRequest.set(requestId, entry);
  }

  const plans = [];
  for (const { requestId, artifacts } of byRequest.values()) {
    const plan = artifacts.get(PLAN_ARTIFACT);
    const configObject = artifacts.get(CONFIG_ARTIFACT);
    if (!plan || !configObject) {
      // A prefix with only some of its artifacts is an upload that did not finish. Reported
      // rather than dropped: a half-written plan that nobody can see is worse than a noisy row.
      errors.push(
        `${config.planPrefix}${requestId}/ is incomplete (` +
          `${[...artifacts.keys()].join(', ') || 'empty'})`,
      );
      continue;
    }

    let identity = { accountId: null, resource: null };
    try {
      identity = identityFromConfig(await getJson(s3, config.stateBucket, configObject.key));
    } catch (err) {
      errors.push(`${configObject.key}: ${err.message}`);
    }

    plans.push({
      request_id: requestId,
      account_id: identity.accountId,
      resource: identity.resource,
      planned_at: plan.lastModified,
      plan_etag: plan.etag,
      plan_bytes: plan.size,
      artifacts: [...artifacts.keys()].sort(),
      // Decided means an approval marker is sitting in applier/. It disappears again when the
      // applier finishes, which is the hole described at the top of this file.
      state: decidedRequestIds.has(requestId) ? 'decided' : 'awaiting_decision',
    });
  }

  plans.sort((a, b) => (b.planned_at ?? '').localeCompare(a.planned_at ?? ''));
  return plans;
}

export async function sweep(s3, config, { now = Date.now() } = {}) {
  const errors = [];

  const [inspectorListing, applierListing] = await Promise.all([
    listPrefix(s3, config.markerBucket, config.inspectorPrefix),
    listPrefix(s3, config.markerBucket, config.applierPrefix),
  ]);

  // Decide what is a marker once, before anything reads a body. Filtering in describeMarkers and
  // not here is what let a folder placeholder through to getJson: the listing was passed to the
  // reader raw, so the reader tried to parse an object the describer would have skipped.
  const isMarker = (prefix) => (o) => requestIdFromMarkerKey(o.key, prefix) !== null;
  const inspectorMarkers = inspectorListing.filter(isMarker(config.inspectorPrefix));
  const applierMarkers = applierListing.filter(isMarker(config.applierPrefix));

  const skipped =
    (inspectorListing.length - inspectorMarkers.length) +
    (applierListing.length - applierMarkers.length);

  const bodies = await readMarkerBodies(
    s3, config, [...inspectorMarkers, ...applierMarkers], errors,
  );

  const markers = [
    ...describeMarkers(inspectorMarkers, bodies, 'inspector', config.inspectorPrefix,
                       now, config.markerGraceSeconds),
    ...describeMarkers(applierMarkers, bodies, 'applier', config.applierPrefix,
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
    counts: {
      failed: markers.filter((m) => m.state === 'failed').length,
      running: markers.filter((m) => m.state === 'running').length,
      awaiting_decision: plans.filter((p) => p.state === 'awaiting_decision').length,
    },
  };
}

/** Everything needed to show one plan, read live rather than from the sweep. */
export async function readPlan(s3, config, requestId) {
  const prefix = `${config.planPrefix}${requestId}/`;
  const objects = await listPrefix(s3, config.stateBucket, prefix);
  if (objects.length === 0) return null;

  const byName = new Map(objects.map((o) => [o.key.slice(prefix.length), o]));
  const planObject = byName.get(PLAN_ARTIFACT);

  const [planText, configJson, planJson, planBytes, digestText] = await Promise.all([
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
  ]);

  const identity = identityFromConfig(configJson);
  return {
    request_id: requestId,
    account_id: identity.accountId,
    resource: identity.resource,
    planned_at: planObject?.lastModified ?? null,
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
