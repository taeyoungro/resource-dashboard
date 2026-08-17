// Types for controlPlane.js. The page renders these labels beside a finding, so the union is
// exported rather than left as string - a label the renderer has no wording for should be a type
// error, not an empty span.

export declare const ROLES: {
  APPROVAL_STORE: 'approval_store';
  STATE_LOCK: 'state_lock';
  TERRAFORM_STATE: 'terraform_state';
  INLINE_STATE: 'inline_state';
  MARKER_STORE: 'marker_store';
  EVENT_QUEUE: 'event_queue';
  TASK_CLUSTER: 'task_cluster';
  PIPELINE_ROLE: 'pipeline_role';
  GOVERNED_ARTIFACT: 'governed_artifact';
  OPERATOR_DECLARED: 'operator_declared';
};

/** A configured role label, or an operator's own free-text label. */
export type ControlPlaneRole = (typeof ROLES)[keyof typeof ROLES] | (string & {});

export interface ControlPlaneConfig {
  markerBucket: string;
  stateBucket: string;
  inlineStateBucket: string;
  approvalTable: string;
  lockTable: string;
  eventQueue: string;
  cluster: string;
  solutionPrefix: string;
  mirrorPrefix: string;
  specPolicyPrefix: string;
  /** "<arn>" or "<arn>|<label>". */
  controlPlaneArns: string[];
}

export interface ControlPlane {
  classify(arn: string | null | undefined): ControlPlaneRole | null;
  /** How many EC2 instances an operator declared. Zero means instance takeover cannot be ranked. */
  declaredInstances(): number;
  declaredCount: number;
}

export declare function controlPlane(config: ControlPlaneConfig): ControlPlane;
