// Which of the assessed resources are the governance pipeline's OWN.
//
// The rules this analysis follows forbid deriving a grade or a sentence from a resource NAME - a
// table called opt-approval-store must not be graded as an approval store because of what it is
// called, because in another account the same table is called something else and the inference
// silently inverts.
//
// This module is not that. It answers a different question with a different kind of evidence: is
// this ARN one of the resources THIS DEPLOYMENT IS CONFIGURED WITH? The dashboard already reads
// the marker bucket and the state bucket by name because it was told to; the approval table, the
// lock table, the queue and the cluster are named in the same environment, in the same file, by
// the same operator; and the opt-*/mirror-* roles carry names the pipeline ISSUES rather than
// names it interprets. Every match below is against a configured value, never against a pattern
// somebody hoped meant something.
//
// Why it matters enough to exist: the three most severe paths a permission grant can open in this
// system are not about the account's own workloads at all - they are writes to the machinery that
// decides what gets approved. An approval item written directly, a lock item forged or deleted, an
// instance whose role is the pipeline's. Without this, every one of those reads as "a DynamoDB
// table" or "an EC2 instance" and ranks below a production database.
//
// What it cannot know, it says. An EC2 instance carries no name this deployment configured, so the
// instances that run the listener and this dashboard are identifiable only if an operator declares
// them (OPT_CONTROL_PLANE_ARNS). Undeclared, they are reported as undeclared rather than treated
// as ordinary - see declaredInstances().

import { parseArn } from './arn.js';

/**
 * What a control-plane resource DOES in the pipeline, as a stable machine label.
 *
 * Labels, not sentences. The renderer and the analysis prompt turn these into words; keeping the
 * label a fixed token is what stops a narrative being derived from a customer's naming.
 */
export const ROLES = {
  APPROVAL_STORE: 'approval_store',
  STATE_LOCK: 'state_lock',
  TERRAFORM_STATE: 'terraform_state',
  INLINE_STATE: 'inline_state',
  MARKER_STORE: 'marker_store',
  EVENT_QUEUE: 'event_queue',
  TASK_CLUSTER: 'task_cluster',
  PIPELINE_ROLE: 'pipeline_role',
  GOVERNED_ARTIFACT: 'governed_artifact',
  OPERATOR_DECLARED: 'operator_declared',
};

/** An operator-declared entry: "<arn>" or "<arn>|<free-text label>". */
function parseDeclared(entry) {
  const [arn, label] = String(entry).split('|');
  const trimmed = (arn ?? '').trim();
  if (!trimmed.startsWith('arn:')) return null;
  return { arn: trimmed, label: (label ?? '').trim() || ROLES.OPERATOR_DECLARED };
}

/**
 * The lookup the digest uses: an ARN in, a role label out, or null.
 *
 * Built once per config rather than per resource - an assessment carries thousands of ARNs and
 * this runs against every one of them.
 */
export function controlPlane(config) {
  // Exact resource names, per service, from configuration. The account and region are deliberately
  // NOT part of the match: the assessment is scoped to one account already, and a lock table in
  // another region with the configured name is still this pipeline's lock table.
  const byService = new Map([
    ['dynamodb', new Map([
      [config.approvalTable, ROLES.APPROVAL_STORE],
      [config.lockTable, ROLES.STATE_LOCK],
    ])],
    ['s3', new Map([
      [config.stateBucket, ROLES.TERRAFORM_STATE],
      [config.inlineStateBucket, ROLES.INLINE_STATE],
      [config.markerBucket, ROLES.MARKER_STORE],
    ])],
    ['sqs', new Map([[config.eventQueue, ROLES.EVENT_QUEUE]])],
    ['ecs', new Map([[config.cluster, ROLES.TASK_CLUSTER]])],
  ]);

  // Names the pipeline ISSUES. opt-* is every role and policy this solution creates for itself;
  // mirror-* and cmp-* are the governed namespaces it manages on a user's behalf. Both are
  // configured prefixes (the generator writes them), so matching them is recognising this
  // deployment's own output - not reading intent into a string.
  const prefixes = [
    { on: 'iam', prefix: config.solutionPrefix, role: ROLES.PIPELINE_ROLE },
    { on: 'iam', prefix: config.mirrorPrefix, role: ROLES.GOVERNED_ARTIFACT },
    { on: 'iam', prefix: config.specPolicyPrefix, role: ROLES.GOVERNED_ARTIFACT },
  ].filter((p) => p.prefix);

  const declared = new Map(
    (config.controlPlaneArns ?? []).map(parseDeclared).filter(Boolean)
      .map(({ arn, label }) => [arn, label]),
  );

  /** The role this ARN plays in the pipeline, or null for anything not configured here. */
  function classify(arn) {
    const text = String(arn ?? '');
    if (!text) return null;
    // An operator's explicit declaration wins: it is the most direct statement of fact available,
    // and it is the only way an EC2 instance can be known at all.
    const stated = declared.get(text);
    if (stated) return { role: stated, basis: 'declared' };

    const parsed = parseArn(text);
    if (!parsed) return null;

    const names = byService.get(parsed.service);
    const exact = names && parsed.name ? names.get(parsed.name) : undefined;
    if (exact) return { role: exact, basis: 'configured' };

    for (const { on, prefix, role } of prefixes) {
      if (parsed.service === on && parsed.name && parsed.name.startsWith(prefix)) {
        // Deliberately a weaker basis than the two above, and the difference is load-bearing.
        //
        // A configured value is this deployment saying "the lock table is called this". A prefix is
        // this deployment saying "I issue names beginning with this" - which is still a match
        // against a NAME, and T-4 forbids a name moving a grade. So the hit is reported, with its
        // basis, and findings.js grades on 'declared' and 'configured' only. A reader gets the
        // label; the number does not move.
        return { role, basis: 'prefix' };
      }
    }
    return null;
  }

  return {
    classify,
    /**
     * Whether any instance was declared.
     *
     * Reported rather than assumed. The listener and this dashboard run on EC2 instances whose
     * identifiers no configuration here carries, so unless an operator declared them, an instance
     * that is the pipeline's own is indistinguishable from any other - and the analysis has to say
     * that out loud rather than rank it as ordinary.
     */
    declaredInstances: () => [...declared.keys()].filter((a) => a.includes(':instance/')).length,
    declaredCount: declared.size,
  };
}
