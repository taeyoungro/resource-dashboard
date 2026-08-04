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
  request_id: string;
  account_id: string | null;
  resource: string | null;
  planned_at: string | null;
  plan_etag: string | null;
  plan_bytes: number | null;
  artifacts: string[];

  /**
   * awaiting_decision  no approval marker beside it
   * decided            an approval marker exists, so the applier has it
   *
   * These cannot distinguish a plan nobody has looked at from one already applied: the applier
   * deletes its marker when it finishes and nothing is written in its place. Known, and shown on
   * the page rather than hidden behind a filter.
   */
  state: "awaiting_decision" | "decided";
}

export interface PlanChange {
  address: string;
  type: string;
  name: string;
  actions: string[];
}

export interface PlanDetail {
  request_id: string;
  account_id: string | null;
  resource: string | null;
  planned_at: string | null;
  plan_etag: string | null;
  plan_bytes: number | null;
  /** Recorded in the approval so the applier can tell whether the plan was replaced since. */
  plan_sha256: string | null;
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
}

export interface DecisionResult {
  written: string;
  marker: Record<string, unknown>;
}
