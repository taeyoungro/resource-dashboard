import type { ApprovalDetail, ApprovalSummary, DecisionPayload, ResourceEvent } from "./types";

const BASE = "/api";

const apiKey = (): string => {
  return (
    (typeof window !== "undefined" && window.localStorage.getItem("pipeline_api_key")) ||
    import.meta.env.VITE_PIPELINE_API_KEY ||
    ""
  );
};

const headers = (): HeadersInit => {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const k = apiKey();
  if (k) h["X-API-Key"] = k;
  return h;
};

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listApprovals: async (): Promise<ApprovalSummary[]> =>
    handle(await fetch(`${BASE}/approvals`, { headers: headers() })),

  getApproval: async (requestId: string): Promise<ApprovalDetail> =>
    handle(await fetch(`${BASE}/approvals/${encodeURIComponent(requestId)}`, { headers: headers() })),

  decide: async (requestId: string, payload: DecisionPayload): Promise<ApprovalDetail> =>
    handle(
      await fetch(`${BASE}/approvals/${encodeURIComponent(requestId)}/decision`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }),
    ),

  listResources: async (): Promise<ResourceEvent[]> =>
    handle(await fetch(`${BASE}/resources`, { headers: headers() })),

  getResource: async (eventId: string): Promise<ResourceEvent> =>
    handle(await fetch(`${BASE}/resources/${encodeURIComponent(eventId)}`, { headers: headers() })),

  setApiKey: (key: string): void => {
    window.localStorage.setItem("pipeline_api_key", key);
  },
};
