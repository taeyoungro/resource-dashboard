import type {
  DecisionPayload, DecisionResult, NotificationFeed, PlanDetail, RiskAnalysisAnswer, SweepState,
} from "./types";

// Same origin. The server that serves this page is the server that answers these calls, so there
// is no host to configure and no CORS to relax. In development the Vite proxy forwards /api to
// the same process running locally - see vite.config.ts.
const BASE = "/api";

// The key gates the API; it is not an identity. Kept in sessionStorage rather than localStorage so
// closing the tab ends it: this is a shared secret on a machine people log in to, and one that
// survives until someone clears site data is one that outlives the person who typed it.
const KEY_STORAGE = "opt_dashboard_api_key";

export const apiKey = {
  get: (): string => window.sessionStorage.getItem(KEY_STORAGE) ?? "",
  set: (key: string): void => {
    if (key) window.sessionStorage.setItem(KEY_STORAGE, key);
    else window.sessionStorage.removeItem(KEY_STORAGE);
  },
};

const headers = (): HeadersInit => {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const k = apiKey.get();
  if (k) h["X-API-Key"] = k;
  return h;
};

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;

  // The server answers a refusal with {"error": "..."} and that sentence is the useful part.
  // Falling back to the status line only when there is nothing better.
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body?.error) detail = body.error;
  } catch {
    /* not JSON; the status line stands */
  }
  throw new Error(detail);
}

export const api = {
  /** Everything the last sweep saw. */
  state: async (): Promise<SweepState> =>
    handle(await fetch(`${BASE}/state`, { headers: headers() })),

  /** Re-read both buckets now, rather than waiting for the interval. */
  sweep: async (): Promise<SweepState> =>
    handle(await fetch(`${BASE}/sweep`, { method: "POST", headers: headers() })),

  /** What the listener has announced recently. Read-only here - posting needs the ingest key,
   *  which is a machine's credential and never reaches this page. */
  notifications: async (): Promise<NotificationFeed> =>
    handle(await fetch(`${BASE}/notifications`, { headers: headers() })),

  plan: async (planId: string): Promise<PlanDetail> =>
    handle(await fetch(`${BASE}/plans/${encodeURIComponent(planId)}`, { headers: headers() })),

  /**
   * Run the risk analysis for a plan.
   *
   * POST because running it costs money and takes seconds, so it happens when somebody asks - never
   * as a side effect of opening a plan. The rules come back either way; the model half is present
   * only where the deployment enabled it.
   */
  analyse: async (planId: string): Promise<RiskAnalysisAnswer> =>
    handle(
      await fetch(`${BASE}/plans/${encodeURIComponent(planId)}/analysis`, {
        method: "POST",
        headers: headers(),
        body: "{}",
      }),
    ),

  decide: async (planId: string, payload: DecisionPayload): Promise<DecisionResult> =>
    handle(
      await fetch(`${BASE}/plans/${encodeURIComponent(planId)}/decision`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }),
    ),
};
