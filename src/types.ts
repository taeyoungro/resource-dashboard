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

  /**
   * Whether the impact assessment for THIS inspection is available.
   *
   * ready        impact.json is stored. A restriction can be chosen
   * in_progress  the impact/ marker for this request still exists, so the querier is still working.
   *              Said out loud rather than shown as an empty assessment, which would read as
   *              "nothing to worry about"
   * unavailable  neither. Approval is still possible - deliberately, so an assessment outage is not
   *              a pipeline outage - just not approval with a restriction
   */
  assessment: AssessmentState;
  assessment_digest_stored: boolean;
}

export type AssessmentState = "ready" | "in_progress" | "unavailable";

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
  /**
   * The impact assessment, when there is one. Served from the querier's push when it landed and read
   * from the bucket when it did not, and matched on the plan's CURRENT request id either way - a
   * cached assessment from an earlier inspection describes a plan that no longer exists.
   */
  assessment: Impact | null;
  assessment_source: "pushed" | "stored" | null;
  /** The querier's own digest, which a restriction has to send back. Never computed by the server. */
  assessment_sha256: string | null;
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
  /** True when the marker was too large to travel with the announcement. The sweep fetches it. */
  body_omitted: boolean;
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
  /**
   * Marker bodies this sweep already held versus had to fetch from S3. Zero fetched is the healthy
   * shape - the listener announces inspector markers with their bodies, and the approval markers
   * are ones this server wrote. A number that climbs means announcements are not arriving.
   */
  bodies?: { held: number; fetched: number };
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

  /**
   * The administrator's restriction, as DECISIONS rather than as a policy document.
   *
   * Omitted for an ordinary approval, which is the common case. When present the server checks each
   * one against the impact assessment and the inline writer recomposes the statements from them -
   * this page never authors IAM content, because a defect here could otherwise write Allow where
   * somebody clicked Deny.
   */
  restrictions?: Restriction[];

  /**
   * The digest of the assessment the restriction was chosen from. Required whenever restrictions is
   * non-empty: a restriction names resources, and this is what establishes that the assessment which
   * enumerated them is the one that is still stored.
   */
  expected_impact_sha256?: string;
}

/** One thing an administrator decided, before it is a policy statement.
 *
 * The three intents are not interchangeable. They produce different statements and they go stale in
 * opposite directions, so the page asks which one is meant rather than guessing:
 *
 *   allow_only     Deny with NotResource. Anything not listed - including resources created
 *                  tomorrow - is denied. Grows with what is KEPT
 *   deny_only      Deny with Resource. Small, and a resource created tomorrow is allowed
 *   tag_condition  Deny with a tag condition. Fixed size however many it covers, and it keeps
 *                  covering resources that get the tag later
 */
export interface Restriction {
  /** Which attached policy prompted this. Recorded; it does not scope the statement. */
  policy: string;
  intent: "allow_only" | "deny_only" | "tag_condition";
  actions: string[];
  /** allow_only: what to KEEP. deny_only: what to deny. Empty for tag_condition. */
  resources?: string[];
  tag_key?: string;
  tag_values?: string[];
}

export interface DecisionResult {
  written: string;
  marker: Record<string, unknown>;
}


/** What a permission set will reach, enumerated before it is granted.
 *
 * Produced by the impact querier. Only the fields this page reads are modelled - the document
 * carries more, and adding to it must not require this file to change for the page to keep working.
 */
export interface Impact {
  request_id: string;
  account_id: string;
  resource: string;
  permission_set_name: string | null;
  inventory_as_of: string;
  /** The statements a new restriction would REPLACE. Shown so nobody overwrites one unknowingly. */
  current_admin_deny: unknown[];
  policies: ImpactPolicy[];
  /** Every enumerated ARN. A restriction may name only these. */
  allowed_resources: string[];
  /** The action patterns the plan grants, as written - wildcards included. */
  attached_actions: string[];
  /** The declaration path. Restricting any of these would lock the user out of the pipeline. */
  protected_actions: string[];
  /**
   * The actions the restriction screen offers, with each one's access level and resource types.
   *
   * Carried here rather than served from a file of the dashboard's own. That file was a second copy of
   * data AWS owns and had drifted from it - four of its twenty entries disagreed with the reference -
   * and what the screen needs is the actions THIS plan grants, which is what the container knows.
   *
   * Absent on an assessment written before the container carried it. The screen then keeps a text box,
   * which is how it worked for an uncovered service all along.
   */
  action_reference?: ImpactActionReference;
  coverage: ImpactCoverage;
}

export interface ImpactActionReference {
  /** The canonical digest of the reference the container built this from. */
  reference_version: string;
  retrieved_at: string;
  /** service prefix -> bare action name -> [access level, resource types]. */
  services: Record<string, Record<string, [ImpactAccessLevel, string[]]>>;
}

export type ImpactAccessLevel =
  "List" | "Read" | "Write" | "Permissions management" | "Tagging";

export interface ImpactPolicy {
  source: "aws_managed" | "customer_managed";
  identifier: string;
  default_version_id: string | null;
  /** Granted to every governed user at the permission set layer. Summarised, never enumerated. */
  is_baseline: boolean;
  restrictable: boolean;
  /** Why the document could not be read, when it could not. Its absence is not "grants nothing". */
  unreadable: string | null;
  /** The patterns the policy names, as written - wildcards included. Not for the picker. */
  actions_granted: string[];
  /**
   * The concrete actions the picker may offer for this policy: wildcards expanded through the AWS
   * Service Reference, protected actions removed. Absent on an assessment written before the
   * container carried it, and the screen falls back to typing.
   */
  actions_offerable?: string[];
  affected: ImpactGroup[];
  summary?: string;
}

export interface ImpactGroup {
  service: string;
  resource_type: string;
  /**
   * The actions that reach THIS resource type - not every action of the service. It used to be the
   * latter, so a DynamoDB policy listed every AMI in the account with ec2:DescribeVpcs beside it.
   */
  actions: string[];
  /** "*" when the statement named no resource, "listed" when it named ARNs or patterns. */
  scope: "*" | "listed";
  total: number;
  /** Resource Explorer returns at most 1000 per query, so a true count here is a floor. */
  truncated: boolean;
  sensitive_hits: number;
  /**
   * "resource_type" when the reference decided which actions reach this type. "service" when it could
   * not and the group therefore lists every resource of the service - the old, over-reporting answer,
   * marked so the screen can say so. Absent on an older assessment.
   */
  attribution?: "resource_type" | "service";
  resources: ImpactResource[];
}

export interface ImpactResource {
  arn: string;
  region: string;
  tags: Record<string, string>;
  sensitive: boolean;
}

export interface ImpactCoverage {
  services_failed: string[];
  truncated_groups: string[];
  policies_unreadable: string[];
  /** Actions the reference did not know. Their groups fall back to service level attribution. */
  actions_unresolved?: string[];
  /** Patterns that could not be expanded - Action "*" and its kind. Nothing was enumerated for them. */
  actions_unbounded?: string[];
  /** Known actions that name no resource. Nothing enumerated for these is an answer, not a gap. */
  actions_account_level?: string[];
  /** Services whose action list did not fit the budget. Those are typed by hand. */
  action_lists_omitted?: string[];
  /** Why the action reference is not loaded, when it is not. Null when it is. */
  reference?: string | null;
  /** False when anything above is non-empty. An incomplete assessment is still the best answer. */
  complete: boolean;
}
