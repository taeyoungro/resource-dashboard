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

import { putJson } from './s3.js';
import { planPrefixFromId, readPlan } from './sweep.js';

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

const MAX_BODY_BYTES = 16 * 1024;
const MAX_COMMENT = 2000;
const MAX_REVIEWER = 128;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function authorised(config, headerValue) {
  const given = Buffer.from(String(headerValue ?? ''), 'utf-8');
  const expected = Buffer.from(config.apiKey, 'utf-8');
  // Lengths differing is itself the answer, and timingSafeEqual throws rather than returning
  // false when they do, so it is checked first.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
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

function decisionMarker({ config, plan, prefix, payload, now }) {
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

    // What produced this record, so a marker that turns up unexplained can be traced to a build.
    issued_by: {
      component: 'opt-SolutionDashboard',
      release: config.release,
    },
    schema: 1,
  };
}

export function routes({ config, s3, store, log }) {
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

    'GET /api/plans/:id': async ({ params }) => {
      const id = planId(params.id);
      const plan = await readPlan(s3, config, id);
      if (!plan) throw new HttpError(404, `no plan stored for ${id}`);
      return plan;
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
      });
      const key = `${config.applierPrefix}${requestId}.json`;
      const bytes = await putJson(s3, config.markerBucket, key, marker);

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

export { readBody };
