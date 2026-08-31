import { useCallback, useEffect, useState } from "react";
import { api, apiKey } from "./api";
import { MarkerPage } from "./components/MarkerPage";
import { Notifications } from "./components/Notifications";
import { TaskFailures } from "./components/TaskFailures";
import { PlanPage } from "./components/PlanPage";
import { ResourcePolicyPage } from "./components/ResourcePolicyPage";
import type { SweepState } from "./types";
import { clock } from "./time";

// The marker list splits by the server's own classification: a marker younger than the grace
// period (OPT_MARKER_GRACE_SECONDS, default 15 minutes) is presumed running, an older one is
// presumed dead. One tab per answer, so "what is broken" and "what is merely busy" are different
// clicks rather than two badge colors in one table.
type Tab = "plans" | "failed" | "running" | "rbp";

// The server sweeps the buckets on startup and every 24 hours; this only asks it what it last
// saw. Cheap - no S3 call unless the refresh button is pressed - so it can be frequent enough
// that two people looking at the same screen see the same thing.
const POLL_MS = 15000;

export default function App() {
  const [tab, setTab] = useState<Tab>("plans");
  const [key, setKey] = useState<string>(() => apiKey.get());
  const [state, setState] = useState<SweepState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const sweepNow = useCallback(async () => {
    setSweeping(true);
    try {
      setState(await api.sweep());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSweeping(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load, key]);

  const saveKey = () => {
    apiKey.set(key);
    load();
  };

  const counts = state?.counts;

  return (
    <div className="shell">
      <nav className="topnav">
        <div className="brand">IAM Governance</div>
        <div className="tabs">
          <button
            className={tab === "plans" ? "tab active" : "tab"}
            onClick={() => setTab("plans")}
          >
            승인 {counts ? `(${counts.awaiting_decision})` : ""}
          </button>
          <button
            className={tab === "failed" ? "tab active" : "tab"}
            onClick={() => setTab("failed")}
          >
            실패 {counts ? `(${counts.failed})` : ""}
          </button>
          <button
            className={tab === "running" ? "tab active" : "tab"}
            onClick={() => setTab("running")}
          >
            진행 {counts ? `(${counts.running})` : ""}
          </button>
          {/* 승인 흐름 밖의 화면이라 개수를 달지 않는다. 세어서 보여 줄 대기열이 없고,
              숫자가 붙으면 처리해야 할 것이 있다는 뜻으로 읽힌다. */}
          <button
            className={tab === "rbp" ? "tab active" : "tab"}
            onClick={() => setTab("rbp")}
          >
            자원 정책
          </button>
        </div>
        {/* Left of the key field, and in the top bar rather than under the plan list. It used to
            sit below a list long enough to push it off screen, so an announcement arriving while
            somebody read a plan was seen at the next scroll or not at all - which spends the only
            thing this feed buys over the sweep. */}
        <Notifications />
        <div className="api-key topbar-key">
          <input
            type="password"
            placeholder="X-API-Key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveKey()}
          />
          <button onClick={saveKey}>저장</button>
        </div>
      </nav>

      {state ? (
        <div className="sweep-bar">
          <span>
            마지막 조회 {clock(state.swept_at)}
            {state.stale ? " — 실패했습니다. 아래는 그 이전 상태입니다." : ""}
          </span>
          {counts ? (
            <span className="muted">
              실패 {counts.failed} · 실행 중 {counts.running} · 결정 대기{" "}
              {counts.awaiting_decision}
            </span>
          ) : null}
          <button className="refresh" disabled={sweeping} onClick={sweepNow}>
            {sweeping ? "조회 중…" : "버킷 다시 조회"}
          </button>
        </div>
      ) : null}

      {/* A sweep that half worked and says nothing looks exactly like a system with nothing
          wrong. Whatever it could not read is shown. */}
      {state && state.errors.length > 0 ? (
        <div className="error">
          조회 중 읽지 못한 것이 {state.errors.length}건 있습니다. 아래 목록은 불완전합니다.
          <ul>
            {state.errors.slice(0, 10).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The "failed" tab only. This used to sit above every page, on the reasoning that a
          container failing is the one thing worth interrupting whatever you came here to do. In
          practice it read as a banner that would not go away, on three tabs where nothing about it
          was actionable. It belongs beside the markers it explains: a marker says a task did not
          finish, and this says WHICH failure it was.

          What that gives up, stated: the panel is now behind a click. A failure whose marker is
          still inside the grace period is counted as "running" by the tab labels, and one from a
          task nobody started from an object has no marker to be counted at all - so neither raises
          the failed count, and a person who never opens this tab does not learn about them. */}
      {tab === "failed" && <TaskFailures />}

      {tab === "plans" ? (
        <PlanPage state={state} error={error} onRefresh={sweepNow} />
      ) : tab === "rbp" ? (
        <ResourcePolicyPage />
      ) : (
        <MarkerPage state={state} error={error} onRefresh={sweepNow} filter={tab} />
      )}
    </div>
  );
}
