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

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { NotificationError, parse as parseNotification } from './notifications.js';
import { TaskFailureError, makeTaskFailures, parseReport, retryTarget }
  from './taskFailures.js';
import { getBytes, getBucketPolicy, listBuckets, putBytes, putJson } from './s3.js';
import { openStatements, parsePolicy, readPolicy, sameAccountOf } from './bucketPolicy.js';
import { governedPrincipals } from './governedPrincipals.js';
import { ImpactError, parse as parseImpact } from './impacts.js';
import { nothingRestricted, planPrefixFromId, readImpact, readPlan, reclassify } from './sweep.js';
import { controlPlane } from './controlPlane.js';
import { condense, digestBytes } from './riskDigest.js';
import { candidates as proposeCandidates } from './candidatePaths.js';
import { loadTemplates } from './templates.js';
import { findings as ruleFindings, sections, summary } from './findings.js';
import { referenceIndex } from './capabilities.js';
import { overlapCount, withOverlap } from './overlap.js';
import { RULES_SHA256, RULE_ACTIONS } from './rules.js';
import { AnalysisError, PROMPT_VERSION, analyse, bedrockClient } from './riskAnalysis.js';
import { DONE, asJson, runStore } from './runs.js';

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
// One restriction per ACTION now, not per policy, and 전체 선택 in the picker makes a hundred of them
// one click. This is a sanity bound, not the real limit: the real one is the permission set inline
// policy quota of 10,240 bytes, which a hundred single-ARN statements already exceed. The page
// estimates that and says so before submitting, and generator/restriction.py measures it exactly.
const MAX_RESTRICTIONS = 200;

// The five forms, and they are not interchangeable - they produce different statements and go stale
// in different directions. See event_pipeline code/generator/restriction.py.
//
// They are also composable: one policy may carry a decision of each, arriving as separate entries in
// this list. deny_action is the same STATEMENT as deny_only with an empty resource list and a
// different DECISION - an empty deny_only is a forgotten pick and is still refused as one, while
// deny_action is the action chosen for itself and is refused for nothing. key_condition gates the
// action on a request condition key the action itself declares; its operator default is
// StringNotEquals, filled in at parse on the writing side, so absence is not a third state.
const RESTRICTION_INTENTS = new Set([
  'allow_only', 'deny_only', 'deny_action', 'tag_condition', 'key_condition',
]);
const CONDITION_OPERATORS = new Set(['StringNotEquals', 'StringEquals']);
// The two intents whose statement carries a Condition, and so the two that may carry an operator.
// tag_condition joined them when its branch stopped hardcoding StringEquals - the open form, under
// which a resource carrying no such tag at all does not match and walks past the control.
const CONDITION_INTENTS = new Set(['tag_condition', 'key_condition']);

// Deployment configuration, read once at first use. undefined means "not yet read"; [] with an
// error set means the file is unusable and the page gets no template section - the closed
// direction, because a template that half-loaded would seed a restriction nobody wrote.
let templates;
let templateError = null;

export const INGEST_ROUTES = new Set([
  'POST /api/notifications',
  // The impact querier's delivery. Same key as the listener's announcements and deliberately so:
  // both are machines saying what they did, and neither may approve anything. The dashboard's own
  // key - the one that CAN approve an IAM change - opens neither.
  'POST /api/impact',
  // opt-SolutionTaskFailureNotifier, saying a container stopped badly and which object started it.
  // Same key and the same reasoning: a machine reporting what happened. The RETRY it makes possible
  // is a separate route under the dashboard's own key, because re-running a container is a decision
  // and this is a report.
  'POST /api/task-failures',
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

/**
 * The analysis the approver read, as a citation on the marker.
 *
 * Four values and no content. The findings themselves are not carried: they are advisory text and
 * the applier has no use for them, whereas "this decision was taken while looking at analysis
 * <findings_sha256> of assessment <impact_sha256>, produced by <model> under prompt <version>" is
 * the sentence that makes the record answerable later. impact_sha256 is checked against the stored
 * digest before it gets here, so the citation cannot name an assessment nobody assessed.
 */
function analysisCitation(claim, impactDigest) {
  if (!claim || typeof claim !== 'object') return null;
  const findings = String(claim.findings_sha256 ?? '').trim();
  const model = String(claim.model_id ?? '').trim();
  const prompt = String(claim.prompt_version ?? '').trim();
  const impact = String(claim.impact_sha256 ?? '').trim();
  if (!/^[0-9a-f]{64}$/.test(findings)) {
    throw new HttpError(400, 'risk_analysis.findings_sha256 must be a sha256 hex digest');
  }
  if (!model || model.length > 128) throw new HttpError(400, 'risk_analysis.model_id is required');
  if (!prompt || prompt.length > 64) {
    throw new HttpError(400, 'risk_analysis.prompt_version is required');
  }
  if (!impactDigest) {
    throw new HttpError(400, 'risk_analysis cannot be recorded without a verified assessment digest');
  }
  if (impact !== impactDigest) {
    // The page is claiming an analysis of a different assessment from the one this decision is
    // being taken against. Refused rather than dropped: it means the screen and the bucket had
    // drifted apart, which is the one thing every digest check here exists to catch.
    throw new HttpError(409,
      'risk_analysis.impact_sha256 does not match the stored assessment; reload the plan');
  }
  return { findings_sha256: findings, model_id: model, prompt_version: prompt,
           impact_sha256: impact };
}

/**
 * Whether an assessment from ANOTHER inspection still describes this plan.
 *
 * True only when the plan moves no resource. A prefix is overwritten in place by every inspection,
 * so an assessment from a previous one normally describes a permission set the current plan does
 * not produce - which is why the request ids are compared at all. That reasoning holds for a plan
 * that CHANGES something and not for one that changes nothing: a passrole tag starts an inspection
 * whose plan touches no IAM resource, so its new request id is a different inspection of an
 * identical permission set.
 *
 * One function because two routes need the same answer and they used to disagree. The detail route
 * was taught this and the analysis route was not, so a tagged role showed its assessment and then
 * refused to analyse it - "the stored assessment describes <id> and this plan is <id>". Same rule,
 * one place.
 *
 * It never makes an assessment authoritative. What rides on the id matching is the DIGEST, and the
 * caller withholds that: a restriction is validated against the assessment an approver read, and
 * this is not that one.
 */
function describesPlan(plan, document) {
  if (!plan?.request_id || document?.request_id === plan.request_id) return true;
  return (plan.changes ?? []).length === 0;
}

/**
 * A fresh request id in the listener's shape: <12 digit account>-<16 hex>.
 *
 * Minted here rather than reusing the plan's, and the reason is the marker's other meaning. While
 * an approval marker exists, that applier task did not complete - so naming a retry after the
 * decision it retries would put a second retry under the same key as the first, silently replacing
 * a work order somebody is still waiting on. A distinct id gives each attempt its own object, its
 * own row when it fails, and its own entry in the record.
 *
 * Random rather than counted: nothing here holds a counter, and two administrators retrying the
 * same plan in the same second must not collide.
 */
function retryRequestId(accountId) {
  return `${accountId}-${randomBytes(8).toString('hex')}`;
}

function decisionMarker({ config, plan, prefix, payload, now, restrictions = null, impactDigest = '',
                         passroleGrantTo = [], passroleRevokeFrom = [], analysis = null }) {
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
    // restrictions is omitted when the decision says NOTHING about them, and carried otherwise -
    // an empty list included, because [] is an answer. It says there are none, and the writer
    // clears the family it finds standing. Omitting it there would say the opposite: carry them
    // forward, which is how emptying the form used to change nothing at all.
    //
    // The digest travels whenever a stored assessment was verified to be the one the page
    // displayed - with any restriction answer it is REQUIRED (a named restriction is validated
    // against that assessment, a clear against the inline_sha256 inside it), and without one it is
    // what lets the applier read the assessment's passrole_grants and dispatch the PassRole fence.
    // An approval with neither carries neither, exactly as before.
    ...(restrictions !== null ? { restrictions } : {}),
    ...(impactDigest ? { expected_impact_sha256: impactDigest } : {}),

    // Whose PassRole request this approval CONFIRMS. Names only, and omitted when nobody was
    // ticked - which is the ordinary case, because approving a mirror role plan grants nothing.
    //
    // Names are all that travels, for the same reason restrictions travel as decisions: what the
    // grant actually says - which role, conditioned on which services - is read by the applier from
    // the plan's own outputs. This tier says who was confirmed and never what they get.
    ...(passroleGrantTo.length > 0 ? { passrole_grant_to: passroleGrantTo } : {}),

    // And whose it WITHDRAWS. Same carriage, opposite direction, and the only path that removes a
    // grant: the writer keeps every grant a dispatch does not name, so an absence removes nothing.
    ...(passroleRevokeFrom.length > 0 ? { passrole_revoke_from: passroleRevokeFrom } : {}),

    // What the approver was looking at, if an analysis was run. Advisory, and cited rather than
    // copied - the applier does nothing with it, and a record that cannot be traced to the analysis
    // it was taken against is the thing worth avoiding.
    ...(analysis ? { risk_analysis: analysis } : {}),

    // What produced this record, so a marker that turns up unexplained can be traced to a build.
    issued_by: {
      component: 'opt-SolutionDashboard',
      release: config.release,
    },
    schema: 1,
  };
}

export function routes({ config, s3, store, notifications, markerBodies, impacts, log,
                         taskFailures = makeTaskFailures(),
                         makeModelClient = bedrockClient, runs = runStore() }) {
  // Announcements ask for a sweep, because learning that work started is most of what they are
  // for. Rate limited: a burst of dispatches is a normal thing (one administrator attaching five
  // policies) and would otherwise be a burst of full bucket listings.
  let lastNotificationSweep = 0;

  /**
   * The sweep, with running-versus-failed decided now rather than whenever it last ran.
   *
   * Two inputs the sweep cannot have had: the clock, and every failure report that arrived since.
   * A report is a FACT - ECS said the task stopped - and it ends the grace period for that one
   * marker, which is what stops the page counting a container it is showing the exit code for as
   * still running.
   */
  const judged = (state) => reclassify(state, {
    graceSeconds: config.markerGraceSeconds,
    stoppedAt: (key) => taskFailures.stoppedAt(key),
  });

  /** How a run looks to the page right now. */
  const runState = (entry) => ({
    ...asJson(entry, runs.elapsed(entry)),
    // Which assessment it is about. The page holds that digest and refuses a citation that does
    // not match it, so a run left over from a replaced assessment cannot be read as this answer.
    impact_sha256: entry.key,
  });

  /**
   * A finished answer with the run's CURRENT state on it.
   *
   * Always recomputed, never the copy stored in the answer. The task takes its copy of the answer
   * before it starts, so the run field frozen into it says `running` forever - and a second press
   * of the button would hand back a finished analysis labelled as still going, which sends the page
   * off polling for something it already has.
   */
  const withRun = (answer, entry) => ({ ...answer, run: runState(entry) });

  // Built on first use and kept. Built lazily because the package it needs is only there for a
  // deployment that enabled the analysis, and injectable because the tests must be able to exercise
  // this route without Bedrock.
  let client = null;
  async function modelClient() {
    // The region and nothing else. Which model is called is a field in the request, not a choice of
    // client - everything goes through Converse.
    if (!client) {
      client = await makeModelClient({
        region: config.region,
        // An optional field the endpoint refused. The run still answered, under a configuration it
        // did not ask for, and that is worth a line rather than a silence.
        onDegrade: ({ dropped, why }) => log.warn(
          'analysis dropped %s and retried: %s', Object.keys(dropped).join(','), why),
        // Throttling. Expected now that batches go out together, and worth a line rather than a
        // silence: a run that spent half its budget waiting is a run whose concurrency is too high
        // for this account, and nothing else would say so.
        onRetry: ({ attempt, waitMs, why }) => log.warn(
          'analysis throttled attempt=%d waiting=%dms: %s', attempt, waitMs, why),
      });
    }
    return client;
  }

  return {
    // No authentication: a health check that needs a secret is a health check that reports the
    // secret being wrong as the service being down.
    'GET /api/health': async () => ({
      status: 'ok',
      release: config.release,
      swept_at: store.get()?.swept_at ?? null,
      // Analyses this process is holding. Here because it is the one piece of state the dashboard
      // keeps in memory and loses on restart, and because an operator asking "is it working or is
      // it stuck" should not have to open a browser to find out - which is exactly what the 504
      // forced, back when the model call lived inside its own request.
      analysis_runs: runs.size(),
    }),

    // The standard restrictions this deployment offers, for the page to pre-fill the editor with.
    //
    // Read once at first use and cached, like the rule file: it is deployment configuration, not
    // account state. A malformed file makes the route report the reason and offer nothing - the
    // page then simply has no template section, which is the closed direction: a template that
    // half-loaded would seed a restriction nobody wrote.
    'GET /api/templates': async () => {
      if (templates === undefined) {
        try {
          templates = loadTemplates(JSON.parse(
            readFileSync(new URL('./restriction-templates.json', import.meta.url), 'utf-8')));
          templateError = null;
        } catch (error) {
          templates = [];
          templateError = error instanceof Error ? error.message : String(error);
          log.warn('restriction templates unusable', { reason: templateError });
        }
      }
      return { templates, error: templateError };
    },

    // ---- the resource policy review ------------------------------------------------------------
    //
    // A READ, and the whole of it. The dashboard names the buckets in this account and reads one
    // bucket's policy so it can answer "which of the roles and permission sets we issued does this
    // policy speak about". It holds no s3:PutBucketPolicy and must not: a host able to edit a
    // resource policy could open a bucket to the internet, and this one is the approval screen.
    //
    // Off unless asked for. See config.resourcePolicyReview for what turning it on widens.
    'GET /api/buckets': async () => {
      if (!config.resourcePolicyReview) {
        throw new HttpError(503, 'the resource policy review is off - set OPT_RESOURCE_POLICY_REVIEW=on '
          + 'and grant s3:ListAllMyBuckets and s3:GetBucketPolicy to this host');
      }
      return {
        buckets: await listBuckets(s3),
        // Which account these are in, when the deployment was told. The review needs it to know
        // whether a governed principal is inside the bucket's account or outside it.
        account_id: config.accountId,
      };
    },

    'GET /api/buckets/:bucket/review': async ({ params }) => {
      if (!config.resourcePolicyReview) {
        throw new HttpError(503, 'the resource policy review is off - set OPT_RESOURCE_POLICY_REVIEW=on');
      }
      const bucket = String(params.bucket ?? '');
      // Bucket naming rules, applied here because this value goes into an AWS call. Not a security
      // boundary - the role's own permissions are that - but a malformed name should be refused
      // with a reason rather than sent to S3 to produce a less useful one.
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
        throw new HttpError(400, 'that is not a bucket name');
      }

      const state = store.get();
      const principals = governedPrincipals(state, { mirrorPrefix: config.mirrorPrefix });

      const text = await getBucketPolicy(s3, bucket);
      if (text === null) {
        // No policy at all. Said as its own answer rather than as an empty document: a bucket with
        // no policy grants nothing across accounts and denies nothing here, and an empty document
        // would be read as the second half only.
        return {
          bucket,
          account_id: config.accountId,
          has_policy: false,
          policy: null,
          document_text: null,
          principals: principals.map((principal) => ({
            principal, outcome: 'SILENT', sameAccount: sameAccountOf(principal, config.accountId),
            statements: [], unknownKeys: [], unreadable: [],
          })),
          open: [],
          governed_count: principals.length,
          error: null,
        };
      }

      let policy;
      try {
        policy = parsePolicy(text);
      } catch (error) {
        // Reported, never swallowed. A policy this cannot read is not a bucket with nothing in it,
        // and the two must not reach the screen looking alike.
        //
        // The text goes with the error. This is the one case where the document is the whole of what
        // anybody can act on - there is no reading to check it against - so withholding it would
        // leave the screen saying "something is wrong with a document you may not see".
        return {
          bucket, account_id: config.accountId, has_policy: true, policy: null,
          document_text: text,
          principals: [], open: [], governed_count: principals.length,
          error: error.message,
        };
      }

      const read = readPolicy(policy, principals, { bucketAccountId: config.accountId });
      return {
        bucket,
        account_id: config.accountId,
        has_policy: true,
        // The document itself, because the reading is a claim about it and an approver has to be
        // able to check the claim against the thing it was made about.
        //
        // Both forms, and they are not interchangeable. `policy` is the parsed structure, which is
        // what the reading was made from; `document_text` is the bytes S3 returned. Re-serialising
        // the first does not reproduce the second - key order, spacing and any duplicate key are the
        // parser's to decide - so a screen that showed only a re-serialised document would be
        // showing something nobody wrote. The document is what an approver checks the claim against,
        // so the document is what is sent.
        policy: policy.document,
        document_text: text,
        principals: read,
        open: openStatements(policy, { bucketAccountId: config.accountId }),
        governed_count: principals.length,
        error: null,
      };
    },

    // Re-judged on the way out, every time. The sweep answers what is in the buckets - the
    // expensive half, and the half that does not change on its own. Whether a marker is running or
    // failed is the other half: it moves with the clock, and it moves the SECOND a failure report
    // lands. Served straight from the sweep, this route said a container was still working while
    // the panel above it showed the exit code it stopped with, because the sweep predated the
    // report. Nothing is re-read to fix that - see reclassify() in sweep.js.
    'GET /api/state': async () => {
      const state = store.get();
      if (!state) throw new HttpError(503, 'the first sweep has not finished');
      return judged(state);
    },

    'POST /api/sweep': async () => {
      await store.refresh('requested from the page');
      return judged(store.get());
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

    // Posted by opt-SolutionTaskFailureNotifier when a container in the cluster stopped badly.
    //
    // What it adds is the REASON. The marker that outlived the task is already visible - the sweep
    // finds it - and it says only that a task did not finish: a plan lock timeout and a task killed
    // before it ran a line leave the same object. stopCode, exitCode and stoppedReason separate
    // them, they exist in the ECS task state change event, and nothing here can see that event.
    //
    // Unlike an announcement, a failure here IS the notifier's problem. The listener must not retry
    // an announcement because the marker is in S3 either way; this reason is in the event and in
    // CloudWatch Logs and nowhere a person looks, so a refusal has to reach the notifier and its
    // rule has to be able to quarantine what it cannot deliver.
    'POST /api/task-failures': async ({ body }) => {
      if (!config.ingestKey) {
        throw new HttpError(503, 'OPT_DASHBOARD_INGEST_KEY is not set; reports are off');
      }
      let report;
      try {
        report = parseReport(body);
      } catch (err) {
        if (err instanceof TaskFailureError) throw new HttpError(400, err.message);
        throw err;
      }
      const recorded = taskFailures.record(report, Date.now());
      const target = retryTarget(recorded, config);
      log.warn(
        'task failed definition=%s stop_code=%s exit=%s marker=%s retryable=%s reason=%s',
        recorded.task_definition_arn ?? '-', recorded.stop_code ?? '-',
        recorded.exit_codes.join(',') || '-', recorded.marker_key ?? '-',
        Boolean(target), recorded.stopped_reason ?? '-',
      );
      // Answered without a sweep. Nothing in the buckets changed - the marker was already there -
      // so a sweep would read the same thing it read last time and hold the notifier's socket open
      // while it did.
      return { recorded: recorded.id, retryable: Boolean(target), attempts: recorded.attempts };
    },

    /**
     * Run a failed container again, by re-putting the object that started it.
     *
     * The only way to retry a task without ecs:RunTask, and the reason that matters: RunTask carries
     * container overrides, so a login surface holding it runs anything as any role it may pass.
     * Re-putting an object starts a FIXED task definition with the overrides its own rule composes,
     * and this process holds neither RunTask nor PassRole.
     *
     * The object is READ AND WRITTEN BACK, never composed. What restarts the task is the write
     * event, not the contents, so there is no reason for this tier to author bytes that a container
     * will act on - and every reason not to: the applier checks that an approval came from here,
     * and it can only keep meaning that while this route cannot invent one.
     *
     * Three fences, and they fail differently:
     *   retryTarget    refuses a bucket or key shape this is not for, and can say why on a screen
     *   read-then-write  means a defect here cannot change what a container reads
     *   IAM            refuses the call outright - see ReRunAFailedTaskByReputtingItsMarker in
     *                  opt-stack-dashboard-host. This is the one that holds when the code is wrong
     */
    'POST /api/task-failures/retry': async ({ body }) => {
      const reviewer = String(body.reviewer ?? '').trim();
      if (!reviewer) throw new HttpError(400, 'reviewer is required');
      if (reviewer.length > MAX_REVIEWER) throw new HttpError(400, 'reviewer is too long');

      const id = String(body.id ?? '').trim();
      if (!id) throw new HttpError(400, 'id is required');
      const report = taskFailures.get(id);
      if (!report) {
        throw new HttpError(404, `${id} is not a failure this dashboard has been told about`);
      }

      const target = retryTarget(report, config);
      if (!target) {
        throw new HttpError(
          409,
          `${id} names nothing this dashboard may re-put. A task started by hand carries no `
          + 'object to re-run, and only the four prefixes that start a container are accepted.',
        );
      }

      let bytes;
      try {
        bytes = await getBytes(s3, target.bucket, target.key);
      } catch (err) {
        throw new HttpError(
          409,
          `s3://${target.bucket}/${target.key} could not be read (${err.message}). A container `
          + 'that finished deletes its own object, so this may already have been dealt with.',
        );
      }

      await putBytes(s3, target.bucket, target.key, bytes);
      const marked = taskFailures.retried(id, reviewer, Date.now());
      log.warn('task retried by=%s marker=s3://%s/%s bytes=%d attempts=%d',
               reviewer, target.bucket, target.key, bytes.length, marked?.attempts ?? 0);
      return { retried: id, bucket: target.bucket, key: target.key, bytes: bytes.length };
    },

    /** What has failed lately, newest first. Emptied by a restart - see taskFailures.js. */
    'GET /api/task-failures': async () => ({
      failures: taskFailures.list().map((entry) => ({
        ...entry,
        retryable: Boolean(retryTarget(entry, config)),
      })),
      enabled: Boolean(config.ingestKey),
    }),

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
      let digest = null;
      if (plan.request_id) {
        const pushed = impacts.get(plan.request_id);
        if (pushed && !pushed.body_omitted && pushed.impact?.request_id === plan.request_id) {
          assessment = pushed.impact;
          source = 'pushed';
          // The digest the container computed over the object it wrote, carried in the push beside
          // the body. It used to be set on the stored path only, so an assessment that arrived by
          // push - the ordinary case, since the container POSTs it - gave the page a null
          // assessment_sha256, the page sent no expected_impact_sha256, and the decision route
          // refused every restriction with a 400. This is not computed here either: the value comes
          // from the container, and the decision route compares it against the digest beside the
          // stored object before it carries anything into a marker.
          digest = pushed.impact_sha256 ?? null;
        }
      }
      if (!assessment) {
        const stored = await readImpact(s3, config, id);
        if (stored?.document
            && (!plan.request_id || stored.document.request_id === plan.request_id)) {
          assessment = stored.document;
          digest = stored.digest;
          source = 'stored';
        } else if (stored?.document && describesPlan(plan, stored.document)) {
          // An assessment from an EARLIER inspection of this resource, kept because this plan moves
          // no resource.
          //
          // The match above exists because a prefix is overwritten in place: an assessment from a
          // previous inspection describes a permission set that plan no longer produces, and showing
          // it beside a fresh plan.txt is the mismatch the digests exist to prevent. That reasoning
          // holds for every plan that CHANGES something, and not for one that changes nothing.
          //
          // The case it was not written for is the passrole tag. Tagging a <service>-* role starts
          // an inspection whose plan moves no IAM resource - only the outputs carrying the request -
          // so the new request id is a different inspection of an identical permission set. Dropping
          // the assessment there answered "what does this reach" with silence about a governed
          // resource that was assessed, applied, and has not changed since.
          //
          // Carried WITHOUT the digest, and that is the whole safety of it. A restriction is
          // validated against the assessment an approver read, and this one belongs to another
          // inspection - so the page shows it and can compose nothing from it. The reader is told
          // which inspection it came from rather than being handed it as current.
          assessment = stored.document;
          digest = null;
          source = 'earlier';
        }
      }

      // What is standing, answered by the assessment when the writer's record could not.
      //
      // readPlan says null whenever inline_result cannot be read, and a permission set the writer
      // has never run for HAS no such object. So "nothing has ever been written here" - the state
      // of every permission set the first time somebody restricts one - read as "nobody can say",
      // the editor closed, and with it every 경로 차단 button on the risk analysis cards. The first
      // restriction became the one restriction that could not be written.
      //
      // current_admin_deny is what the impact querier read off the LIVE inline policy - "what a new
      // decision would replace". Empty there is a fact, not an absence: there is no AdminDeny
      // family, so nothing is standing, so an empty form is the truth.
      //
      // Non-empty stays null, and that is the case the closed editor was built for: statements are
      // in force and nothing can say which decisions produced them, so a form seeded empty would
      // drop them all.
      //
      // Only from an assessment carrying a digest - the current one. An assessment kept from an
      // earlier inspection composes nothing (the decision route refuses a restriction without the
      // digest), so opening the editor on it would offer a form whose submission is refused.
      const inForce = plan.restrictions_in_force
        ?? (digest && nothingRestricted(assessment) ? [] : null);

      // The digest the page has to send back with a restriction. Not computed here - see readImpact.
      return {
        ...plan,
        restrictions_in_force: inForce,
        assessment,
        assessment_source: source,
        assessment_sha256: digest,
      };
    },

    /**
     * The risk analysis: the rules always, the model when it is asked for.
     *
     * POST rather than GET, and that is not a REST quibble. Running the model half costs money and
     * takes seconds to minutes, so it happens when somebody asks for it - never as a side effect of
     * opening a plan, and now not as a side effect of asking for the OTHER half either.
     *
     * The rule findings come back on every call, engine or no engine. They are deterministic, they
     * cost nothing, and a deployment that never enables Bedrock still gets the twelve rules fired
     * against the assessment - which is the half an approver can rely on without trusting a model
     * at all. `body.engine` decides only whether the paid half is started:
     *
     *   'rules'   compute and return the rule findings; do not start the model. If a model run
     *             already exists for this assessment - started by an earlier 'ai' call - it rides
     *             along on the answer anyway, because it costs nothing extra to hand back work
     *             already paid for. It is just never triggered by this value.
     *   anything else (including omitted)   today's behaviour: start or join the model run too.
     *             The default stays permissive on purpose - this field is set by our own two
     *             buttons, never by free text a person typed, so there is no untrusted input to
     *             guard against and a typo can only ever cost more, never silently less.
     *
     * The two dashboard buttons - 정책 기반 분석 and AI 분석 - are this distinction made visible.
     * Pressing 정책 기반 분석 alone must not bill Bedrock; that is the entire reason this exists
     * rather than the buttons both posting the same body and differing only in which half of the
     * same answer they choose to render.
     */
    'POST /api/plans/:id/analysis': async ({ params, body }) => {
      const id = planId(params.id);
      const plan = await readPlan(s3, config, id);
      if (!plan) throw new HttpError(404, `no plan stored for ${id}`);

      // The stored object, never the pushed body. The analysis is cited on an approval marker, and
      // a citation has to name bytes that exist in the bucket with a digest beside them.
      const stored = await readImpact(s3, config, id);
      if (!stored?.document) {
        throw new HttpError(409, `${id} has no stored impact assessment, so there is nothing to `
          + 'analyse. Wait for the assessment or reload.');
      }
      if (!describesPlan(plan, stored.document)) {
        throw new HttpError(409, `the stored assessment describes ${stored.document.request_id} and `
          + `this plan is ${plan.request_id}; reload the plan`);
      }

      const key = stored.digest ?? null;

      const digest = condense(stored.document, {
        controlPlane: controlPlane(config),
        ruleActions: RULE_ACTIONS,
        rulesSha256: RULES_SHA256,
        impactSha256: key,
        excludeGoverned: config.excludeGoverned,
      });
      // What the assessment already knows about each action - its access level, the types it names,
      // whether it creates them, and the allow_only verdict whose `deref:` form identifies a
      // rebinding. Passed to both halves rather than folded into the digest: every consumer is on
      // this side of the wire, so threading it costs no digest bytes, and the digest is what an
      // approval is bound to.
      const reference = referenceIndex(stored.document);

      /**
       * Which attached policy this ask is about, or null for all of them.
       *
       * Every finding and every candidate belongs to exactly one grant - nothing in either half is
       * computed across policies - so scoping is a filter rather than a different analysis, and it
       * loses nothing. What it saves is the model half: five attached policies is five policies'
       * worth of candidates, and an approver who only wants to know about AmazonEC2FullAccess
       * should not pay for the other four.
       *
       * Refused rather than ignored when it names nothing. A typo that silently analysed the whole
       * plan would bill for five and report as one.
       */
      const roster = (digest.grants ?? []).map((g) => ({
        id: g.p,
        identifier: g.name,
        is_baseline: g.is_baseline === true,
        restrictable: g.restrictable !== false,
      }));
      const scope = typeof body?.policy === 'string' && body.policy.trim() ? body.policy : null;
      if (scope && !roster.some((p) => p.identifier === scope)) {
        throw new HttpError(400, `${scope} is not an attached policy of this plan. Attached: `
          + roster.map((p) => p.identifier).join(', '));
      }
      const mine = (list, field) => (scope ? list.filter((x) => x[field] === scope) : list);

      // The run this ask belongs to. Two policies analysed separately are two runs, and neither is
      // the whole-plan one - without the scope in the id, the second ask would join the first and
      // be handed an answer about a different policy.
      const runId = scope ? `${id}::${scope}` : id;

      // Already answered, about this same assessment AND this same scope. Returned rather than
      // asked again: the model half costs money and minutes, and a second press of the button - or
      // a browser reload - is not a request for a second opinion.
      const finished = runs.get(runId, key);
      if (finished && finished.state === DONE) return withRun(finished.answer, finished);

      const rules = mine(ruleFindings(digest, undefined, reference), 'policyName');
      // The candidates, each told which rules already cover it. Both halves run over the same
      // digest and reach the same places by different routes; without this the approver reads
      // twelve paths twice, in two cases at two different grades.
      const candidates = mine(withOverlap(proposeCandidates(digest, reference), rules), 'policy');

      const answer = {
        plan_id: id,
        // What was asked about, echoed so a cached or polled answer cannot be read as another
        // scope's, and the roster so the page can draw one area per policy without a second call.
        policy: scope,
        policies: roster,
        request_id: stored.document.request_id,
        impact_sha256: key,
        rules_sha256: RULES_SHA256,
        prompt_version: PROMPT_VERSION,
        digest_bytes: digestBytes(digest),
        dropped: digest.budget?.dropped ?? [],
        // Types the inventory reported and the reference could not resolve. Surfaced beside the
        // findings because it bounds them: resources of these types are in no unit, so no rule and
        // no candidate could have fired on one.
        types_unknown: digest.coverage?.types_unknown ?? {},
        // Mutating actions nothing could classify. Beside the findings for the same reason
        // types_unknown is: it bounds them. An action here reaches no edge, so no candidate names
        // it and no rule capability term matches it - the graph could not see it at all.
        actions_unclassified: digest.coverage?.actions_unclassified ?? 0,
        actions_unclassified_sample: digest.coverage?.actions_unclassified_sample ?? [],
        rule_findings: rules,
        rule_sections: sections(rules),
        rule_summary: summary(rules),
        candidates: candidates.length,
        candidates_covered_by_rules: overlapCount(candidates),
        analysis: null,
        analysis_error: null,
        run: null,
      };

      if (!config.riskAnalysis) {
        // Not an error. The rules ran, and the page says which half it is showing rather than
        // implying the model agreed with them.
        answer.analysis_error = 'OPT_RISK_ANALYSIS is not on, so no model was asked';
        return answer;
      }

      if (body?.engine === 'rules') {
        // 정책 기반 분석 asked, not AI 분석. The rules above already answer it; what must NOT
        // happen is starting the paid half as a side effect of a request for the free one.
        //
        // A model run can still exist - the AI button may have been pressed first, on this same
        // assessment - and if so it rides along here. That is not this call starting anything: it
        // is handing back work that was already bought, the same as the DONE short-circuit above
        // does for a repeated ask. Nothing here calls runs.start.
        const inFlight = runs.get(runId, key);
        return inFlight ? withRun(answer, inFlight) : answer;
      }

      // Everything above is deterministic and takes milliseconds. Everything below is one model
      // call per batch, in sequence, and on a real assessment that is minutes - which is what put
      // a 504 in front of this route when it was all one request. So the model half is started and
      // not awaited: this returns the rule findings now, and the page polls GET for the rest.
      const entry = runs.start(runId, key, async (report) => {
        const done = { ...answer };
        try {
          const client = await modelClient();
          done.analysis = await analyse({
            digest, client, candidates,
            model: config.bedrockModelId,
            maxTokens: config.riskAnalysisMaxTokens,
            batchSize: config.riskAnalysisBatch,
            concurrency: config.riskAnalysisConcurrency,
            deadlineMs: config.riskAnalysisDeadlineMs,
            onProgress: ({ batch, of, elapsedMs }) => report({ batches: of, done: batch, elapsedMs }),
          });
          const a = done.analysis;
          log.info(
            'analysis plan=%s candidates=%d covered=%d answered=%d findings=%d rejected=%d '
            + 'dropped=%d failed=%d digest=%dB in=%d out=%d cached=%d took=%dms slowest=%dms '
            + 'batches=%d at=%d',
            runId, a.candidates, done.candidates_covered_by_rules, a.answered ?? 0, a.findings.length,
            a.rejected.length, a.dropped.length, a.failures.length, done.digest_bytes,
            a.usage.input, a.usage.output, a.usage.cacheRead,
            a.timing?.totalMs ?? 0, Math.max(0, ...(a.timing?.batchMs ?? [0])),
            (a.timing?.batchMs ?? []).length, a.timing?.concurrency ?? 1,
          );
        } catch (error) {
          // The rules still stand. An analysis outage is not an approval outage - the same rule the
          // assessment itself follows.
          done.analysis_error = error instanceof AnalysisError || error instanceof HttpError
            ? error.message
            : `the model call failed: ${error.message ?? String(error)}`;
          log.warn('analysis plan=%s failed: %s', runId, done.analysis_error);
        }
        return done;
      });

      answer.run = runState(entry);
      return answer;
    },

    /**
     * How the run started above is going, and its answer once there is one.
     *
     * GET because it changes nothing and a browser may repeat it as often as it likes - which is
     * the point. Every request on this route is milliseconds, so no proxy timeout is in play; the
     * one that used to matter belonged to the POST, which held a connection open for the whole
     * model call and got a 504 for it.
     */
    'GET /api/plans/:id/analysis': async ({ params, query }) => {
      const id = planId(params.id);
      // Which scope is being polled. A GET has no body, so it comes from the query - and it has to
      // come from somewhere: two policies analysed separately are two runs under one plan, and a
      // poll without it would return whichever happened to be there.
      const scope = query?.get('policy')?.trim() || null;
      const runId = scope ? `${id}::${scope}` : id;
      // No key given, so the run is returned with the assessment it is about stated on it. The
      // page holds that digest already and refuses a citation that does not match it, so a run
      // left over from a replaced assessment cannot be read as this plan's answer.
      const entry = runs.get(runId, null);
      if (!entry) {
        throw new HttpError(404, `no analysis has been started for ${runId} in this process. Press `
          + 'the button again - a restart loses what was running, and nothing is stored.');
      }
      if (entry.state === DONE) return withRun(entry.answer, entry);
      // A failure here is the RUN failing, not the model - a model outage comes back as a finished
      // answer carrying analysis_error, because the rules in it still stand.
      return { plan_id: id, policy: scope, run: runState(entry) };
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
      // Declared HERE and not below, where it used to be. The restriction block reads it to check
      // that the stored assessment belongs to this inspection, and a const declared further down the
      // same function body is in its temporal dead zone at that point - so every approval carrying a
      // restriction threw ReferenceError and became a 500. It read as an approval path that simply
      // did not work, with nothing in the message saying why. api.test.js now covers it.
      //
      // The marker is named by the inspection that produced this plan, not by the resource: the name
      // has to fit ECS startedBy, which is 36 characters of [A-Za-z0-9/_-] and would not hold a
      // resource name. Checked rather than trusted - it arrives from an object in a bucket.
      const requestId = String(plan.request_id ?? '');
      if (!REQUEST_ID.test(requestId)) {
        throw new HttpError(
          409,
          `${id} has no usable request id in request.json (${requestId.slice(0, 64) || 'absent'}), `
          + 'so the approval marker cannot be named. Change the resource again to get a fresh plan.',
        );
      }

      // THREE-VALUED, all the way down to the writer's compose(). Absent or null says nothing about
      // restrictions and the family in force is carried forward; [] says there are none and clears
      // it; a list says exactly those. The page sends the key when its editor was live - which is
      // when it could show what already stands - and omits it otherwise.
      //
      // [] used to be indistinguishable from absent here and everywhere below, so an approver could
      // add a restriction and change one but never remove the last: the form emptied, the run
      // reported success, and every restriction was still in force.
      const restrictions = body.restrictions === undefined || body.restrictions === null
        ? null
        : body.restrictions;
      if (restrictions !== null
          && (!Array.isArray(restrictions)
              || restrictions.some((r) => !r || typeof r !== 'object' || Array.isArray(r)))) {
        throw new HttpError(400, 'restrictions must be an array of objects, absent, or null');
      }
      let impactDigest = '';
      if (restrictions !== null) {
        if (body.decision !== 'approve') {
          throw new HttpError(
            400,
            'a denial decides nothing about restrictions: the plan is not applied, so nothing runs '
            + 'to write them. An empty list is a decision too - it clears the family - and a denial '
            + 'cannot carry that either.',
          );
        }
        // ACTIONS, not entries. The bound says "restricted actions" and one entry carries a list of
        // them, so counting entries let 200 x N through - and N is a whole policy's action list
        // when the picker's 전체 선택 made it. The only thing left bounding the request was the
        // writer's byte check, which runs AFTER the approval: too late to say which list to shorten.
        //
        // A malformed entry counts as one here and is refused by the shape check further down, so
        // this bound cannot be evaded by sending something that is not a list.
        const restrictedActions = restrictions.reduce(
          (total, r) => total + (Array.isArray(r?.actions) ? r.actions.length : 1), 0,
        );
        if (restrictedActions > MAX_RESTRICTIONS) {
          throw new HttpError(
            400,
            `at most ${MAX_RESTRICTIONS} restricted actions per decision, and this carries `
            + `${restrictedActions} across ${restrictions.length} entries. The permission set inline `
            + 'policy quota of 10,240 bytes is reached well before this, so a restriction this wide '
            + 'wants a tag condition instead - one statement whatever it covers.',
          );
        }

        // Required for an EMPTY answer too, and for the other half of the same reason. A named
        // restriction is validated against this assessment; a clear is written against the
        // inline_sha256 that travels inside it - the digest of the restriction family the approver
        // was shown - and the writer refuses to replace a family that has moved since. Without the
        // assessment the applier reads neither, and a clear would delete something nobody
        // established anybody had looked at.
        const stored = await readImpact(s3, config, id);
        if (!stored?.document) {
          throw new HttpError(
            409,
            `${id} has no impact assessment stored, so there is nothing to write a restriction `
            + 'decision against. Approve without deciding restrictions, or wait for the assessment.',
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
          throw new HttpError(400, 'expected_impact_sha256 is required with a restriction decision: '
                                   + 'it names the assessment that decision was made from, and a '
                                   + 'clear needs it as much as a restriction does - it is what '
                                   + 'carries the digest of the family being removed');
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

        // Actions that name no resource type at all, from the reference the assessment carries. A
        // NotResource list can never hold one, and a Resource list of ARNs never matches one - so
        // allow_only is impossible and deny_only with named resources produces a statement that reads
        // as a control and denies nothing. The inline writer refuses both; this says so first, with the
        // name, rather than letting an approval sit in a bucket and be refused later.
        const accountLevel = new Set();
        // The other way a list of ARNs is not a scope: the action MAKES every resource it names, so
        // the enumeration - a list of what exists - says "you may create one called this" about
        // things already there. Same remedy, same reason to say it here rather than in a bucket.
        const makesTarget = new Set();
        for (const [service, block] of Object.entries(
          stored.document.action_reference?.services ?? {},
        )) {
          for (const [name, entry] of Object.entries(block)) {
            if (Array.isArray(entry?.[1]) && entry[1].length === 0) {
              accountLevel.add(`${service}:${name}`);
            } else if (entry?.[2] === true) {
              makesTarget.add(`${service}:${name}`);
            }
          }
        }
        // The condition-key vocabulary the assessment carries, action -> the keys it declares.
        // Absent as a whole on assessments written before the reference carried it - then the
        // declared-key gate below passes through and the writer refuses authoritatively, the same
        // arrangement created_formats has. Absent per action means the action declares none.
        const referenceConditionKeys = stored.document.action_reference?.condition_keys;
        const declaredKeys = new Map();
        for (const [service, block] of Object.entries(referenceConditionKeys ?? {})) {
          for (const [name, keys] of Object.entries(block)) {
            declaredKeys.set(`${service}:${name}`, new Set(keys ?? []));
          }
        }
        // The allow_only verdicts, same carriage and same absent-means-older-assessment rule. Per
        // action: why the intent cannot hold (the call is authorised against resources the caller
        // never names), or which participating types a decision must keep at least one resource
        // of each. The writer refuses the first from its own table; the second it CANNOT check -
        // it receives a flat resource set with no types - so this route is where under-picking is
        // caught, from the assessment's own typed enumeration.
        // The actions AWS evaluates no aws:ResourceTag for, carried by the assessment. Absent as a
        // whole means an older assessment could not say - the gate then passes through and the
        // writer judges, the same arrangement condition_keys and created_formats have.
        const referenceNoResourceTag = stored.document.action_reference?.no_resource_tag;
        const untaggableActions = new Set(referenceNoResourceTag ?? []);
        const referenceAllowOnly = stored.document.action_reference?.allow_only;
        const allowOnlyVerdicts = new Map();
        for (const [service, block] of Object.entries(referenceAllowOnly ?? {})) {
          for (const [name, verdict] of Object.entries(block)) {
            allowOnlyVerdicts.set(`${service}:${name}`, verdict);
          }
        }
        const typeOfArn = new Map();
        for (const assessed of stored.document.policies ?? []) {
          for (const group of assessed.affected ?? []) {
            const type = String(group.resource_type ?? '').split(':')[1] ?? '';
            for (const resource of group.resources ?? []) {
              if (type && resource?.arn) typeOfArn.set(resource.arn, type);
            }
          }
        }
        for (const restriction of restrictions) {
          if (!RESTRICTION_INTENTS.has(restriction.intent)) {
            throw new HttpError(400, `restriction intent must be one of `
                                     + `${[...RESTRICTION_INTENTS].join(', ')}`);
          }
          const actions = Array.isArray(restriction.actions) ? restriction.actions : [];
          if (actions.length === 0 || actions.some((a) => typeof a !== 'string' || !a.trim())) {
            throw new HttpError(400, 'a restriction needs at least one action, as strings');
          }
          // The one intent that takes no resource clause of any kind, so anything carried alongside
          // it would be recorded in the marker and never reach the statement. Refused here for the
          // reason the whole block exists: the writer refuses it too, hours later and in a log
          // nobody is reading.
          if (restriction.intent === 'deny_action') {
            if (Array.isArray(restriction.resources) && restriction.resources.length > 0) {
              throw new HttpError(
                400,
                '"동작 자체 거부" denies the action outright - Resource "*" - so the resources named '
                + 'here would be recorded as part of the decision and change nothing about the '
                + 'statement. If the resources are the point, the section is "이 자원만 허용" or '
                + '"이 자원만 거부".',
              );
            }
            if (restriction.tag_key || (Array.isArray(restriction.tag_values)
                                        && restriction.tag_values.length > 0)) {
              throw new HttpError(
                400,
                '"동작 자체 거부" is unconditional by construction; a tag here would be recorded and '
                + 'never evaluated.',
              );
            }
          }
          // The mirror of the writer's cross-intent gate: only key_condition composes a request-key
          // condition, so the KEY and the VALUES on any other intent would sit in the marker as
          // part of the decision and never reach the statement - recorded-and-inert. The OPERATOR
          // is shared with tag_condition, whose key is aws:ResourceTag/<tag_key>.
          if (restriction.intent !== 'key_condition'
              && (restriction.condition_key
                  || (Array.isArray(restriction.condition_values)
                      && restriction.condition_values.length > 0))) {
            throw new HttpError(
              400,
              `a ${restriction.intent} restriction carries condition fields. Only "조건으로 거부" `
              + 'composes a request-key condition; anywhere else they would be recorded and never '
              + 'evaluated.',
            );
          }
          if (restriction.condition_operator != null) {
            if (!CONDITION_INTENTS.has(restriction.intent)) {
              throw new HttpError(
                400,
                `a ${restriction.intent} restriction carries a condition operator. Its statement `
                + 'has no condition for the operator to apply to, so it would be recorded and '
                + 'never evaluated.',
              );
            }
            if (!CONDITION_OPERATORS.has(restriction.condition_operator)) {
              throw new HttpError(
                400,
                `condition_operator must be one of ${[...CONDITION_OPERATORS].join(', ')}. `
                + 'StringNotEquals is the closed form - a missing key, or a resource carrying no '
                + 'such tag, is denied; StringEquals is the open form and lets both past.',
              );
            }
          }
          if (restriction.intent === 'key_condition') {
            const values = Array.isArray(restriction.condition_values)
              ? restriction.condition_values : [];
            if (!restriction.condition_key || values.length === 0
                || values.some((v) => typeof v !== 'string' || !v.trim())) {
              throw new HttpError(
                400,
                '"조건으로 거부" needs both a condition key and at least one value, as strings.',
              );
            }
            // The operator whitelist is checked above, for both condition intents. Absent is not
            // an error either way - the writer fills the per-intent default at parse.
            if (Array.isArray(restriction.resources) && restriction.resources.length > 0) {
              throw new HttpError(
                400,
                '"조건으로 거부" gates the action on a request key - Resource "*" - so the resources '
                + 'named here would be recorded and change nothing about the statement. If the '
                + 'resources are the point, the section is "이 자원만 허용" or "이 자원만 거부".',
              );
            }
            if (restriction.tag_key || (Array.isArray(restriction.tag_values)
                                        && restriction.tag_values.length > 0)) {
              throw new HttpError(
                400,
                '"조건으로 거부" reads a request condition key; a resource tag is the section '
                + '"태그로 거부", which owns its own gates.',
              );
            }
            // The coherence gate, early: on an action that does not declare the key, the condition
            // never evaluates - under StringEquals the statement denies nothing, under
            // StringNotEquals it denies every call - and either way it reads as the control that
            // was chosen. Exact names only: a wildcard action is left to the writer, which expands
            // it per covered member; an assessment without the vocabulary likewise.
            if (referenceConditionKeys) {
              for (const action of actions) {
                if (action.includes('*')) continue;
                if (!declaredKeys.get(action.trim())?.has(restriction.condition_key)) {
                  const known = [...(declaredKeys.get(action.trim()) ?? [])];
                  throw new HttpError(
                    400,
                    `${action} does not declare ${restriction.condition_key}, so the key would be `
                    + 'absent from its request context and the condition would never evaluate. '
                    + (known.length
                      ? `It declares: ${known.slice(0, 4).join(', ')}.`
                      : 'It declares no service condition key at all.'),
                  );
                }
              }
            }
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
            if (accountLevel.has(action.trim())) {
              if (restriction.intent === 'allow_only') {
                throw new HttpError(
                  400,
                  `${action} names no resource, so a NotResource list can never contain it and the `
                  + 'statement would deny the action outright rather than narrow it. If that is the '
                  + 'intent, choose "이 자원만 거부" and no resources.',
                );
              }
              if (restriction.intent === 'deny_only'
                  && Array.isArray(restriction.resources) && restriction.resources.length > 0) {
                throw new HttpError(
                  400,
                  `${action} names no resource, so a Deny listing specific resources would never `
                  + 'match it - the statement would be recorded and would deny nothing. Deny it with '
                  + 'no resources, which denies it outright.',
                );
              }
            }
          }
          // The coherence gate tag_condition was missing while key_condition had one. AWS evaluates
          // aws:ResourceTag only for the resource types that declare it; on the rest the key is
          // absent from the request context and the condition never fires - under StringEquals the
          // statement denies nothing, under StringNotEquals it denies every call, and both read on
          // screen as the control that was chosen. Exact names only: a wildcard is judged on the
          // whole statement by the writer, and an assessment written before the reference carried
          // the list passes through for the writer to judge.
          if (restriction.intent === 'tag_condition' && referenceNoResourceTag) {
            for (const action of actions) {
              if (action.includes('*')) continue;
              if (!untaggableActions.has(action.trim())) continue;
              throw new HttpError(
                400,
                `${action}이 지목하는 자원 유형에는 AWS가 aws:ResourceTag를 평가하지 않는다. 조건이 `
                + '요청 문맥에 없어 문장이 기록만 되고 아무 때도 발화하지 않는다 — "동작 자체 거부"를 '
                + '쓰거나, 그 동작이 선언한 요청 조건 키로 "조건으로 거부"를 쓴다.',
              );
            }
          }
          const named = Array.isArray(restriction.resources) ? restriction.resources : [];
          for (const action of actions) {
            if (!makesTarget.has(action.trim())) continue;
            if (named.length > 0) {
              throw new HttpError(
                400,
                `${action} brings the resource it names into being. The list enumerates what `
                + 'EXISTS, so naming resources here says "you may create one called this" about '
                + 'things that are already there. Deny it with no resources, which denies creating '
                + 'any.',
              );
            }
            if (restriction.intent === 'tag_condition') {
              throw new HttpError(
                400,
                `${action} brings the resource it names into being, and a tag condition on it can `
                + 'never match: aws:ResourceTag reads the tags of a resource that exists, and this '
                + 'one does not until the call succeeds.',
              );
            }
          }
          // The allow_only verdict, early. Wildcards are left to the writer, which judges the
          // whole statement (a wildcard makes no per-member promise); an assessment without the
          // map likewise. The cover check is THIS route's own half of the gate - the writer
          // receives a flat resource set and cannot see types, so an under-picked decision that
          // slipped past here would compose a statement that over-denies. Closed, never widened.
          if (restriction.intent === 'allow_only' && referenceAllowOnly) {
            for (const action of actions) {
              if (action.includes('*')) continue;
              const verdict = allowOnlyVerdicts.get(action.trim());
              if (verdict?.refuse) {
                const why = verdict.refuse.startsWith('deref:')
                  ? `요청이 ${verdict.refuse.slice(6)}를 실행 시점에 자원으로 풀어내므로, 호출자가 `
                    + '지목하지 않는 자원까지 인가된다'
                  : verdict.refuse.startsWith('unnamed:')
                    ? `요청이 지목하지 않는 자원 유형(${verdict.refuse.slice(8)})까지 인가된다`
                    : 'AWS API 모델과 대조할 수 없어 요청이 무엇을 지목하는지 확인할 수 없다';
                throw new HttpError(
                  400,
                  `${action}에는 "이 자원만 허용"이 성립하지 않는다 — ${why}. 목록 밖 자원이 `
                  + '인가에 끼는 순간 문장이 모든 호출을 거부하면서 범위처럼 읽힌다. "이 자원만 '
                  + '거부"나 "동작 자체 거부"를 쓴다.',
                );
              }
              const missing = (verdict?.cover ?? []).filter(
                (type) => !named.some((arn) => typeOfArn.get(arn) === type),
              );
              if (missing.length > 0) {
                throw new HttpError(
                  400,
                  `${action}은 ${(verdict.cover ?? []).join(', ')} 유형 모두에 대해 인가된다. `
                  + `고르지 않은 유형(${missing.join(', ')})의 자원이 목록 밖에 남아 모든 호출이 `
                  + '거부된다 — 각 유형에서 하나 이상 고른다.',
                );
              }
            }
          }
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
      } else if (body.decision === 'approve') {
        // No restriction - but the digest still travels when it can, because the applier needs it
        // for more than restrictions now: the PassRole fence is composed from the assessment's
        // passrole_grants, and only a digest-named assessment may be its source. The asymmetry
        // with the branch above is deliberate: a restriction REQUIRES the digest and a mismatch
        // is a 409, while the fence merely rides it - approval was never blocked on the
        // assessment ("an assessment outage is not a pipeline outage"), so a missing, stale or
        // mismatched assessment omits the digest and the approval proceeds. The applier then
        // records not_required, and the next assessed approval of the resource fences it.
        const claimed = String(body.expected_impact_sha256 ?? '').trim();
        if (claimed) {
          const stored = await readImpact(s3, config, id);
          if (stored?.digest && stored.digest === claimed
              && (!requestId || stored.document?.request_id === requestId)) {
            impactDigest = stored.digest;
          }
        }
      }

      // The PassRole confirmations, checked against the requests the plan actually records.
      //
      // A separate act from approving the plan, and the page sends nothing here unless somebody
      // ticked a box: applying a mirror role decides what the role is, and this decides who may
      // hand it to a service. One of those is an escalation and the other is not.
      //
      // Checked here so the approver gets a readable refusal, and checked AGAIN by the applier
      // against the same output, because this tier is the one that is not trusted. A name is the
      // only part of a grant that comes from here - the role and the services are read from the
      // plan - so it is the only part that needs bounding.
      const grantTo = body.passrole_grant_to ?? [];
      if (!Array.isArray(grantTo)
          || grantTo.some((u) => typeof u !== 'string' || !u.trim())) {
        throw new HttpError(400, 'passrole_grant_to must be an array of Identity Center user names');
      }
      const confirmed = [...new Set(grantTo.map((u) => u.trim()))].sort();
      if (confirmed.length > 0) {
        if (body.decision !== 'approve') {
          throw new HttpError(400, 'a denial cannot confirm a PassRole grant: nothing is granted');
        }
        const requested = new Set(plan.passrole?.requested_by ?? []);
        const unasked = confirmed.filter((u) => !requested.has(u));
        if (unasked.length > 0) {
          throw new HttpError(
            409,
            `${unasked.join(', ')} did not ask for PassRole on this role. A request is a tag on the `
            + `source role - <user name> = passrole - and this plan records requests from `
            + `${[...requested].sort().join(', ') || 'nobody'}. A grant is confirmed, never `
            + 'originated.',
          );
        }
        if ((plan.passrole?.services ?? []).length === 0) {
          throw new HttpError(
            409,
            'this role\'s trust policy admits no service, so a PassRole grant on it would have no '
            + 'iam:PassedToService condition and would allow passing it to anything. The applier '
            + 'refuses such a grant, so the confirmation is refused here instead of failing after '
            + 'the apply.',
          );
        }
      }

      // Withdrawing one. The only way a grant goes away: the writer keeps every grant a dispatch is
      // silent about, so leaving somebody off a later confirmation does NOT remove them - and it
      // must not, because an approver who confirms bob has said nothing about alice.
      //
      // Deliberately NOT checked against the plan's requesters. The ordinary reason to withdraw is
      // that the tag was removed, so the person is no longer among them; requiring it would make the
      // only removal path unusable in the case it exists for. Withdrawing is the safe direction.
      const revokeFrom = body.passrole_revoke_from ?? [];
      if (!Array.isArray(revokeFrom)
          || revokeFrom.some((u) => typeof u !== 'string' || !u.trim())) {
        throw new HttpError(400,
          'passrole_revoke_from must be an array of Identity Center user names');
      }
      const withdrawn = [...new Set(revokeFrom.map((u) => u.trim()))].sort();
      if (withdrawn.length > 0 && body.decision !== 'approve') {
        // The withdrawal rides on the apply that follows an approval - a denied plan applies
        // nothing, so there is no run to carry it.
        throw new HttpError(400,
          'a denial cannot withdraw a PassRole grant: the plan is not applied, so nothing runs to '
          + 'write the change. Approve the plan and withdraw in the same decision.');
      }
      const contradictory = withdrawn.filter((u) => confirmed.includes(u));
      if (contradictory.length > 0) {
        throw new HttpError(400,
          `${contradictory.join(', ')} is both confirmed and withdrawn in one decision. One `
          + 'decision says one thing about one person.');
      }

      const marker = decisionMarker({
        config, plan, prefix: planPrefixFromId(id),
        payload: { ...body, reviewer, comment }, now: Date.now(),
        restrictions, impactDigest, passroleGrantTo: confirmed, passroleRevokeFrom: withdrawn,
        analysis: body.risk_analysis ? analysisCitation(body.risk_analysis, impactDigest) : null,
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
      //
      // Not allowed to fail the decision. The marker is already in S3 and the applier is already
      // starting, so the decision HAPPENED - and a rethrown sweep error made this route answer 500,
      // which reads as "the approval did not go through". The reviewer presses again, the second
      // press hits an already-decided plan and comes back 409, and now two contradictory errors
      // describe an approval that actually succeeded. The store keeps its previous state and logs
      // the failure; the next sweep runs anyway.
      await store.refresh(`decision on ${id}`).catch((err) => {
        log.warn('decision recorded and the sweep after it failed plan=%s request=%s error=%s '
          + '- the marker is written and the applier has it', id, requestId, err?.message ?? err);
      });
      return { written: `s3://${config.markerBucket}/${key}`, marker };
    },

    /**
     * Send the work orders again, for the people the inline writer did not reach.
     *
     * Not a decision. Everything a grant says - which role, conditioned on which services, for whom
     * - was decided when the plan was approved, and this changes none of it: the applier reads the
     * outputs the apply recorded and writes the same work order again. What this route authors is
     * a list of names, and every one of them has to be a name the writer already failed on.
     *
     * That is the whole gate, and it is narrow on purpose. A retry overwrites the inline writer's
     * LOCK, which is the one thing in the system that says "an execution of this permission set is
     * outstanding". So the applier reads the writer's own record before taking one, and this route
     * refuses to name anybody that record does not mark retryable - two checks over the same fact,
     * because this tier is the one that is not trusted and the marker it writes starts a container.
     */
    'POST /api/plans/:id/passrole-retry': async ({ params, body }) => {
      const id = planId(params.id);
      const reviewer = String(body.reviewer ?? '').trim();
      if (!reviewer) throw new HttpError(400, 'reviewer is required');
      if (reviewer.length > MAX_REVIEWER) throw new HttpError(400, 'reviewer is too long');
      const comment = String(body.comment ?? '').trim();
      if (comment.length > MAX_COMMENT) throw new HttpError(400, 'comment is too long');

      const users = body.users ?? [];
      if (!Array.isArray(users) || users.some((u) => typeof u !== 'string' || !u.trim())) {
        throw new HttpError(400, 'users must be an array of Identity Center user names');
      }
      const named = [...new Set(users.map((u) => u.trim()))].sort();
      if (named.length === 0) {
        throw new HttpError(400, 'a retry names the people whose work order is to be sent again');
      }

      // Read the bucket rather than trusting what the page was showing. A writer that finished
      // between the page rendering and this request must not be dispatched again - the lock would
      // be taken over on a run that succeeded, and the applier refuses that anyway, so refusing
      // here is where the reason can be read.
      const plan = await readPlan(s3, config, id);
      if (!plan) throw new HttpError(404, `no plan stored for ${id}`);
      if (!plan.outcome) {
        throw new HttpError(
          409,
          `${id} has no recorded outcome, so no work orders were dispatched for it. A retry sends `
          + 'the work orders of a decision that was applied.',
        );
      }
      if (!plan.outcome.applied) {
        throw new HttpError(409, `${id} was closed without applying, so there is nothing to send`);
      }

      const writers = new Map((plan.passrole_writers ?? []).map((w) => [w.user_name, w]));
      const unknown = named.filter((u) => !writers.has(u));
      if (unknown.length > 0) {
        throw new HttpError(
          409,
          `${unknown.join(', ')} — 이 결정이 발송한 대상이 아니다. 재시도는 이미 나간 작업 지시를 `
          + '다시 보내는 것이고, 새로 부여하려면 자원을 다시 바꿔 계획을 받아 승인한다.',
        );
      }
      const settled = named.filter((u) => !writers.get(u).retryable);
      if (settled.length > 0) {
        // Three shapes land here and the message names which. A finished writer must not be
        // re-dispatched; a running one must not have its lock taken; one that left no record at all
        // is the case nothing can tell apart from a running one, which is why it is refused too.
        const why = settled.map((u) => {
          const writer = writers.get(u);
          if (writer.ok) return `${u}: 이미 부여가 적용되어 있다`;
          if (writer.state === null && writer.locked) {
            return `${u}: 작성기가 아직 결과를 남기지 않았다. 돌고 있는지 죽었는지 구분할 수 없어 `
              + '잠금을 뺏지 않는다';
          }
          return `${u}: 작성기의 기록이 ${writer.state ?? '없음'}이라 재시도 대상이 아니다`;
        });
        throw new HttpError(409, why.join(' / '));
      }

      // Split by what the original work order was. A retry repeats the act, and repeating a
      // withdrawal as a grant would put back the very thing somebody removed.
      const granted = named.filter((u) => writers.get(u).action === 'grant');
      const revoked = named.filter((u) => writers.get(u).action === 'revoke');

      // From the plan id in the URL, which PLAN_ID already checked, and NOT from the plan's
      // main.tf.json. The prefix that was just read was built from this same value, so the account
      // in the marker is by construction the account whose record this retry is about - and the
      // applier refuses a marker whose prefix and account disagree.
      const [accountId, resource] = id.split(':');
      const requestId = retryRequestId(accountId);
      const marker = {
        request_id: requestId,
        plan_id: plan.plan_id,
        account_id: accountId,
        resource,
        decision: 'approve',

        // What makes this a re-dispatch rather than a decision. The applier applies nothing on this
        // path and refuses a marker that carries a restriction, names nobody, or denies.
        passrole_retry: true,
        // Which recorded outcome is being re-dispatched. The applier compares it against the
        // outcome standing in the prefix and does nothing if a later decision has replaced it.
        retry_of: plan.request_id,

        reviewer,
        comment,
        decided_at: new Date().toISOString(),

        // Carried because the applier's parse requires them, and true of the plan this retry is
        // about. Nothing on the retry path reads them: no plan file is downloaded and no apply is
        // run, so they are the record of which plan this was, not a binding to a file.
        changes_sha256: plan.changes_sha256,
        plan: {
          bucket: config.stateBucket,
          prefix: planPrefixFromId(id),
          tfplan_sha256: plan.plan_file_sha256,
        },

        ...(granted.length > 0 ? { passrole_grant_to: granted } : {}),
        ...(revoked.length > 0 ? { passrole_revoke_from: revoked } : {}),

        issued_by: { component: 'opt-SolutionDashboard', release: config.release },
        schema: 1,
      };

      const key = `${config.applierPrefix}${requestId}.json`;
      const bytes = await putJson(s3, config.markerBucket, key, marker);
      markerBodies.put('applier', requestId, marker, 'written-here');

      log.info('passrole retry plan=%s request=%s retry_of=%s reviewer=%s granted=%s revoked=%s '
        + 'key=s3://%s/%s bytes=%d',
        id, requestId, plan.request_id, reviewer, granted.join(',') || '-',
        revoked.join(',') || '-', config.markerBucket, key, bytes);

      // Same reasoning as the decision route: the marker is written and the applier is starting, so
      // a failing sweep must not answer 500 and make a retry that happened read as one that did not.
      await store.refresh(`passrole retry on ${id}`).catch((err) => {
        log.warn('retry written and the sweep after it failed plan=%s request=%s error=%s',
          id, requestId, err?.message ?? err);
      });
      return { written: `s3://${config.markerBucket}/${key}`, marker };
    },

    /**
     * Take a PassRole grant back, with no decision on a plan behind it.
     *
     * The gap this fills: granting rides on approving a plan, and once that plan is applied there is
     * no second decision to make. The decision route refuses one on a plan that has an outcome, and
     * a plan whose twin already matches carries no changes to approve - so `passrole_revoke_from`,
     * the only field that removes a grant, could not be sent at all. A grant held by somebody whose
     * tag was removed in an earlier inspection stood until the permission set was edited by hand.
     *
     * A path with no plan behind it is defensible here and only here, because withdrawal is the safe
     * direction: it removes access and can add none. The applier refuses a grant on this marker for
     * the same reason - a grant needs a tag somebody wrote and a plan somebody read.
     *
     * The names are still bounded. They must be people the plan records as HOLDING the grant:
     *
     *   무엇인가   지금 이 미러 역할의 PassRole 을 가진 사람. 검사기가 미러 역할의 태그에서 읽는다
     *   어디 있나  상태 버킷 <계정>/<자원>/plan/plan.json 의 출력 passrole_granted_to
     *   누가 쓰나  검사기 하나
     *   누가 읽나  여기, 그리고 계획 화면의 「지금 상태」열
     *
     * That list is a container's reading of the role's own tags, not something this tier authored -
     * the same rule the grant path follows against passrole_requested_by.
     */
    'POST /api/plans/:id/passrole-revoke': async ({ params, body }) => {
      const id = planId(params.id);
      const reviewer = String(body.reviewer ?? '').trim();
      if (!reviewer) throw new HttpError(400, 'reviewer is required');
      if (reviewer.length > MAX_REVIEWER) throw new HttpError(400, 'reviewer is too long');
      const comment = String(body.comment ?? '').trim();
      if (comment.length > MAX_COMMENT) throw new HttpError(400, 'comment is too long');

      const users = body.users ?? [];
      if (!Array.isArray(users) || users.some((u) => typeof u !== 'string' || !u.trim())) {
        throw new HttpError(400, 'users must be an array of Identity Center user names');
      }
      const named = [...new Set(users.map((u) => u.trim()))].sort();
      if (named.length === 0) {
        throw new HttpError(400, 'a withdrawal names the people whose grant is to be removed');
      }

      // Read the bucket rather than trusting what the page was showing. A grant removed by another
      // administrator between the page rendering and this request is one there is nothing left to
      // take, and the list below is what says so.
      const plan = await readPlan(s3, config, id);
      if (!plan) throw new HttpError(404, `no plan stored for ${id}`);

      // The LIVE holders - the inspector's snapshot with the inline writer's record of what its
      // runs left standing laid over it. Reading the snapshot alone is what made a grant made since
      // the last inspection unrevokable: the screen offered nobody, and a request naming somebody
      // anyway was refused here with a list that did not have them in it.
      const holders = new Set(plan.passrole?.granted_to ?? []);
      const notHeld = named.filter((u) => !holders.has(u));
      if (notHeld.length > 0) {
        throw new HttpError(
          409,
          `${notHeld.join(', ')} — 이 역할의 PassRole 을 가지고 있지 않습니다. 회수는 미러 역할의 `
          + `태그가 기록했거나 인라인 작성기가 문서에서 확인한 보유자에게만 할 수 있고, 지금 `
          + `보유자는 ${[...holders].sort().join(', ') || '없음'} 입니다.`,
        );
      }
      // The mirror role has to exist for there to be a statement to remove. A plan that only
      // creates one has produced no ARN yet, and the applier would derive a name for a role that is
      // not there.
      if (!plan.passrole?.target_arn) {
        throw new HttpError(
          409,
          `${id} 의 미러 역할이 아직 만들어지지 않았습니다. 회수할 문장이 있으려면 역할이 먼저 `
          + '있어야 합니다.',
        );
      }

      const [accountId, resource] = id.split(':');
      const requestId = retryRequestId(accountId);
      const marker = {
        request_id: requestId,
        plan_id: plan.plan_id,
        account_id: accountId,
        resource,
        decision: 'approve',

        // What makes this a withdrawal rather than a decision. The applier applies nothing on this
        // path and refuses a marker that carries a grant, a restriction, or a denial.
        passrole_revoke: true,
        passrole_revoke_from: named,

        reviewer,
        comment,
        decided_at: new Date().toISOString(),

        // Carried because the applier's parse requires them, and true of the plan standing here.
        // Nothing on this path reads them: no plan file is downloaded and no apply is run. Which
        // role the grant comes off is DERIVED by the applier from the account and the resource, so
        // that the statement and the mirror role tag cannot name different roles.
        changes_sha256: plan.changes_sha256,
        plan: {
          bucket: config.stateBucket,
          prefix: planPrefixFromId(id),
          tfplan_sha256: plan.plan_file_sha256,
        },

        issued_by: { component: 'opt-SolutionDashboard', release: config.release },
        schema: 1,
      };

      const key = `${config.applierPrefix}${requestId}.json`;
      const bytes = await putJson(s3, config.markerBucket, key, marker);
      markerBodies.put('applier', requestId, marker, 'written-here');

      log.info('passrole withdrawal plan=%s request=%s reviewer=%s from=%s key=s3://%s/%s bytes=%d',
        id, requestId, reviewer, named.join(','), config.markerBucket, key, bytes);

      await store.refresh(`passrole withdrawal on ${id}`).catch((err) => {
        log.warn('withdrawal written and the sweep after it failed plan=%s request=%s error=%s',
          id, requestId, err?.message ?? err);
      });
      return { written: `s3://${config.markerBucket}/${key}`, marker };
    },
  };
}

