// The routes.
//
// One origin: this process serves both the built page and the API, so there is no CORS to relax
// and no second host to keep in step.
//
// Authentication is a shared key, and that is a coarse gate rather than an identity. It says the
// caller reached this box with the secret; it does not say who they are. The reviewer field on a
// decision is therefore self-asserted, and it stays that way until something in front of this
// server establishes a person - an application load balancer doing OIDC, or Identity Center. The
// decision is recorded with whatever name was given, and CloudTrail records the role, so the
// gap is between the two and is worth knowing about rather than being reassured out of.

import { timingSafeEqual } from 'node:crypto';

import { NotificationError, parse as parseNotification } from './notifications.js';
import { putJson } from './s3.js';
import { ImpactError, parse as parseImpact } from './impacts.js';
import { planPrefixFromId, readImpact, readPlan } from './sweep.js';

// A plan is identified by the governed resource it belongs to, not by the request that produced
// it: <12 digit account>:<resource>. One resource has one state and one plan, and a second edit
// replaces the first rather than adding a second thing to decide about.
//
// The resource part is an IAM policy name, whose character set is [\w+=,.@-]. Checked because this
// value reaches the process from a URL and is then used to build an S3 key - none of those
// characters is / or ., so no traversal can be spelled with them.
const PLAN_ID = /^\d{12}:[\w+=,.@-]{1,96}$/;

// The request id shape the listener produces: <12 digit account>-<16 hex>. It is no longer in any
// key, but the approval marker is still named by it, so it is checked before being made into one.
const REQUEST_ID = /^\d{12}-[0-9a-f]{16}$/;

// A decision is a reviewer, a comment and a digest. Anything larger is not one.
const MAX_BODY_BYTES = 16 * 1024;
const MAX_COMMENT = 2000;
const MAX_REVIEWER = 128;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sameKey(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf-8');
  const b = Buffer.from(String(expected ?? ''), 'utf-8');
  // Lengths differing is itself the answer, and timingSafeEqual throws rather than returning
  // false when they do, so it is checked first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function authorised(config, headerValue) {
  return sameKey(headerValue, config.apiKey);
}

/** The ingest key, and only the ingest key.
 *
 * Deliberately not "the API key also works". The two keys mark two different callers - a person
 * at a browser who may approve IAM changes, and a machine that may say a task started - and a
 * route that accepted both would make the distinction advisory. An unset ingest key authorises
 * nothing, which is why the route reports itself as off rather than open.
 */
export function authorisedToAnnounce(config, headerValue) {
  if (!config.ingestKey) return false;
  return sameKey(headerValue, config.ingestKey);
}

/** Which key opens a route. Everything not listed here needs the dashboard's own key. */
// Bounded so one decision cannot post an unbounded document. The inline policy has a byte ceiling
// of its own that the writer enforces; this is only to keep a single request sane.
const MAX_RESTRICTIONS = 50;

// The three forms, and they are not interchangeable - they produce different statements and go stale
// in different directions. See event_pipeline code/generator/restriction.py.
const RESTRICTION_INTENTS = new Set(['allow_only', 'deny_only', 'tag_condition']);

export const INGEST_ROUTES = new Set([
  'POST /api/notifications',
  // The impact querier's delivery. Same key as the listener's announcements and deliberately so:
  // both are machines saying what they did, and neither may approve anything. The dashboard's own
  // key - the one that CAN approve an IAM change - opens neither.
  'POST /api/impact',
]);

export async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, `request body larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new HttpError(400, 'request body is not JSON');
  }
}

function planId(raw) {
  const value = decodeURIComponent(raw ?? '');
  if (!PLAN_ID.test(value)) {
    throw new HttpError(400, `not a plan id: ${value.slice(0, 64)}`);
  }
  return value;
}

function decisionMarker({ config, plan, prefix, payload, now, restrictions = [], impactDigest = '' }) {
  return {
    // What the applier is being asked to do, and to what.
    request_id: plan.request_id,
    plan_id: plan.plan_id,
    account_id: plan.account_id,
    resource: plan.resource,
    decision: payload.decision,

    // Who said so. Self-asserted - see the note at the top of this file.
    reviewer: payload.reviewer,
    comment: payload.comment ?? '',
    decided_at: new Date(now).toISOString(),

    // What was approved, in two values that answer two different questions.
    //
    // The generated document names no role - it names a profile, and each container decides what
    // that profile means in a file that never enters the plan. So the saved plan is portable: the
    // applier runs the very file the inspector produced and a person approved. The binding is
    // therefore the file itself.
    //
    //   tfplan_sha256    the binary the applier is about to run is the binary that was approved
    //   changes_sha256   the plan.txt and plan.json that person read describe that binary
    //
    // The second is not implied by the first. The prefix holds five separate objects, and a
    // partial overwrite could leave a tfplan from one plan beside a plan.txt from another - the
    // approver would have read a true-looking description of something else. The applier checks it
    // by running terraform show -json on the plan it holds.
    //
    // changes_sha256 is copied from the prefix's changes.sha256, which the inspector wrote. It is
    // never computed here: the dashboard is the component that is not trusted, so it must not be
    // the author of a value that authorises its own approval.
    changes_sha256: plan.changes_sha256,

    plan: {
      bucket: config.stateBucket,
      prefix,
      tfplan_sha256: plan.plan_file_sha256,
      tfplan_etag: plan.plan_etag,
      tfplan_bytes: plan.plan_bytes,
      planned_at: plan.planned_at,
    },

    // The administrator's restriction, as DECISIONS rather than as a policy document.
    //
    // This process does not author IAM content. If it sent a document the applier passed through,
    // a defect or a compromise here could write Allow where somebody clicked Deny - so what travels
    // is what was chosen, and the inline writer builds the statements and refuses anything that
    // cannot become one.
    //
    // Both fields are omitted when there is no restriction, which keeps an ordinary approval byte
    // for byte what it was before this existed.
    ...(restrictions.length > 0
      ? { restrictions, expected_impact_sha256: impactDigest }
      : {}),

    // What produced this record, so a marker that turns up unexplained can be traced to a build.
    issued_by: {
      component: 'opt-SolutionDashboard',
      release: config.release,
    },
    schema: 1,
  };
}

export function routes({ config, s3, store, notifications, markerBodies, impacts, actions, log }) {
  // Announcements ask for a sweep, because learning that work started is most of what they are
  // for. Rate limited: a burst of dispatches is a normal thing (one administrator attaching five
  // policies) and would otherwise be a burst of full bucket listings.
  let lastNotificationSweep = 0;

  return {
    // No authentication: a health check that needs a secret is a health check that reports the
    // secret being wrong as the service being down.
    'GET /api/health': async () => ({
      status: 'ok',
      release: config.release,
      swept_at: store.get()?.swept_at ?? null,
    }),

    'GET /api/state': async () => {
      const state = store.get();
      if (!state) throw new HttpError(503, 'the first sweep has not finished');
      return state;
    },

    'POST /api/sweep': async () => {
      await store.refresh('requested from the page');
      return store.get();
    },

    // Posted by the listener after it has dispatched an inspection and acknowledged the queue.
    //
    // This is an announcement and NOT a state. Nothing here changes what the page believes about
    // markers or plans - the sweep decides that, from the buckets, and it will contradict a
    // fabricated announcement on its next pass. What this buys is latency: the page learns that
    // work started in seconds instead of at the next sweep interval.
    //
    // So a failure here is not the listener's problem. It answers with a status and no retry
    // advice, because the listener must not retry: the marker is already in S3 and the sweep will
    // find it whatever happens to this request.
    'POST /api/notifications': async ({ body }) => {
      if (!config.ingestKey) {
        throw new HttpError(503, 'OPT_DASHBOARD_INGEST_KEY is not set; announcements are off');
      }
      let entry;
      try {
        entry = parseNotification(body);
      } catch (err) {
        if (err instanceof NotificationError) throw new HttpError(400, err.message);
        throw err;
      }

      // The body goes to the cache the sweep reads, the row goes to the panel. Same request, two
      // consumers, and only one of them wants ten kilobytes.
      if (entry.marker_body) {
        markerBodies.put(entry.kind, entry.request_id, entry.marker_body, 'announced');
      }

      const now = Date.now();
      const recorded = notifications.record(entry, now);
      log.info(
        'announced kind=%s request=%s resource=%s account=%s events=%d body=%s repeats=%d',
        recorded.kind, recorded.request_id, recorded.resource ?? '-',
        recorded.account_id ?? '-', recorded.event_count ?? 0,
        entry.marker_body ? 'held' : (entry.body_omitted ? 'too-large' : 'absent'),
        recorded.repeats,
      );

      // Not awaited. The announcement is answered as soon as it is recorded, so a slow sweep
      // cannot hold the listener's socket open - the listener gives this call a short timeout and
      // anything slower than that would be a hang it has to survive rather than wait for.
      const due = now - lastNotificationSweep >= config.notificationSweepSeconds * 1000;
      if (due) {
        lastNotificationSweep = now;
        store.refresh(`announced ${recorded.kind} ${recorded.request_id}`).catch(() => {
          // Already logged by the store, and a failed sweep must not turn into a failed
          // announcement - the two are independent and the next sweep will run anyway.
        });
      }

      return { recorded: recorded.id, swept: due };
    },

    // What has been announced recently, newest first. Emptied by a restart on purpose: these are
    // announcements, and everything durable about them is in the buckets.
    'GET /api/notifications': async () => ({
      notifications: notifications.list(),
      enabled: Boolean(config.ingestKey),
    }),

    // Posted by the impact querier when it has finished assessing a plan.
    //
    // This carries the assessment itself rather than telling the page to go and fetch it, because
    // the alternative was a GetObject per open plan on every sweep - a cost that scales with how
    // many plans are open and buys nothing.
    //
    // It is still not a state. impact.json is in the state bucket with its digest beside it, and the
    // impact/ marker is what says an assessment is outstanding; both are read from the buckets. So a
    // push that never lands costs latency and one call for a plan somebody opens, which is what lets
    // the querier post once and never retry.
    'POST /api/impact': async ({ body }) => {
      if (!config.ingestKey) {
        throw new HttpError(503, 'OPT_DASHBOARD_INGEST_KEY is not set; impact delivery is off');
      }
      let entry;
      try {
        entry = parseImpact(body);
      } catch (err) {
        if (err instanceof ImpactError) throw new HttpError(400, err.message);
        throw err;
      }

      impacts.put(entry);
      log.info(
        'impact request=%s account=%s resource=%s digest=%s omitted=%s resources=%s',
        entry.request_id, entry.account_id, entry.resource, entry.impact_sha256.slice(0, 12),
        entry.body_omitted, entry.summary?.resources ?? '?',
      );

      // No sweep is asked for. The assessment does not change what markers or plans exist, and the
      // page reads it from the plan route when somebody opens the plan.
      return { recorded: entry.request_id, body_omitted: entry.body_omitted };
    },

    // The IAM action catalogue, so the restriction screen offers a list instead of asking somebody
    // to type an action name.
    //
    // Read from a file into memory at startup, and NOT a trust boundary. Every action chosen from it
    // is checked in the decision route below against what the plan actually grants and against the
    // protected set, and checked again by the inline writer. An action missing from the file can
    // still be typed; one wrongly in it is refused with a sentence.
    //
    // error is carried rather than hidden: a catalogue that failed to load leaves the screen working
    // exactly as it did before the file existed, and the page says so instead of silently showing
    // fewer services than somebody expects.
    'GET /api/actions': async () => actions.all(),

    'GET /api/plans/:id': async ({ params }) => {
      const id = planId(params.id);
      const plan = await readPlan(s3, config, id);
      if (!plan) throw new HttpError(404, `no plan stored for ${id}`);

      // The assessment, from the push if it landed and from the bucket if it did not.
      //
      // Matched on the plan's CURRENT request id, never on the plan id. A prefix is overwritten in
      // place by every inspection, so a cached assessment from an earlier one describes a plan that
      // no longer exists - and showing it beside a fresh plan.txt is exactly the mismatch the
      // digest checks exist to prevent, arriving through the display instead.
      let assessment = null;
      let source = null;
      if (plan.request_id) {
        const pushed = impacts.get(plan.request_id);
        if (pushed && !pushed.body_omitted && pushed.impact?.request_id === plan.request_id) {
          assessment = pushed.impact;
          source = 'pushed';
        }
      }
      let digest = null;
      if (!assessment) {
        const stored = await readImpact(s3, config, id);
        if (stored?.document
            && (!plan.request_id || stored.document.request_id === plan.request_id)) {
          assessment = stored.document;
          digest = stored.digest;
          source = 'stored';
        }
      }

      // The digest the page has to send back with a restriction. Not computed here - see readImpact.
      return { ...plan, assessment, assessment_source: source, assessment_sha256: digest };
    },

    'POST /api/plans/:id/decision': async ({ params, body }) => {
      const id = planId(params.id);

      if (body.decision !== 'approve' && body.decision !== 'deny') {
        throw new HttpError(400, 'decision must be "approve" or "deny"');
      }
      const reviewer = String(body.reviewer ?? '').trim();
      if (!reviewer) throw new HttpError(400, 'reviewer is required');
      if (reviewer.length > MAX_REVIEWER) throw new HttpError(400, 'reviewer is too long');
      const comment = String(body.comment ?? '').trim();
      if (comment.length > MAX_COMMENT) throw new HttpError(400, 'comment is too long');
      if (body.decision === 'deny' && !comment) {
        // Approving needs no words - the plan is the reason. Refusing does: the person whose
        // change was refused has nothing else to read.
        throw new HttpError(400, 'a denial needs a reason');
      }

      // Read the plan again rather than trusting what the page was showing. The digests recorded
      // in the marker have to be of the bytes that are in the bucket at the moment of the
      // decision, not of whatever was there when the page last loaded.
      const plan = await readPlan(s3, config, id);
      if (!plan) throw new HttpError(404, `no plan stored for ${id}`);
      if (!plan.plan_file_sha256) {
        throw new HttpError(409, `${id} has no tfplan; there is nothing to approve`);
      }
      if (!plan.has_changes) {
        // The twin already matches the spec. The plan is stored so that it replaces the previous
        // one, not because anybody has to decide about it, and approving it would ask the applier
        // to run a plan that does nothing.
        throw new HttpError(409, `${id} has no changes; there is nothing to decide`);
      }
      if (plan.outcome) {
        // The applier has finished with this plan and outcome.json records what it did. A second
        // decision would write a marker for a plan whose state has already moved, and the applier
        // would refuse it at the point of apply - terraform will not run a saved plan against
        // state that changed under it. Refused here instead, where the reason can be read.
        throw new HttpError(
          409,
          `${id} was already ${plan.outcome.applied ? 'applied' : 'closed'} by `
          + `${plan.outcome.reviewer ?? 'somebody'}. Change the resource again to get a fresh plan.`,
        );
      }
      // Refused rather than approved without one. The plan file hash establishes that the applier
      // runs the approved file; it does not establish that the plan.txt the approver just read
      // describes that file, and a prefix is five separate objects. Plans written before the
      // inspector produced this artifact land here; re-inspecting produces one that can be
      // approved.
      if (!plan.changes_sha256) {
        throw new HttpError(
          409,
          `${id} has no changes.sha256, so nothing would establish that the plan shown describes `
          + 'the file that would be applied. It was planned by an inspector that did not write '
          + 'one - change the resource again to get a fresh plan.',
        );
      }

      // A decision is about the plan the reviewer read, and only that one.
      //
      // This became necessary when plans moved to one-per-governed-resource. The prefix is now
      // overwritten in place by every new inspection, so between the page rendering plan.txt and
      // this request arriving, an edit to the same resource can have replaced the plan entirely.
      // Without this check the server would read the NEW plan, record its digests, and file an
      // approval for something the reviewer never saw - and every downstream check would pass,
      // because the marker and the bucket would agree perfectly with each other.
      //
      // The page sends back the digest it displayed. Different value, no decision.
      const expected = String(body.expected_changes_sha256 ?? '').trim();
      if (!expected) {
        throw new HttpError(400, 'expected_changes_sha256 is required: a decision names the plan '
                                 + 'it was made about');
      }
      if (expected !== plan.changes_sha256) {
        throw new HttpError(
          409,
          `${id} was re-planned since it was shown. The stored plan is now ${plan.changes_sha256}`
          + `, not ${expected}. Reload and read the current plan before deciding.`,
        );
      }

      // ---- an approval may also carry a restriction ------------------------------------------
      //
      // Optional, and absent is the ordinary case. A plan can be approved with no restriction at
      // all, and deliberately can be approved before its assessment even exists - making the
      // approval path depend on the querier would turn an assessment outage into a pipeline outage.
      //
      // What a restriction needs is the assessment, because a restriction NAMES RESOURCES and the
      // enumerated set is the only fence those names can be checked against. So the pair travels
      // together: the decisions, and the digest of the assessment they were made from.
      //
      // The checks below are for a readable error, not for safety. The inline writer recomposes the
      // document from these decisions and re-validates every one of them against the fence it is
      // handed - it has to, because this process is the component that is not trusted. Catching an
      // impossible restriction here means the person who chose it hears why now, rather than an
      // approval sitting in a bucket and a container refusing it later.
      const restrictions = body.restrictions ?? [];
      if (!Array.isArray(restrictions)
          || restrictions.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
        throw new HttpError(400, 'restrictions must be an array of objects');
      }
      let impactDigest = '';
      if (restrictions.length > 0) {
        if (body.decision !== 'approve') {
          throw new HttpError(400, 'a denial cannot carry a restriction: nothing is being granted');
        }
        if (restrictions.length > MAX_RESTRICTIONS) {
          throw new HttpError(400, `at most ${MAX_RESTRICTIONS} restrictions per decision`);
        }

        const stored = await readImpact(s3, config, id);
        if (!stored?.document) {
          throw new HttpError(
            409,
            `${id} has no impact assessment stored, so there is nothing to check the restricted `
            + 'resources against. Approve without a restriction, or wait for the assessment.',
          );
        }
        if (!stored.digest) {
          throw new HttpError(
            409,
            `${id} has an assessment with no impact.sha256 beside it, so nothing would establish `
            + 'that the assessment shown is the one the applier reads.',
          );
        }
        if (requestId && stored.document.request_id !== requestId) {
          // The assessment belongs to an inspection this plan replaced. Its enumerated resources
          // describe a permission set that is not the one being approved.
          throw new HttpError(
            409,
            `the stored assessment is for request ${stored.document.request_id}, and this plan is `
            + `${requestId}. Reload - the assessment for the current plan is not ready.`,
          );
        }

        // Same rule as expected_changes_sha256: the page sends back what it displayed, and a
        // different value means it was showing an assessment that has since been replaced.
        const expectedImpact = String(body.expected_impact_sha256 ?? '').trim();
        if (!expectedImpact) {
          throw new HttpError(400, 'expected_impact_sha256 is required with a restriction: it names '
                                   + 'the assessment the restriction was chosen from');
        }
        if (expectedImpact !== stored.digest) {
          throw new HttpError(
            409,
            `${id} was re-assessed since it was shown. The stored assessment is now `
            + `${stored.digest}, not ${expectedImpact}. Reload and choose again.`,
          );
        }

        const enumerated = new Set(stored.document.allowed_resources ?? []);
        const protectedActions = new Set(stored.document.protected_actions ?? []);
        for (const restriction of restrictions) {
          if (!RESTRICTION_INTENTS.has(restriction.intent)) {
            throw new HttpError(400, `restriction intent must be one of `
                                     + `${[...RESTRICTION_INTENTS].join(', ')}`);
          }
          const actions = Array.isArray(restriction.actions) ? restriction.actions : [];
          if (actions.length === 0 || actions.some((a) => typeof a !== 'string' || !a.trim())) {
            throw new HttpError(400, 'a restriction needs at least one action, as strings');
          }
          for (const action of actions) {
            if (action.trim() === '*' || action.trim().startsWith('*')) {
              throw new HttpError(400, `a wildcard action cannot be restricted (${action}): with `
                                       + 'NotResource it would deny everything outside the list');
            }
            if (protectedActions.has(action.trim())) {
              throw new HttpError(
                400,
                `${action} is part of the declaration path and cannot be restricted. It is how a `
                + 'user writes a spec, and restricting it would leave them unable to request the fix.',
              );
            }
          }
          const named = Array.isArray(restriction.resources) ? restriction.resources : [];
          for (const arn of named) {
            if (typeof arn !== 'string' || !enumerated.has(arn)) {
              throw new HttpError(
                400,
                `${String(arn).slice(0, 120)} is not in the impact assessment. A restriction may `
                + 'only name resources the assessment enumerated.',
              );
            }
          }
        }

        // Carried, never computed here. The querier wrote it; the applier recomputes over the
        // object and compares.
        impactDigest = stored.digest;
      }

      // The marker is named by the inspection that produced this plan, not by the resource: the
      // name has to fit ECS startedBy, which is 36 characters of [A-Za-z0-9/_-] and would not hold
      // a resource name. Checked rather than trusted - it arrives from an object in a bucket.
      const requestId = String(plan.request_id ?? '');
      if (!REQUEST_ID.test(requestId)) {
        throw new HttpError(
          409,
          `${id} has no usable request id in request.json (${requestId.slice(0, 64) || 'absent'}), `
          + 'so the approval marker cannot be named. Change the resource again to get a fresh plan.',
        );
      }

      const marker = decisionMarker({
        config, plan, prefix: planPrefixFromId(id),
        payload: { ...body, reviewer, comment }, now: Date.now(),
        restrictions, impactDigest,
      });
      const key = `${config.applierPrefix}${requestId}.json`;
      const bytes = await putJson(s3, config.markerBucket, key, marker);

      // This process wrote it, so it knows what is in it. Reading it back out of S3 on the next
      // sweep was always a round trip to learn something it had just decided.
      markerBodies.put('applier', requestId, marker, 'written-here');

      log.info(
        'decision plan=%s request=%s decision=%s reviewer=%s key=s3://%s/%s bytes=%d changes=%s',
        id, requestId, marker.decision, reviewer, config.markerBucket, key, bytes,
        plan.changes_sha256.slice(0, 16),
      );

      // The marker is now the applier's unfinished work. Refresh so the page shows that rather
      // than the row it was just looking at.
      await store.refresh(`decision on ${id}`);
      return { written: `s3://${config.markerBucket}/${key}`, marker };
    },
  };
}

