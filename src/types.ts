// The shapes the server returns. They follow what is actually in the two buckets.
//
// The previous version of this file described an approval record with role_name, policy_arns and
// a RAG analysis, served by a FastAPI process that was never built. Nothing produces those. What
// exists is a plan prefix in the state bucket and markers in the marker bucket, so that is what
// is modelled here.

/** A marker still sitting in the bucket. */
export interface Marker {
  /** Which container the prefix belongs to - the one that should have deleted it. */
  kind: "inspector" | "applier";
  key: string;
  request_id: string;

  /** From the marker body. Null when the body could not be read. */
  account_id: string | null;
  resource: string | null;
  request_kind: string | null;

  /** Approval markers only. */
  reviewer: string | null;
  decision: "approve" | "deny" | null;

  last_modified: string | null;
  age_seconds: number | null;

  /**
   * running  younger than the grace period; the task is presumably still working
   * failed   older, and the task that should have deleted it did not
   */
  state: "running" | "failed";

  body_read: boolean;
  event_count: number | null;
  first_event_at: string | null;
  last_event_at: string | null;
}

/** A plan stored by the inspector. */
export interface PlanSummary {
  /**
   * <account id>:<resource> - the governed resource this plan belongs to, and what identifies it
   * everywhere. One resource has one state and one plan; a new inspection replaces the stored plan
   * rather than adding a second one to decide about.
   */
  plan_id: string;
  /** Which inspection produced the stored plan. Read from request.json, not from the key. */
  request_id: string | null;
  account_id: string | null;
  resource: string | null;
  planned_at: string | null;
  plan_etag: string | null;
  plan_bytes: number | null;
  artifacts: string[];

  /**
   * awaiting_decision  no approval marker beside it and no outcome
   * decided            an approval marker exists, so the applier has it and has not finished
   * applied            the applier applied it and recorded outcome.json
   * closed             the applier finished with it without applying - a denial
   * no_changes         the twin already matches the spec; nothing to decide
   */
  state: "awaiting_decision" | "decided" | "applied" | "closed" | "no_changes";

  /** The applier's record, once it has finished with this plan. Null until then. */
  outcome: PlanOutcome | null;
}

/** What the applier did, read from outcome.json in the plan prefix.
 *
 * This is the surviving copy of the decision. The applier deletes the approval marker when it
 * finishes, and CloudTrail records that the object went rather than what was in it - so the
 * reviewer and the decision are carried here first, and this is what anybody reads afterwards.
 */
export interface PlanOutcome {
  decision: "approve" | "deny" | null;
  reviewer: string | null;
  /** False on a denial, and false on an approval the applier refused. Both are outcomes. */
  applied: boolean;
  /** terraform's own summary line, or why it was not applied. */
  detail: string;
  finished_at: string | null;
}

export interface PlanChange {
  address: string;
  type: string;
  name: string;
  actions: string[];
}

export interface PlanDetail {
  plan_id: string;
  /** Which inspection produced this plan, and what the approval marker gets named by. */
  request_id: string | null;
  /** False when the twin already matches the spec. Such a plan cannot be approved. */
  has_changes: boolean;
  /** What the applier did, once it has finished. A plan with one is not awaiting anything. */
  outcome: PlanOutcome | null;
  account_id: string | null;
  resource: string | null;
  planned_at: string | null;
  plan_etag: string | null;
  plan_bytes: number | null;
  /**
   * The inspector's digest of what the plan will DO, read from the prefix's changes.sha256. The
   * applier recomputes it with terraform show -json on the plan file it holds, and refuses unless
   * the two agree - which is how it establishes that the plan.txt shown here describes that file.
   *
   * It is also what a decision names: the value the page displayed is sent back with the decision,
   * and the server refuses if the stored plan is no longer that one. The prefix is overwritten in
   * place by every new inspection, so without that check a decision could be filed against a plan
   * the reviewer never saw.
   *
   * Null on a plan written before the inspector produced the artifact. Such a plan cannot be
   * approved: a prefix is six separate objects, and without this nothing rules out a tfplan from
   * one plan sitting beside a plan.txt from another.
   */
  changes_sha256: string | null;
  /**
   * The saved plan file's own hash. This is what the approval binds to - the applier runs the
   * inspector's file unchanged, because the generated document names a profile rather than a role
   * and is therefore identical whichever container produced it.
   */
  plan_file_sha256: string | null;
  /** terraform show, as a person reads it. This is the thing being approved. */
  plan_text: string;
  /** The generated configuration the plan came from. */
  config_json: string;
  changes: PlanChange[];
  artifacts: string[];
}

/** An announcement from the listener that it dispatched an inspection.
 *
 * NOT a state. Nothing here is believed: the sweep reads the buckets and decides what exists, and
 * it will contradict a fabricated announcement on its next pass. What this buys is latency - the
 * page learns that work started in seconds rather than at the next sweep - and a recent-activity
 * view, which the buckets cannot give at all, because a finished inspection deletes its marker and
 * leaves nothing behind that says it ran.
 *
 * In memory on the server and emptied by a restart. Everything durable is in S3.
 */
export interface Notification {
  id: string;
  kind: "inspector" | "applier" | "inline_writer";
  request_id: string;
  account_id: string | null;
  resource: string | null;
  request_kind: string | null;
  marker_bucket: string | null;
  marker_key: string;
  task_arn: string | null;
  event_count: number;
  event_names: string[];
  first_event_at: string | null;
  last_event_at: string | null;
  /** quiet is the normal one. max_wait means the buffer hit its hard ceiling. */
  buffer_reason: string | null;
  held_seconds: number | null;
  dispatched_at: string | null;
  received_at: string;
  first_received_at: string;
  /** Above zero when the same request was announced again - a redelivered queue message. */
  repeats: number;
}

export interface NotificationFeed {
  notifications: Notification[];
  /** False when OPT_DASHBOARD_INGEST_KEY is unset on the server; the listener cannot announce. */
  enabled: boolean;
}

export interface SweepState {
  swept_at: string;
  markers: Marker[];
  plans: PlanSummary[];
  /** Partial failures during the sweep. Shown, because a quiet half-sweep looks like calm. */
  errors: string[];
  /**
   * Keys under a marker prefix that are not markers - a folder placeholder left by the S3 console,
   * most often. Counted rather than reported as an error: it is a normal thing to find in a bucket
   * somebody made by hand, and calling it a failure teaches everyone to ignore the banner.
   */
  skipped_keys?: number;
  counts: {
    failed: number;
    running: number;
    awaiting_decision: number;
  };
  stale?: boolean;
}

export interface DecisionPayload {
  decision: "approve" | "deny";
  reviewer: string;
  comment?: string;
  /**
   * The digest of the plan this decision was made about - whatever the page was displaying. The
   * server refuses the decision if the stored plan is no longer that one.
   *
   * Required, because the plan prefix is keyed by the governed resource and is overwritten in
   * place: between this page rendering and the decision arriving, another edit to the same
   * resource can have replaced the plan entirely. Without this the server would happily file an
   * approval for a plan the reviewer never read, and every later check would pass.
   */
  expected_changes_sha256: string;
}

export interface DecisionResult {
  written: string;
  marker: Record<string, unknown>;
}
