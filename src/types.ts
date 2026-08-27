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
   * refused            the LAST inspection of this resource produced no plan. Either there has
   *                    never been one, or the one stored here is older than that inspection - the
   *                    spec moved on and planning the current version failed. Nobody's decision;
   *                    somebody has to change the resource
   */
  state: "awaiting_decision" | "decided" | "applied" | "closed" | "no_changes" | "refused";
  /** Why the last inspection produced no plan, when it did not. See PlanRefusal. */
  refusal: PlanRefusal | null;

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

/**
 * What a refused inspection left behind, written by the inspector into the plan prefix.
 *
 * The gap it closes: a refusal is a COMPLETED run, so its marker is deleted, so the request used
 * to vanish - the reason lived in CloudWatch and nowhere a person at this page would ever be. A
 * spec role carrying twelve managed policies against a limit of ten produced no plan, no failure
 * and no row.
 */
export interface PlanRefusal {
  /** The inspection that was refused. Compared with the plan's own to decide what this means. */
  request_id: string | null;
  kind: string | null;
  /**
   * The refusal message verbatim, never a code. What makes it actionable is the sentence -
   * "12 managed policies including the baseline, and the limit is 10" says remove two.
   */
  reason: string;
  refused_at: string | null;
  /**
   * True when a plan IS stored here and this refusal is newer than it. The plan is real and still
   * approvable, and it describes an earlier version of the resource - which is the thing nothing
   * said before, and the reason the state outranks "awaiting decision".
   */
  supersedes_plan: boolean;
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
  /**
   * The applied permission set's ARN, from the document's terraform outputs - the value every
   * plan-time artifact writes as "(known after apply)", readable only once the applier has run.
   * Null on non-permission-set plans, on denials, and on outcomes recorded before the applier
   * captured outputs; the Governed link falls back to the Identity Center console home then.
   */
  permission_set_arn: string | null;
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
  /**
   * Why the last inspection of this resource produced no plan, when it produced none.
   *
   * Read from the prefix as this page opens rather than carried from the sweep's row: the sweep
   * runs on an interval, and the moment a refusal matters most is the one right after somebody
   * changed the resource and came here to see what happened.
   */
  refusal: PlanRefusal | null;
  /**
   * Whether a plan is stored here at all. False on a resource whose FIRST inspection was refused -
   * there is a reason and nothing to decide, and the empty fields below are empty because nothing
   * was ever written, not because reading them failed.
   */
  plan_stored: boolean;
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

  /**
   * The risk analysis the reviewer was looking at, cited rather than carried.
   *
   * Four values and no content: the findings are advisory text and the applier has nothing to do
   * with them, whereas "this decision was taken while reading analysis <findings_sha256> of
   * assessment <impact_sha256>, from <model_id> under prompt <prompt_version>" is what makes the
   * record answerable months later. The server refuses a citation whose impact_sha256 is not the
   * digest it just verified.
   */
  risk_analysis?: RiskAnalysisCitation;
}

export interface RiskAnalysisCitation {
  findings_sha256: string;
  model_id: string;
  prompt_version: string;
  impact_sha256: string;
}

/** One thing an administrator decided, before it is a policy statement.
 *
 * The four intents are not interchangeable. They produce different statements and they go stale in
 * opposite directions, so the page asks which one is meant rather than guessing:
 *
 *   allow_only     Deny with NotResource. Anything not listed - including resources created
 *                  tomorrow - is denied. Grows with what is KEPT
 *   deny_only      Deny with Resource. Small, and a resource created tomorrow is allowed
 *   deny_action    Deny with Resource "*". The action itself, whatever it would have touched
 *   tag_condition  Deny with a tag condition. Fixed size however many it covers, and it keeps
 *                  covering resources that get the tag later
 *
 * COMPOSABLE, and this is what the editor was rebuilt for. One policy may carry a decision of each,
 * as separate entries here, and they become separate statements. The page used to offer a single
 * choice of intent, which is why deny_action could not be said at all - the only flat Deny it could
 * produce was the one an unscopable action gets by default.
 *
 * deny_action is the same STATEMENT as deny_only with no resources and a different DECISION. The
 * container refuses an empty deny_only unless every action it names is one no list could scope,
 * because that shape is what "forgot to pick resources" looks like; this one is deliberate.
 */
export interface Restriction {
  /** Which attached policy prompted this. Recorded; it does not scope the statement. */
  policy: string;
  intent: RestrictionIntent;
  actions: string[];
  /** allow_only: what to KEEP. deny_only: what to deny. Empty for the other two. */
  resources?: string[];
  tag_key?: string;
  tag_values?: string[];
  /**
   * key_condition only. The key must be one the ACTION DECLARES (action_reference.condition_keys),
   * or the condition never evaluates - StringEquals then denies nothing, StringNotEquals denies
   * every call, and either way the statement reads as the chosen control.
   */
  condition_key?: string;
  condition_values?: string[];
  /**
   * BOTH condition intents carry the operator. tag_condition's branch hardcoded StringEquals until
   * the operator existed, so absence on a STORED tag decision means StringEquals - the open form,
   * under which a resource carrying no such tag does not match and walks past the control. The
   * editor proposes StringNotEquals for a new one; that is a different thing from what an unmarked
   * old record means. key_condition was born closed and its absence means StringNotEquals.
   */
  condition_operator?: "StringNotEquals" | "StringEquals";
}

/**
 * A decision an organisation made once, offered as a pre-filled form on every plan.
 *
 * Not a policy installed anywhere - see server/templates.js for why that shape was refused. It
 * names ACTIONS and only the three intents that mean the same thing in every account; the binding
 * to attached policies is resolved per plan against that plan's own assessment.
 */
export interface RestrictionTemplate {
  id: string;
  title: string;
  /** The sentence an approver reads before agreeing - what the control does and what it costs. */
  why: string;
  restrictions: {
    intent: "deny_action" | "tag_condition" | "key_condition";
    actions: string[];
    tag_key?: string;
    tag_values?: string[];
    condition_key?: string;
    condition_values?: string[];
    condition_operator?: "StringNotEquals" | "StringEquals";
  }[];
}

export type RestrictionIntent =
  "allow_only" | "deny_only" | "deny_action" | "tag_condition" | "key_condition";

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
  /**
   * Which restrictable policies grant iam:PassRole and to which services, read from the granting
   * statements themselves. The inline writer composes the PassRole fence from this; the page uses
   * it to say WHY a policy is getting a fence, and to count the fence's bytes against the inline
   * quota. Absent on assessments written before the querier recorded it.
   */
  passrole_grants?: ImpactPassRoleGrant[];
  coverage: ImpactCoverage;
}

export interface ImpactPassRoleGrant {
  identifier: string;
  source: ImpactPolicy["source"];
  /** iam:PassedToService values of the granting statement - one fence statement per service. */
  services: string[];
  /** True when the grant carries no iam:PassedToService at all. The writer refuses those by name. */
  unconditioned: boolean;
}

export interface ImpactActionReference {
  /** The canonical digest of the reference the container built this from. */
  reference_version: string;
  retrieved_at: string;
  /**
   * service prefix -> bare action name -> [access level, resource types, makes them?].
   *
   * The third element is present only when true, and only for an action that brings EVERY type it
   * names into being - lambda:CreateFunction, not lambda:CreateAlias, which makes an alias on a
   * function that has to already exist. An enumeration is a list of what exists, so it is no scope
   * for one of these: generator/restriction.makes_its_own_target refuses the shape, and the picker
   * offers them as a flat Deny instead of asking which of the existing ones to keep.
   */
  services: Record<string, Record<string, ImpactActionEntry>>;
  /**
   * service prefix -> the resource types that sit UNDER another one.
   *
   * What an index can hold is the container: Resource Explorer reports a bucket and never an
   * object. So an action naming one of these operates below the ARN the administrator picked, and
   * its statement needs the pattern for what is inside as well - arn:aws:s3:::b does not match
   * arn:aws:s3:::b/key. Absent on assessments written before the container carried it, and an
   * absent map means no expansion, which is the behaviour those assessments were written under.
   */
  nested_types?: Record<string, string[]>;
  /**
   * service -> action name -> the patterns naming the whole of every type the action brings into
   * being, with ${Partition}/${Account} left for the page to substitute from the picked ARNs. The
   * allow_only statement on a creating action exempts those types: the created resource's ARN
   * exists only after the call succeeds, so without the exemption the Deny matches it on every
   * call - 'only into this subnet' composed a statement denying every ec2:CreateNetworkInterface
   * in the account. Absent on older assessments; the preview then composes without the exemption
   * and the runbook's re-query step is what closes that window.
   */
  created_formats?: Record<string, Record<string, string[]>>;
  /**
   * service -> action name -> the service-specific condition keys the action DECLARES, per the AWS
   * service reference. The key_condition vocabulary: the editor offers these instead of a bare
   * text field, and the decision route refuses a key outside them - a condition on a key the
   * action never supplies is recorded and never evaluated. Absent on older assessments.
   */
  condition_keys?: Record<string, Record<string, string[]>>;
  /**
   * The allow_only verdict per admitted action that carries one, judged at table build time
   * against the AWS API request models. `refuse` names why the intent cannot hold: the call is
   * authorised against resources the caller never names (an AssociationId resolved at call time,
   * a type no parameter names), so a NotResource of picked ARNs denies every call while reading
   * as a scope. `cover` lists the participating types a safe multi-type action must keep at least
   * one resource of EACH - an under-picked type's authorisation context falls outside the list
   * and denies every call the same way. Safe single-type actions carry nothing. Absent as a whole
   * on assessments written before the reference carried it - the writer then judges alone.
   */
  allow_only?: Record<string, Record<string, { refuse?: string; cover?: string[] }>>;
  /**
   * The actions AWS evaluates no aws:ResourceTag for - every resource type they name lacks the
   * key, or they name none at all. A tag condition on one of these never fires: under StringEquals
   * it denies nothing, under StringNotEquals it denies every call, and both read as the chosen
   * control. Fully-qualified names ("iam:AttachGroupPolicy"). Absent on older assessments.
   */
  no_resource_tag?: string[];
}

export type ImpactActionEntry =
  | [ImpactAccessLevel, string[]]
  | [ImpactAccessLevel, string[], true];

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
  /**
   * A name the resource carries outside its ARN. Only a KMS key has one today: its ARN ends in a
   * UUID, so a list of keys says nothing about WHICH keys, and the alias is what people call them
   * by. Absent means there is no such name - not that the lookup failed.
   */
  alias?: string;
}

export interface ImpactCoverage {
  services_failed: string[];
  /**
   * Every enumeration the assessment performed, by service, whatever came of it. "searched and
   * kept nothing" and "excluded before the search" render identically as an absent group, and
   * this is what tells them apart from the stored document. Absent on assessments written before
   * the querier recorded it.
   */
  services_enumerated?: Record<
    string,
    { seen: number; kept: number; truncated: boolean; error: string | null }
  >;
  truncated_groups: string[];
  policies_unreadable: string[];
  /** Actions the reference did not know. Their groups fall back to service level attribution. */
  actions_unresolved?: string[];
  /**
   * Resource types Resource Explorer reported that the action reference cannot resolve, and how many
   * of each were dropped. Non-empty means the enumeration is short by that many resources - the two
   * vocabularies name the same ARN differently and nothing bridged this one.
   */
  types_unknown?: Record<string, number>;
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

// ---- the risk analysis --------------------------------------------------------------------------
//
// Two kinds of finding arrive in one answer and they are NOT merged into one list here.
//
//   source 'rule'   a predicate in finding-rules.json fired. Deterministic, reproducible from the
//                   assessment alone, and its sentence is the rule's own text
//   source 'model'  a candidate path the code proposed and Claude judged. Its sentence was written
//                   by a model, and every action it cites was checked against the grant
//
// An approver reads them differently, so the page says which is which on every card. What they
// share is the shape below, which is what lets one sort and one card renderer serve both.

export type Grade = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";
export type AssetGrade = Grade | "UNDETERMINED";
export type FindingStatus = "CONFIRMED" | "UNVERIFIED" | "NOT_ASSESSABLE";
export type FindingCategory = "ESCALATION" | "EXPOSURE" | "RECON" | "DESTRUCTIVE";

/** How the pipeline recognised one of its own resources. Only the first two may move a grade. */
export type ControlPlaneBasis = "configured" | "declared" | "prefix";

export interface ControlPlaneHit {
  arn: string;
  role: string;
  basis: ControlPlaneBasis;
}

/** A resource-TYPE group a finding reaches, with the count first and the sample second. */
export interface FindingTarget {
  type: string;
  count: number;
  scope: string;
  sample: string[];
  /** False means the ARNs shown are a sample of a larger group. */
  sampleComplete: boolean;
  controlPlane: ControlPlaneHit[];
}

/**
 * What to deny to close a path, and what denying it costs.
 *
 * The restriction editor is on the same screen as the finding, so this is the one field that
 * reaches into it. `breaks` is why it is not just a list of actions: an approver who denies without
 * knowing what stops working denies once and reverts.
 */
export interface Containment {
  /** A subset of triggerActions. Never an action the finding did not cite. */
  denyActions: string[];
  /** What legitimate work stops when those actions are denied. */
  breaks: string;
  /** The path is already closed elsewhere - a permissions boundary, a condition, a service control. */
  blockedElsewhere: boolean;
  /**
   * Proposed deny actions that sit on the declaration path. Denying one locks the user out of the
   * pipeline that governs them, so these cannot go into a restriction whatever the model proposed.
   */
  notRestrictable: string[];
}

/**
 * Which of the two questions a finding answers.
 *
 * resource  what this grant reaches in the account AS IT IS. Names ARNs, needs the inventory, and
 *           is what a restriction gets validated against
 * action    what this grant LETS SOMEBODY DO. Names no resource, needs nothing but the action list,
 *           and is as true on day one as on day four hundred
 *
 * They are shown as two areas and never merged. One rule can answer both - E-3 on an account with
 * instances says "these two instances" and "the execution context of whatever comes to exist", and
 * those are different sentences with different lifetimes.
 */
export type FindingAxis = "resource" | "action";

export interface Finding {
  id: string;
  axis: FindingAxis;
  /** True when the same rule and policy also produced a finding on the other axis. */
  alsoOnOtherAxis?: boolean;
  category: FindingCategory;
  title: string;
  escalationGrade: Grade;
  /** UNDETERMINED unless this deployment's configuration identified the resource. Never a sort key. */
  assetImpactGrade: AssetGrade;
  assetEvidence: ControlPlaneHit[];
  status: FindingStatus;
  /** Why the status is not CONFIRMED. Every entry is a sentence about the EVIDENCE. */
  blockedBy: string[];
  policyName: string;
  policyId: string;
  isBaseline?: boolean;
  /** The exact action names that fired it. Shown in full - never abbreviated, never a count. */
  triggerActions: string[];
  targets: FindingTarget[];
  restrictable: boolean;
  relatedTo: string[];
  narrative: string;
  notes?: string | null;
  /** null means enumeration completeness was never established. Not the same as false. */
  truncated: boolean | null;
  omittedCount?: number | null;

  // Only on a model finding.
  source?: "model";
  edge?: string;
  outcome?: string;
  /** What the model asked for before the outcome's ceiling was applied. */
  proposedGrade?: Grade;
  capped?: boolean;
  humanError?: boolean;
  mechanism?: "new_resource" | "existing_resource" | "both" | "neither";
  preconditions?: string[];
  finalImpact?: string;
  evidenceSufficient?: boolean;
  containment?: Containment;
  /**
   * Rule ids that already reached this path. Both halves run over the same digest, so they collide;
   * the page groups on this rather than showing one fact twice under two labels at two grades.
   */
  alreadyFoundBy?: string[];
}

/** A candidate the code proposed and the model judged not to be a path. */
export interface RejectedCandidate {
  id: string;
  edge: string;
  outcome: string;
  policyId: string;
  policyName: string;
  title: string;
  why: string;
  citedActions: string[];
}

export interface ModelAnalysis {
  analysis_version: number;
  prompt_version: string;
  model_id: string;
  impact_sha256: string | null;
  rules_sha256: string | null;
  findings: Finding[];
  rejected: RejectedCandidate[];
  /** Verdicts refused, with the reason. A run that answered four of sixty is a different answer. */
  dropped: { id: string; why: string }[];
  failures: { batch: number; candidates: string[]; why: string }[];
  candidates: number;
  answered?: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /**
   * How long the run took, and the shape that made it that long.
   *
   * batchMs entries OVERLAP - batches are sent concurrently - so they do not sum to totalMs. The
   * gap between the largest entry and the total is what the concurrency actually bought.
   */
  timing?: { totalMs: number; batchMs: number[]; concurrency: number; deadlineMs: number };
  findings_sha256?: string;
  /** Present only when the whole run was thrown away for citing an action granted nowhere. */
  discarded?: { why: string; fabricated: { id: string; action: string }[] };
}

/**
 * A model run the server is doing on its own time.
 *
 * `failed` is the RUN failing - the process lost it, or something threw where nothing should. A
 * model outage is not this: it comes back as a finished answer carrying `analysis_error`, because
 * the rule findings in that answer still stand.
 */
export interface AnalysisRun {
  state: "running" | "done" | "failed";
  started_at: string;
  elapsed_ms: number;
  /** null batches means the run has not worked out how many there are yet. */
  progress: { batches: number | null; done: number; elapsedMs?: number };
  error: string | null;
  /** Which assessment the run is about. A run left over from a replaced one is not this answer. */
  impact_sha256?: string | null;
}

export interface RiskAnalysisAnswer {
  plan_id: string;
  request_id: string;
  impact_sha256: string | null;
  rules_sha256: string;
  prompt_version: string;
  /** What the condensed assessment cost to ask about. */
  digest_bytes: number;
  /** What the condenser left out, and whether it is recoverable. */
  dropped: { what: string; count: number; why: string; recoverable: boolean }[];
  /**
   * Resource types the inventory reported that the action reference could not resolve, and how many
   * of each were dropped. Not a condenser loss - these never reached the assessment at all.
   */
  types_unknown?: Record<string, number>;
  /**
   * Mutating actions no layer could classify - not curated, not classified by the assessment's
   * action reference, and no recognised verb.
   *
   * They reach no attack-path edge, so no candidate names them and no capability rule term matches
   * them: the model was never asked about them. Reported because until it was counted, that was
   * indistinguishable on screen from there being nothing to ask.
   */
  actions_unclassified?: number;
  actions_unclassified_sample?: string[];
  rule_findings: Finding[];
  rule_sections: { category: FindingCategory; findings: Finding[] }[];
  rule_summary: {
    total: number;
    byGrade: Record<string, number>;
    byStatus: Record<string, number>;
    byCategory: Record<string, number>;
    notRestrictable: number;
    enumerationIncomplete: number;
  };
  candidates: number;
  /** How many candidates a rule had already found. The two halves overlap; this is by how much. */
  candidates_covered_by_rules?: number;
  analysis: ModelAnalysis | null;
  /**
   * The model half, which runs on the server after the POST has already answered.
   *
   * Null when no model was asked at all. The rules never appear here - they are finished before
   * the POST returns, so nothing about them is ever pending.
   */
  run?: AnalysisRun | null;
  /** Why no model answered. Not an error state - the rules ran either way. */
  analysis_error: string | null;
}
