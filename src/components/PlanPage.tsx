import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { PlanDetail as Detail, SweepState } from "../types";
import { PlanDetail } from "./PlanDetail";
import { PlanList } from "./PlanList";

interface Props {
  state: SweepState | null;
  error: string | null;
  onRefresh: () => void;
}

export function PlanPage({ state, error, onRefresh }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const plans = state?.plans ?? [];
  const selected = plans.find((p) => p.request_id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && plans.length > 0) setSelectedId(plans[0].request_id);
    if (selectedId && !plans.some((p) => p.request_id === selectedId)) {
      // The plan went away between sweeps. Better to fall back to the top of the list than to
      // keep showing a detail panel for something that is no longer there.
      setSelectedId(plans[0]?.request_id ?? null);
      setDetail(null);
    }
  }, [plans, selectedId]);

  const load = useCallback(async (id: string) => {
    setDetailError(null);
    try {
      setDetail(await api.plan(id));
    } catch (e) {
      setDetail(null);
      setDetailError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (selectedId) load(selectedId);
  }, [selectedId, load]);

  const decide = async (decision: "approve" | "deny", reviewer: string, comment: string) => {
    if (!selectedId) return;
    setBusy(true);
    setDetailError(null);
    try {
      const result = await api.decide(selectedId, { decision, reviewer, comment });
      window.alert(`기록했습니다.\n${result.written}`);
      onRefresh();
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>계획</h1>
          <button className="refresh" onClick={onRefresh}>
            다시 읽기
          </button>
        </header>
        {error && <div className="error">{error}</div>}
        <PlanList items={plans} selectedId={selectedId} onSelect={setSelectedId} />
      </aside>
      <main>
        {detailError && <div className="error">{detailError}</div>}
        {detail ? (
          <PlanDetail
            detail={detail}
            decided={selected?.state === "decided"}
            busy={busy}
            onDecide={decide}
          />
        ) : (
          <div className="empty">왼쪽 목록에서 계획을 선택하세요.</div>
        )}
      </main>
    </div>
  );
}
