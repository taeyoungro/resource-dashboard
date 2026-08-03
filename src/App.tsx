import { useCallback, useEffect, useState } from "react";
import { api, apiKey } from "./api";
import { MarkerPage } from "./components/MarkerPage";
import { PlanPage } from "./components/PlanPage";
import type { SweepState } from "./types";

type Tab = "plans" | "markers";

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
            className={tab === "markers" ? "tab active" : "tab"}
            onClick={() => setTab("markers")}
          >
            실패 {counts ? `(${counts.failed})` : ""}
          </button>
        </div>
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
            마지막 조회 {new Date(state.swept_at).toLocaleString()}
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

      {tab === "plans" ? (
        <>
          {/* Stated on the page rather than only in a document, because the person deciding is
              the one who would otherwise be misled by it. */}
          <div className="row-warn">
            적용이 끝난 계획도 여기 남습니다. 적용기가 끝나면서 자기 마커를 지우고 그 자리에
            아무것도 쓰지 않기 때문에,{" "}
            <strong>아직 아무도 보지 않은 계획과 이미 적용된 계획을 구별할 수 없습니다.</strong>{" "}
            이미 적용된 계획을 다시 승인해도 저장된 계획 파일이 낡았으므로 적용 단계에서
            실패합니다.
          </div>
          <PlanPage state={state} error={error} onRefresh={sweepNow} />
        </>
      ) : (
        <MarkerPage state={state} error={error} onRefresh={sweepNow} />
      )}
    </div>
  );
}
