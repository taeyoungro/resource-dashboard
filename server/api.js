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
import { readPlan } from './sweep.js';

// The request id shape the listener produces: <12 digit account>-<16 hex>. Checked because it
// reaches this process from a URL and is then used to build an S3 key.
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

function requestId(raw) {
  const value = decodeURIComponent(raw ?? '');
  if (!REQUEST_ID.test(value)) {
    throw new HttpError(400, `not a request id: ${value.slice(0, 64)}`);
  }
  return value;
}

function decisionMarker({ config, plan, payload, now }) {
  return {
    // What the applier is being asked to do, and to what.
    request_id: plan.request_id,
    account_id: plan.account_id,
    resource: plan.resource,
    decision: payload.decision,

    // Who said so. Self-asserted - see the note at the top of this file.
    reviewer: payload.reviewer,
    comment: payload.comment ?? '',
    decided_at: new Date(now).toISOString(),

    // Which plan was looked at. The applier's first job is to establish that the plan in the
    // bucket is still this one: a digest that no longer matches means the artifact was replaced
    // between the decision and the run, and no approval covers what it now contains.
    plan: {
      bucket: config.stateBucket,
      prefix: `${config.planPrefix}${plan.request_id}/`,
      tfplan_sha256: plan.plan_sha256,
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
      const id = requestId(params.id);
      const plan = await readPlan(s3, config, id);
      if (!plan) throw new HttpError(404, `no plan stored for ${id}`);
      return plan;
    },

    'POST /api/plans/:id/decision': async ({ params, body }) => {
      const id = requestId(params.id);

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

      // Read the plan again rather than trusting what the page was showing. The digest recorded
      // in the marker has to be of the bytes that are in the bucket at the moment of the
      // decision, not of whatever was there when the page last loaded.
      const plan = await readPlan(s3, config, id);
      if (!plan) throw new HttpError(404, `no plan stored for ${id}`);
      if (!plan.plan_sha256) {
        throw new HttpError(409, `${id} has no tfplan; there is nothing to approve`);
      }

      const marker = decisionMarker({ config, plan, payload: { ...body, reviewer, comment },
                                      now: Date.now() });
      const key = `${config.applierPrefix}${id}.json`;
      const bytes = await putJson(s3, config.markerBucket, key, marker);

      log.info(
        'decision request=%s decision=%s reviewer=%s key=s3://%s/%s bytes=%d sha256=%s',
        id, marker.decision, reviewer, config.markerBucket, key, bytes,
        plan.plan_sha256.slice(0, 16),
      );

      // The marker is now the applier's unfinished work. Refresh so the page shows that rather
      // than the row it was just looking at.
      await store.refresh(`decision on ${id}`);
      return { written: `s3://${config.markerBucket}/${key}`, marker };
    },
  };
}

export { readBody };
