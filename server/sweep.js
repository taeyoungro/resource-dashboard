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

import { liveGrants, mirrorRoleFromConfig } from './passroleLive.js';
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

/**
 * What a REFUSED inspection leaves behind, written by the inspector into the plan prefix.
 *
 * The gap it closes: a refusal is a completed run, so the marker is deleted, so the request used
 * to vanish - the reason existed in CloudWatch and nowhere a person at this page would ever be.
 * The observed case was a spec role carrying twelve managed policies against a limit of ten: no
 * plan, no failure, no row.
 *
 * It carries the request id that produced it, and that is what keeps it from outliving the
 * problem. The inspector holds no delete on the state bucket, so a later successful inspection
 * cannot remove this - it rewrites request.json with its OWN id instead, and the comparison in
 * refusalFor() then reads the record as superseded. Nothing has to clean up.
 */
const REFUSAL_ARTIFACT = 'refusal.json';

/** PassRole actions taken on this resource with no plan decision behind them - see event_pipeline
 * code/applier/applier/withdrawal.py.
 *
 * Its own object, beside outcome.json rather than inside it, and that is what makes it useful here.
 * outcome.json is the record of ONE plan and is matched to the inspection that produced it, so a
 * later inspection makes it stale; a withdrawal is about the RESOURCE and has to outlive every
 * re-inspection. Appended to, never replaced - "who took what away, and when" is the question.
 */
const WITHDRAWAL_ARTIFACT = 'passrole.json';

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

// Written by the impact querier: what the permission set will reach, enumerated before it is
// granted. Its presence is what makes a restriction possible - a restriction names resources, and
// this is the fence those names are checked against - so its absence is a state the page has to
// distinguish rather than hide. See event_pipeline code/impact.
const IMPACT_ARTIFACT = 'impact.json';
const IMPACT_DIGEST_ARTIFACT = 'impact.sha256';

/** What has happened to the assessment for the inspection currently stored in a prefix.
 *
 * Three states and they are not degrees of the same thing:
 *
 *   ready        impact.json is there. A restriction can be decided
 *   in_progress  the impact/ marker for THIS request still exists, so the querier has not finished.
 *                The page says so, rather than showing an empty assessment that reads as "nothing
 *                to worry about"
 *   unavailable  neither. Either the querier failed after its marker was closed, or this plan was
 *                made before assessments existed. The plan is still approvable - deliberately -
 *                just not with a restriction
 *
 * The marker is consulted only for the CURRENT request id. A marker left by an earlier inspection
 * of the same resource says nothing about the plan that is there now.
 */
function assessmentState(artifacts, requestId, outstandingRequestIds) {
  const ready = artifacts.has(IMPACT_ARTIFACT);
  const outstanding = Boolean(requestId) && outstandingRequestIds.has(requestId);
  if (ready && !outstanding) return 'ready';
  if (outstanding) return 'in_progress';
  return 'unavailable';
}

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

/** The Identity Center user names that asked for PassRole, from the GENERATED document.
 *
 * main.tf.json rather than plan.json, because the sweep already reads it for every row and the
 * value is literal in it: the inspector resolved the tags before generating, so there is no
 * "(known after apply)" here. plan.json carries the same list, and passroleFromPlan below reads it
 * for the detail panel, where the services and the target ARN are wanted too.
 */
export function requestersFromConfig(document) {
  const value = document?.output?.passrole_requested_by?.value;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => typeof v === 'string' && v.trim()))].sort();
}

/** Who HOLDS the grant right now, from the same document.
 *
 * Counted onto the row so a resource whose grants can be taken back is findable at all. Every badge
 * before this one was about a REQUEST, and a holder whose tag was removed in an earlier inspection
 * is in no request list - so the row said nothing and the only screen that can revoke was reachable
 * only by guessing which plan to open.
 */
export function holdersFromConfig(document) {
  const value = document?.output?.passrole_granted_to?.value;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => typeof v === 'string' && v.trim()))].sort();
}

/** The people who ASKED and cannot be granted, from the same document.
 *
 * Counted into the row beside the requesters above, and that is the whole point of it. These names
 * are in `passrole_unavailable` and in no other output: the inspector keeps them OUT of
 * passrole_requested_by deliberately, because a name there is one an approver may confirm and these
 * cannot be. So every screen that read only requested_by showed nothing at all.
 *
 * That is the state this exists to end. Somebody tags their role, the inspector resolves the tag,
 * decides the grant cannot be written, records why - and the person who asked sees an empty
 * PassRole panel, or no PassRole tab at all, with no way to tell "refused" from "not looked at
 * yet". The inspector's own comment on the output says so; nothing read it.
 */
export function unavailableFromConfig(document) {
  const value = document?.output?.passrole_unavailable?.value;
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.user_name === 'string' && entry.user_name.trim())
    .map((entry) => ({
      user_name: entry.user_name,
      permission_set: typeof entry.permission_set === 'string' ? entry.permission_set : null,
      // The inspector's own sentence, not one composed here. It distinguishes the two causes -
      // no Identity Center user by that name, or no permission set to write the grant into - and
      // they call for different things from the person who asked.
      why: typeof entry.why === 'string' ? entry.why : '',
    }));
}

/** The PassRole requests this plan carries, from the mirror document's outputs.
 *
 * A user asks by tagging their <service>-* role <their name> = passrole. The inspector reads the
 * tag, resolves the name against Identity Center, and the mirror document carries the answer in
 * three outputs. This reads them so the page can put the request in front of an approver.
 *
 * Asking grants nothing, and the shape here says so: these are requests, and a grant happens only
 * when an approver names somebody in the decision. The applier checks that name against
 * requested_by again - this page is the untrusted tier and its list is a convenience, not the
 * authority.
 *
 * Two more lists, and they answer questions requested_by cannot:
 *
 *   granted_to  who HOLDS the grant right now, read by the inspector out of the permission sets'
 *               own inline policies. Without it a list of names says nothing about state, so
 *               "grant" and "leave alone" are the same word on the screen
 *   untagged    whose tag was REMOVED while their grant stands. A request is a tag and removing it
 *               is how the request is withdrawn; the role afterwards does not carry it, so reading
 *               the role's tags saw every request and no withdrawal. These names are not in
 *               requested_by and must not be - there is nothing to grant. They are offered for
 *               withdrawal only
 *
 * target_arn is null on a role that does not exist yet: terraform reports "(known after apply)" and
 * there is no ARN to show until the apply produces one. That is not a reason to withhold the
 * request - the approver is deciding about a role the same plan is creating.
 */
export function passroleFromPlan(planJson) {
  const outputs = planJson?.output_changes ?? {};
  const after = (name) => {
    const change = outputs[name];
    // `after` carries the value; `after_unknown` means terraform cannot say yet. Reading the second
    // as a value would put the string "true" on screen where an ARN belongs.
    if (!change || change.after === undefined || change.after === null) return null;
    return change.after;
  };
  const list = (name) => {
    const value = after(name);
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()) : [];
  };
  const arn = after('passrole_target_arn');
  const unavailable = after('passrole_unavailable');
  return {
    requested_by: [...new Set(list('passrole_requested_by'))].sort(),
    granted_to: [...new Set(list('passrole_granted_to'))].sort(),
    untagged: [...new Set(list('passrole_untagged'))].sort(),
    // Asked for and NOT grantable, with the inspector's reason. Never in requested_by - a name
    // there is one an approver may confirm, and these cannot be - which is exactly why they were
    // invisible: every screen read requested_by and nothing else, so tagging a role whose
    // permission set does not exist produced an empty panel and no tab.
    unavailable: unavailableFromConfig({ output: { passrole_unavailable: { value: unavailable } } }),
    services: [...new Set(list('passrole_services'))].sort(),
    target_arn: typeof arn === 'string' && arn.trim() ? arn.trim() : null,
  };
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

function describeMarkers(markers, bodies, kind, prefix, nowMs, graceSeconds, { locks = false } = {}) {
  const rows = [];
  for (const marker of markers) {
    const name = requestIdFromMarkerKey(marker.key, prefix);
    if (!name) continue;
    const body = bodies.get(marker.key) ?? null;
    const ageSeconds = marker.lastModified
      ? Math.max(0, Math.round((nowMs - Date.parse(marker.lastModified)) / 1000))
      : null;
    rows.push({
      kind,
      key: marker.key,
      // For the three request-keyed prefixes the name in the key IS the request id. The inline
      // writer's key is the permission set lock instead, so the request id comes from the body and
      // is null when the body could not be read - which is honest: the key does not carry one.
      request_id: locks ? (body?.request_id ?? null) : name,
      // The document this marker locks. Null on every other kind, because they lock nothing.
      permission_set: locks ? (body?.permission_set_name ?? name.split(':').pop() ?? null) : null,
      account_id: body?.account_id ?? null,
      resource: body?.resource ?? null,
      request_kind: body?.kind ?? null,
      reviewer: body?.reviewer ?? null,
      decision: body?.decision ?? null,
      last_modified: marker.lastModified,
      age_seconds: ageSeconds,
      // Below the grace period the task is presumed to be running. Saying "failed" about a task
      // that is two minutes into a terraform plan would train everyone to ignore the list.
      //
      // For a lock, `failed` means more than a task that did not finish: the permission set is
      // BLOCKED until somebody deletes the object, and the grant it was meant to limit is already
      // in force. That is why it is called out separately on the page.
      state: ageSeconds !== null && ageSeconds < graceSeconds ? 'running' : 'failed',
      blocks_further_writes: locks,
      body_read: body !== null,
      event_count: Array.isArray(body?.events) ? body.events.length : null,
      first_event_at: body?.first_event_at ?? null,
      last_event_at: body?.last_event_at ?? null,
    });
  }
  return rows;
}

async function collectPlans(s3, config, decidedRequestIds, outstandingAssessments, errors) {
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
  // What each row needs in order to have its holder count brought up to date, gathered here and
  // resolved in one pass afterwards - see countLiveGrants.
  const staged = [];
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
    // A refusal, read before the completeness check, because a resource whose FIRST inspection was
    // refused has a prefix holding nothing else - and reporting that as "incomplete" would file the
    // one thing that explains it under the noise an administrator learns to ignore.
    let refusal = null;
    const refusalObject = artifacts.get(REFUSAL_ARTIFACT);
    if (refusalObject) {
      try {
        refusal = await getJson(s3, config.stateBucket, refusalObject.key);
      } catch (err) {
        errors.push(`${refusalObject.key}: ${err.message}`);
      }
    }

    if (!plan || !configObject || !manifestObject) {
      if (refusal) {
        // No plan has ever been produced for this resource. There is nothing to approve and
        // nothing to wait for - what there is is a reason, and it is the whole row.
        plans.push(refusedOnly(planId, refusal, refusalObject, artifacts));
        continue;
      }
      errors.push(
        `${prefix} is incomplete (${[...artifacts.keys()].sort().join(', ') || 'empty'})`,
      );
      continue;
    }

    let identity = { accountId: null, resource: null };
    // Read from the GENERATED document, which this loop already fetches for the identity. The
    // requesters are a literal list there - the inspector resolved them from the source role's tags
    // before writing it - so the row can say whether there is a PassRole request to look at without
    // a second object read per plan.
    let requesters = [];
    let unavailable = [];
    let holders = [];
    // The role the grant is ON, by name. Literal in the generated document, which this loop already
    // reads - the plan's ARN is "(known after apply)" on a role the plan creates. It is what joins
    // this row to the inline writer's record of what its runs left standing; without it the
    // snapshot below stands unchanged, which is the honest answer rather than a guess.
    let mirrorRoleName = null;
    try {
      const document = await getJson(s3, config.stateBucket, configObject.key);
      identity = identityFromConfig(document);
      requesters = requestersFromConfig(document);
      unavailable = unavailableFromConfig(document);
      holders = holdersFromConfig(document);
      mirrorRoleName = mirrorRoleFromConfig(document);
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
      state: planState(manifest, outcome, requestId, decidedRequestIds,
                        refusalFor(refusal, requestId, refusalObject)),
      outcome: outcomeFor(outcome, requestId),
      // Whether the page can offer a restriction, and what to say while it cannot. Never a reason
      // to withhold the approval itself - see assessmentState().
      assessment: assessmentState(artifacts, requestId, outstandingAssessments),
      assessment_digest_stored: artifacts.has(IMPACT_DIGEST_ARTIFACT),
      // How many people asked to be able to pass this mirror role. The row shows a way in to the
      // confirmation screen when there is one, and nothing when there is not.
      passrole_requests: requesters.length,
      // And how many of those asks cannot be granted. Counted separately because they are not
      // decisions an approver can make - but counted AT ALL because a row that says nothing is how
      // a tagged role went unnoticed: requested_by is empty for an ungrantable ask, so the badge
      // disappeared and the plan looked like one carrying no request.
      passrole_unavailable: unavailable.length,
      // And how many hold it now. Not a request and not a decision - a live fact about the
      // resource, and the way in to the only screen that can take a grant back. Filled in below
      // rather than here: the inspector's snapshot alone is what it was BEFORE the grant, and the
      // rest of the answer is in the marker bucket.
      passrole_granted: holders.length,
      // The last inspection of this resource, when it refused. Null when the record is about the
      // plan that is standing - see refusalFor.
      refusal: refusalFor(refusal, requestId, refusalObject),
    });
    staged.push({
      row: plans[plans.length - 1],
      prefix,
      snapshot: holders,
      mirrorRoleName,
      // From the RAW outcome, guarded by the match - outcomeFor narrows to what the row renders
      // and does not carry the work orders. Guarded because an outcome about an earlier inspection
      // describes a plan that is no longer standing, and the inspection that replaced it refreshed
      // the snapshot beside it.
      dispatched: outcomeFor(outcome, requestId) ? (outcome?.passrole_dispatch ?? []) : [],
      hasWithdrawals: artifacts.has(WITHDRAWAL_ARTIFACT),
    });
  }

  await countLiveGrants(s3, config, staged, errors);

  plans.sort((a, b) => (b.planned_at ?? '').localeCompare(a.planned_at ?? ''));
  return plans;
}

/** Bring every row's holder count up to date, in one pass over the marker bucket.
 *
 * The count on a row and the list on the plan page have to be the same fact, or an approver opens
 * a row saying nobody holds anything and finds two people to revoke. So both go through
 * liveGrants(); this is the part that gathers what it needs for many rows at once.
 *
 * Bounded by DECISIONS APPLIED SINCE THE LAST INSPECTION rather than by the number of plans. A row
 * whose outcome is about an earlier inspection contributes nothing and needs nothing read: the
 * inspection that replaced it refreshed the snapshot beside it, so the snapshot is already the
 * answer. Most sweeps read nothing here at all.
 */
async function countLiveGrants(s3, config, staged, errors) {
  const withWithdrawals = staged.filter((entry) => entry.hasWithdrawals);
  await Promise.all(withWithdrawals.map(async (entry) => {
    try {
      const document = await getJson(
        s3, config.stateBucket, `${entry.prefix}${WITHDRAWAL_ARTIFACT}`);
      entry.withdrawals = Array.isArray(document?.actions) ? document.actions : [];
    } catch (err) {
      errors.push(`${entry.prefix}${WITHDRAWAL_ARTIFACT}: ${err.message}`);
    }
  }));

  const wanted = new Set();
  for (const entry of staged) {
    if (!entry.mirrorRoleName) continue;
    for (const key of dispatchKeys(entry.dispatched)) wanted.add(key);
    for (const action of entry.withdrawals ?? []) {
      for (const key of dispatchKeys(action?.dispatched)) wanted.add(key);
    }
  }
  // One read per permission set, shared by every row that names it. Two roles granted to the same
  // person are two rows and one object, because the object describes the permission set.
  const results = new Map(
    (await Promise.all([...wanted].map((key) => getJson(
      s3, config.markerBucket,
      `${config.inlineResultPrefix}${key.slice(config.inlineWriterPrefix.length)}`,
    ).then((document) => [key, document]).catch(() => [key, null]))))
      .filter(([, document]) => document),
  );

  for (const entry of staged) {
    entry.row.passrole_granted = liveGrants({
      snapshot: entry.snapshot,
      dispatched: entry.dispatched,
      withdrawals: entry.withdrawals ?? [],
      results,
      mirrorRoleName: entry.mirrorRoleName,
    }).holders.length;
  }
}

/**
 * The refusal to SHOW, or null.
 *
 * Three states, and only one of them is worth a row:
 *
 *   no record                       nothing was refused
 *   record's request id == the      the refusal is about the inspection that produced the plan
 *   plan's                          standing here. That cannot happen - a refused run writes no
 *                                   plan - so it means a later inspection succeeded and rewrote
 *                                   request.json, and this record is superseded
 *   record's request id != the      the refusal is NEWER than the plan. The spec moved on, the
 *   plan's                          last attempt to plan it failed, and the plan on screen
 *                                   describes an earlier version of the resource
 *
 * The third is the one that matters and the one nothing said before. `supersedes_plan` carries it
 * rather than leaving the page to compare two ids, because what it means - "what you are looking
 * at is older than the last thing that happened" - is not obvious from the ids themselves.
 *
 * There is a transient: a successful inspection writes the plan artifacts and request.json LAST,
 * so between the two writes an old refusal briefly reads as current. The next sweep resolves it,
 * which is the same shape as the "incomplete" transient above.
 */
function refusalFor(refusal, requestId, object) {
  if (!refusal || typeof refusal.reason !== 'string' || !refusal.reason.trim()) return null;
  const refusedRequest = typeof refusal.request_id === 'string' ? refusal.request_id : null;
  if (requestId && refusedRequest === requestId) return null;
  return {
    request_id: refusedRequest,
    kind: typeof refusal.kind === 'string' ? refusal.kind : null,
    reason: refusal.reason,
    refused_at: refusal.refused_at ?? object?.lastModified ?? null,
    supersedes_plan: Boolean(requestId),
  };
}

/** A resource whose first inspection was refused: a reason, and nothing else to decide about. */
function refusedOnly(planId, refusal, object, artifacts) {
  const colon = planId.indexOf(':');
  return {
    plan_id: planId,
    request_id: typeof refusal.request_id === 'string' ? refusal.request_id : null,
    account_id: planId.slice(0, colon),
    resource: planId.slice(colon + 1),
    planned_at: refusal.refused_at ?? object?.lastModified ?? null,
    plan_etag: null,
    plan_bytes: null,
    artifacts: [...artifacts.keys()].sort(),
    state: 'refused',
    outcome: null,
    assessment: 'unavailable',
    assessment_digest_stored: false,
    refusal: refusalFor(refusal, null, object),
  };
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
    // The one terraform output the page renders: the applied permission set's ARN, which the
    // applier reads back from state - it exists only after the apply - and records under
    // outcome.outputs. The Governed link deep-links the permission set's console page with it.
    // Read narrowly: an outcome written before the applier captured outputs simply has none,
    // and the link falls back to the Identity Center console home.
    permission_set_arn: typeof outcome.outputs?.permission_set_arn === 'string'
      ? outcome.outputs.permission_set_arn : null,

    // What the applier said about the work it handed to the inline writer. `dispatched` is the
    // state that used to be the end of the story and is not: it means the work order was written,
    // not that the writer did anything with it.
    inline_state: typeof outcome.inline_state === 'string' ? outcome.inline_state : null,
    inline_detail: typeof outcome.inline_detail === 'string' ? outcome.inline_detail : '',

    // How many attempts it took. Empty on every decision that needed one.
    retries: Array.isArray(outcome.retries) ? outcome.retries : [],
  };
}

/**
 * Did the inline writer do what this decision dispatched, for each person it named?
 *
 * The count is the question. An approver confirms PassRole for three people, the applier writes
 * three work orders, and outcome.json records `dispatched` - which was the whole of what any screen
 * could say. One writer failing left a grant that was approved, recorded as sent, never written,
 * and reported nowhere.
 *
 * Three inputs, and each answers something the others cannot:
 *
 *   passrole_dispatch   무엇인가   이 결정이 발송한 작업 지시 목록. "몇 명분을 보냈는가"
 *                       어디 있나  상태 버킷 opt-org-policy-terraform-state 의
 *                                  <계정>/<자원>/plan/outcome.json, 키 passrole_dispatch
 *                       누가 쓰나  적용기 하나
 *   inline_result/…     무엇인가   작성기가 그 지시로 무엇을 했는가. written·refused·failed 와 사유
 *                       어디 있나  마커 버킷 opt-solution-markers 의
 *                                  inline_result/<계정>:<권한 세트>.json
 *                       누가 쓰나  인라인 작성기 하나
 *   inline_writer/…     무엇인가   그 권한 세트에 대해 아직 끝나지 않은 실행이 있는가 (곧 잠금)
 *                       어디 있나  같은 버킷의 inline_writer/<계정>:<권한 세트>.json
 *                       누가 쓰나  적용기가 쓰고 작성기가 지운다
 *
 * The result and the lock together give four states, and only one of them is finished:
 *
 *   written              the grant is in force. The lock is gone
 *   failed               the run stopped and did not write. The lock is HELD, and this is the one
 *                        state a retry is offered for - the applier may take a lock over exactly
 *                        when this record says the run holding it stopped
 *   refused              the inputs can never produce a different answer. The lock was released,
 *                        and retrying is possible but pointless until whatever was refused changes
 *   running / unknown    no result. Either the writer has not finished, or it died before it could
 *                        record anything. The lock says which, and neither is retryable: nothing
 *                        establishes the run has stopped
 */
/** The lock keys a list of dispatch records names, deduplicated by the caller.
 *
 * One shape read from two places - outcome.json's passrole_dispatch and passrole.json's own
 * `dispatched` - because a work order is a work order however the decision behind it was made.
 */
export function dispatchKeys(dispatched) {
  return (Array.isArray(dispatched) ? dispatched : [])
    .map((entry) => (typeof entry?.key === 'string' ? entry.key : ''))
    .filter(Boolean);
}

export function writerVerification(dispatched, results, locks) {
  return (Array.isArray(dispatched) ? dispatched : [])
    .filter((entry) => entry && typeof entry.user_name === 'string' && entry.user_name.trim())
    .map((entry) => {
      const key = typeof entry.key === 'string' ? entry.key : '';
      const result = results.get(key) ?? null;
      const locked = locks.has(key);
      const state = typeof result?.state === 'string' ? result.state : null;
      return {
        user_name: entry.user_name,
        action: entry.action === 'revoke' ? 'revoke' : 'grant',
        permission_set: typeof entry.permission_set === 'string' ? entry.permission_set : null,
        key,
        // Whether this dispatch came from a retry rather than the original decision.
        retried: entry.retry === true,

        // Null when the writer left no record. Distinct from every state it can record, because
        // "not finished yet" and "finished and failed" call for different things from a person.
        state,
        // The whole of what a person gets about a failure. CloudWatch has the traceback; this is
        // the sentence, and it is why the failure is on the screen at all.
        reason: typeof result?.reason === 'string' ? result.reason : '',
        finished_at: result?.finished_at ?? null,

        // The lock. Held with no result is a run still going or a task that died before it could
        // say anything - the two look identical here, which is exactly why neither is retryable.
        locked,

        // One boolean the page renders on. Only a recorded `written` counts: a missing lock proves
        // nothing on its own, because a refusal releases the lock without writing.
        ok: state === 'written',
        // The applier takes a lock over only when the writer recorded that its run stopped. Both
        // states qualify; `failed` is the one this exists for, and `refused` covers a release that
        // itself failed.
        retryable: state === 'failed' || state === 'refused',
      };
    });
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
function planState(manifest, outcome, requestId, decidedRequestIds, refusal) {
  const mine = outcomeFor(outcome, requestId);
  if (mine) return mine.applied ? 'applied' : 'closed';
  // A refusal NEWER than this plan outranks what the plan says it is waiting for. The plan is
  // real and still approvable, but it describes an earlier version of the resource and the last
  // attempt to plan the current one failed - so "awaiting decision" would be answering a question
  // nobody asked while the one that was asked went unmentioned.
  if (refusal?.supersedes_plan) return 'refused';
  if (manifest?.has_changes === false) return 'no_changes';
  // Decided means an approval marker is sitting in applier/ and the applier has not finished with
  // it yet. It disappears when the applier does, and outcome.json takes its place.
  if (requestId && decidedRequestIds.has(requestId)) return 'decided';
  return 'awaiting_decision';
}

export async function sweep(s3, config, { now = Date.now(), bodies = null } = {}) {
  const errors = [];

  const [inspectorListing, applierListing, impactListing, inlineWriterListing] = await Promise.all([
    listPrefix(s3, config.markerBucket, config.inspectorPrefix),
    listPrefix(s3, config.markerBucket, config.applierPrefix),
    // Listed, never read. This marker says an assessment is outstanding and nothing else, so a
    // GetObject on it would buy nothing - the assessment itself arrives by push or from the plan
    // prefix. Its bodies are therefore not in readMarkerBodies below either.
    listPrefix(s3, config.markerBucket, config.impactPrefix),
    // Read, because this one's body is the only thing that says which request took the lock and
    // what it was going to write.
    listPrefix(s3, config.markerBucket, config.inlineWriterPrefix),
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
  const inlineWriterMarkers = inlineWriterListing
    .filter(isMarker(config.inlineWriterPrefix))
    .map(tag('inline_writer', config.inlineWriterPrefix));

  const skipped =
    (inspectorListing.length - inspectorMarkers.length) +
    (applierListing.length - applierMarkers.length) +
    (inlineWriterListing.length - inlineWriterMarkers.length);

  const read = await readMarkerBodies(
    s3, config, [...inspectorMarkers, ...applierMarkers, ...inlineWriterMarkers], bodies, errors,
  );

  const markers = [
    ...describeMarkers(inspectorMarkers, read.bodies, 'inspector', config.inspectorPrefix,
                       now, config.markerGraceSeconds),
    ...describeMarkers(applierMarkers, read.bodies, 'applier', config.applierPrefix,
                       now, config.markerGraceSeconds),
    ...describeMarkers(inlineWriterMarkers, read.bodies, 'inline_writer',
                       config.inlineWriterPrefix, now, config.markerGraceSeconds,
                       { locks: true }),
  ];
  markers.sort((a, b) => (b.age_seconds ?? 0) - (a.age_seconds ?? 0));

  const decided = new Set(
    applierMarkers
      .map((m) => requestIdFromMarkerKey(m.key, config.applierPrefix))
      .filter(Boolean),
  );

  // Which inspections still owe an assessment. Keyed by request id because the inspector names the
  // marker by the inspection, not by the resource - a plan prefix outlives many inspections and only
  // the current one's marker says anything about the plan that is there now.
  const outstandingAssessments = new Set(
    impactListing
      .map((m) => requestIdFromMarkerKey(m.key, config.impactPrefix))
      .filter(Boolean),
  );

  const plans = await collectPlans(s3, config, decided, outstandingAssessments, errors);

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
      // Counted beside the failures rather than beside the plans, because that is what it is: a
      // request that produced nothing and used to leave no trace at all. A number here is what
      // makes "I changed something and nothing happened" answerable at a glance.
      refused: plans.filter((p) => p.state === 'refused').length,
    },
  };
}

/** Everything needed to show one plan, read live rather than from the sweep. */
/** The stored assessment for one plan, or null.
 *
 * The fallback path, and only that. The querier pushes the assessment when it finishes and the page
 * serves it from memory; this exists for the pushes that did not land, for an assessment too large to
 * travel in a request body, and for a process that restarted since.
 *
 * Reading it is one GetObject for a plan somebody actually opened, which is the difference from doing
 * it in the sweep - there it would be one call per open plan whether or not anybody was looking.
 */
export async function readImpact(s3, config, planId) {
  const prefix = planPrefixFromId(planId);
  if (!prefix) return null;

  let document = null;
  try {
    document = await getJson(s3, config.stateBucket, `${prefix}${IMPACT_ARTIFACT}`);
  } catch {
    // No assessment stored. Not an error - a plan approved before its assessment finished is a
    // supported case, and the caller distinguishes "not there" from "not yet" using the marker.
    return null;
  }

  // The querier's own digest, read rather than computed. The same rule as changes.sha256: this
  // process is the component that is not trusted, so it must not author the value that authorises
  // its own approval - it carries the one the container wrote. The applier recomputes over the
  // object and compares, which is what makes carrying it meaningful.
  let storedDigest = null;
  try {
    const raw = await getBytes(s3, config.stateBucket, `${prefix}${IMPACT_DIGEST_ARTIFACT}`);
    const value = raw.toString('utf-8').trim();
    if (isDigest(value)) storedDigest = value;
  } catch {
    storedDigest = null;
  }

  return { document, digest: storedDigest };
}

export async function readPlan(s3, config, planId) {
  const prefix = planPrefixFromId(planId);
  if (!prefix) return null;
  const objects = await listPrefix(s3, config.stateBucket, prefix);
  if (objects.length === 0) return null;

  const byName = new Map(objects.map((o) => [o.key.slice(prefix.length), o]));
  const planObject = byName.get(PLAN_ARTIFACT);
  const refusalObject = byName.get(REFUSAL_ARTIFACT);

  const [planText, configJson, planJson, planBytes, digestText, manifest, outcome, withdrawals,
         refusal] =
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
    // Never matched against the request id, unlike the outcome above. A withdrawal is about the
    // resource and not about any one plan, so an inspection since does not make it stale.
    byName.has(WITHDRAWAL_ARTIFACT)
      ? getJson(s3, config.stateBucket, `${prefix}${WITHDRAWAL_ARTIFACT}`).catch(() => null)
      : Promise.resolve(null),
    // Read here and not carried over from the sweep's row, because the sweep runs on an interval
    // and this reads the prefix as it is when somebody opens it. The gap between the two is exactly
    // when a refusal matters most: an administrator who just changed the resource opens the plan to
    // see what happened.
    refusalObject
      ? getJson(s3, config.stateBucket, `${prefix}${REFUSAL_ARTIFACT}`).catch(() => null)
      : Promise.resolve(null),
  ]);

  const identity = identityFromConfig(configJson);
  const requestId = typeof manifest?.request_id === 'string' ? manifest.request_id : null;
  const mine = outcomeFor(outcome, requestId);

  // What became of the work orders this decision dispatched, read here rather than carried over
  // from the sweep - the sweep runs on an interval and this reads the bucket as it is when somebody
  // opens the page. That gap is exactly when it matters: an approver who just confirmed a grant
  // opens the plan to see whether it landed.
  //
  // Nothing is read at all unless the record names work orders, so a plan that granted nobody -
  // which is most of them - costs the same as before.
  const dispatched = mine ? (outcome?.passrole_dispatch ?? []) : [];
  // And the work orders a STANDALONE withdrawal wrote, which have no plan decision behind them and
  // so appear in no outcome. Read for the same reason as the dispatches above and joined the same
  // way: both are work orders on this resource's grant, and the writer's record is what says
  // whether either landed.
  const withdrawalActions = Array.isArray(withdrawals?.actions) ? withdrawals.actions : [];
  let writers = [];
  let results = new Map();
  const keys = [...new Set(
    [...dispatchKeys(dispatched), ...withdrawalActions.flatMap((a) => dispatchKeys(a?.dispatched))],
  )];
  if (keys.length > 0) {
    const [documents, locked] = await Promise.all([
      Promise.all(keys.map((key) => getJson(
        s3, config.markerBucket, `${config.inlineResultPrefix}${key.slice(
          config.inlineWriterPrefix.length)}`,
      ).then((document) => [key, document]).catch(() => [key, null]))),
      // One listing for every lock, rather than a head per target. The prefix holds one object per
      // permission set with unfinished inline work, which is a handful at most.
      listPrefix(s3, config.markerBucket, config.inlineWriterPrefix).catch(() => []),
    ]);
    results = new Map(documents.filter(([, document]) => document));
    writers = writerVerification(
      dispatched, results, new Set(locked.map((object) => object.key)),
    );
  }

  // The snapshot, brought up to date. passroleFromPlan reads what the inspector saw while
  // generating the plan; every grant and every withdrawal happens after that and touches no plan
  // artifact, so the panel showed the pre-grant state until an unrelated event caused a new
  // inspection - and the holders table, which is the only screen that can take a grant back,
  // showed nobody. See passroleLive.js.
  const passrole = passroleFromPlan(planJson);
  const live = liveGrants({
    snapshot: passrole.granted_to,
    dispatched,
    withdrawals: withdrawalActions,
    results,
    mirrorRoleName: mirrorRoleFromConfig(configJson),
  });

  return {
    plan_id: planId,
    // From request.json, not from the key. A plan is keyed by the governed resource; the request
    // id says which inspection produced the one currently stored, and it is what the approval
    // marker gets named by.
    request_id: requestId,
    // The inspector's own word on whether there is anything to do. A plan with none is stored so
    // that it replaces the previous one, not because it is waiting for somebody.
    has_changes: manifest?.has_changes !== false,

    // What the applier did, if it has finished with this plan. Terminal: a plan with an outcome
    // has been dealt with and is not awaiting anything.
    outcome: mine,

    // And what the INLINE WRITER did with each work order that decision dispatched. Empty on every
    // plan that granted nobody. See writerVerification: `dispatched` in the outcome above means the
    // work order was written, and this is the only thing that says whether the grant was.
    passrole_writers: writers,

    // Why the last inspection produced no plan, when it produced none. Null when nothing was
    // refused, and null when the record describes the inspection that produced the plan standing
    // here - see refusalFor.
    refusal: refusalFor(refusal, requestId, refusalObject),
    // Whether there is a plan in this prefix AT ALL. False on a resource whose first inspection was
    // refused: the page then holds a reason and nothing to decide, and every other field below is
    // empty because there is nothing to fill it with - not because reading failed.
    plan_stored: Boolean(planObject),
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
    // Who asked to be able to pass this mirror role, and to which services. Requests, not grants -
    // except granted_to, which IS a grant and is the live one: the inspector's snapshot with the
    // inline writer's own record of what its runs left standing laid over it.
    passrole: { ...passrole, granted_to: live.holders },
    // Where each of those names came from, so the panel can say so. An approver deciding between
    // "retry" and "revoke" needs to know whether a grant is one the writer confirmed, one the
    // inspector saw, or one whose writer could not answer.
    passrole_live: live,
    // What has been taken back on this resource with no plan decision behind it, oldest first.
    // Read unmatched to any request id on purpose: a withdrawal outlives the plan it was made
    // beside, and matching it to one would make it vanish on the next inspection.
    passrole_withdrawals: Array.isArray(withdrawals?.actions)
      ? withdrawals.actions
        .filter((a) => a && Array.isArray(a.users) && a.users.length > 0)
        .map((a) => ({
          request_id: typeof a.request_id === 'string' ? a.request_id : null,
          users: a.users.filter((u) => typeof u === 'string' && u.trim()),
          reviewer: typeof a.reviewer === 'string' ? a.reviewer : null,
          comment: typeof a.comment === 'string' ? a.comment : '',
          detail: typeof a.detail === 'string' ? a.detail : '',
          finished_at: a.finished_at ?? null,
        }))
      : [],
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
