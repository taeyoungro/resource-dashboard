import type {
  BucketList, BucketReview, DecisionPayload, DecisionResult, NotificationFeed,
  PassroleRetryPayload, PassroleRevokePayload, PlanDetail, RiskAnalysisAnswer, SweepState,
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

  /** Every bucket in this account. 503 when the review is not turned on for this deployment. */
  buckets: async (): Promise<BucketList> =>
    handle(await fetch(`${BASE}/buckets`, { headers: headers() })),

  /** One bucket's policy, read against the principals this deployment issued. A read, never a write. */
  bucketReview: async (bucket: string): Promise<BucketReview> =>
    handle(await fetch(`${BASE}/buckets/${encodeURIComponent(bucket)}/review`,
                       { headers: headers() })),

  plan: async (planId: string): Promise<PlanDetail> =>
    handle(await fetch(`${BASE}/plans/${encodeURIComponent(planId)}`, { headers: headers() })),

  /**
   * Start the risk analysis for a plan, and get the half that is ready immediately.
   *
   * POST because running the model half costs money, so IT happens when somebody asks - never as a
   * side effect of opening a plan, and now never as a side effect of asking for the rules alone
   * either. It returns as soon as the RULES have fired: those are deterministic, free, and take
   * milliseconds regardless of `engine`. The model half is started on the server only when `engine`
   * is not `"rules"`, and collected by analysisRun below.
   *
   * It used to return only when the model had answered every batch, which on a real assessment is
   * minutes inside one request - long enough for whatever terminates TLS in front of the dashboard
   * to answer 504 while the server kept paying for an answer the browser would never see.
   *
   * `engine`:
   *   "rules"  정책 기반 분석. Rule findings only - the free, deterministic half. Never bills
   *            Bedrock. If an "ai" run already exists for this assessment it rides along in the
   *            answer regardless (work already paid for is not withheld), but this call does not
   *            start one.
   *   "ai"     AI 분석. Starts (or joins) the model run, same as omitting the field. Named
   *            explicitly rather than left as the default so a reader of a network trace can tell
   *            which button asked, and so the default staying permissive is not load-bearing.
   */
  analyse: async (
    planId: string,
    engine: "rules" | "ai" = "ai",
    /**
     * One attached policy, or null for the whole plan.
     *
     * Nothing in either half is computed across policies - every finding and every candidate
     * belongs to exactly one grant - so this is a filter rather than a different analysis. What it
     * saves is the model half: five attached policies is five policies' worth of candidates, and an
     * approver who only wants to know about AmazonEC2FullAccess should not pay for the other four.
     */
    policy: string | null = null,
  ): Promise<RiskAnalysisAnswer> =>
    handle(
      await fetch(`${BASE}/plans/${encodeURIComponent(planId)}/analysis`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(policy ? { engine, policy } : { engine }),
      }),
    ),

  /** How the model half is going, and the whole answer once it is done. Milliseconds per call.
   *
   * `policy` has to travel: two policies analysed separately are two runs under one plan, and a
   * poll without it would be handed whichever one happened to be there. */
  analysisRun: async (planId: string, policy: string | null = null): Promise<RiskAnalysisAnswer> =>
    handle(
      await fetch(
        `${BASE}/plans/${encodeURIComponent(planId)}/analysis`
          + (policy ? `?policy=${encodeURIComponent(policy)}` : ""),
        { headers: headers() },
      ),
    ),

  decide: async (planId: string, payload: DecisionPayload): Promise<DecisionResult> =>
    handle(
      await fetch(`${BASE}/plans/${encodeURIComponent(planId)}/decision`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }),
    ),

  // A separate route from decide, deliberately. It sends no digest and no restriction because it
  // decides nothing: the grant was decided when the plan was approved, and this asks for the work
  // orders of that decision to be written again for the people the writer did not reach.
  retryPassrole: async (
    planId: string, payload: PassroleRetryPayload,
  ): Promise<DecisionResult> =>
    handle(
      await fetch(`${BASE}/plans/${encodeURIComponent(planId)}/passrole-retry`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }),
    ),

  // Taking a grant back on its own. Its own route rather than a flag on decide, because it is not
  // a decision about the plan: it carries no digest, applies nothing, and stays available after the
  // plan has an outcome - which is exactly when it is needed.
  revokePassrole: async (
    planId: string, payload: PassroleRevokePayload,
  ): Promise<DecisionResult> =>
    handle(
      await fetch(`${BASE}/plans/${encodeURIComponent(planId)}/passrole-revoke`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }),
    ),
};
