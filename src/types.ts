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
   * awaiting_decision  no approval marker beside it
   * decided            an approval marker exists, so the applier has it
   * no_changes         the twin already matches the spec; nothing to decide
   *
   * The first two cannot distinguish a plan nobody has looked at from one already applied: the
   * applier deletes its marker when it finishes and nothing is written in its place. Known, and
   * shown on the page rather than hidden behind a filter.
   */
  state: "awaiting_decision" | "decided" | "no_changes";
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
