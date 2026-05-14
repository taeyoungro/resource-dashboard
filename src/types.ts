export type BufferAction = "ATTACH" | "REFRESH" | "DELETE";

export interface PolicyDetail {
  is_necessary: boolean;
  confidence: "high" | "medium" | "low" | "n/a" | string;
  reason: string;
}

export interface ApprovalSummary {
  request_id: string;
  account_id: string;
  role_name: string;
  action: BufferAction;
  requester_iic_user: string | null;
  policy_arns: string[];
  first_event_at: string;
  last_event_at: string;
  status: "pending" | "approved" | "denied" | "applying" | "applied" | "failed";
}

export interface ApprovalDetail extends ApprovalSummary {
  policy_details: Record<string, PolicyDetail>;
  plan_tail: string;
  approval_report: string;
  target_accounts: string[];
}

export interface ResourceEvent {
  event_id: string;
  request_id: string;
  account_id: string;
  role_name: string;
  ps_name: string | null;
  action: BufferAction;
  outcome: "applied" | "destroyed" | "rag_rejected";
  policy_arns: string[];
  target_accounts: string[];
  requester_iic_user: string | null;
  reviewer: string | null;
  reason: string | null;
  applied_at: string;
}

export interface DecisionPayload {
  decision: "approve" | "deny";
  reviewer: string;
  comment?: string;
}
