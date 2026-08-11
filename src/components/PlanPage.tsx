import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type {
  ActionCatalogue, PlanDetail as Detail, Restriction, SweepState,
} from "../types";
import { PlanDetail } from "./PlanDetail";
import { PlanList } from "./PlanList";
import { Notifications } from "./Notifications";

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
  // Fetched once. It is read from a file at server startup and does not change while that process
  // runs, so there is nothing to poll for - and a failure is not worth surfacing as an error: the
  // picker falls back to a typed action, which is how the screen worked before the catalogue existed.
  const [catalogue, setCatalogue] = useState<ActionCatalogue | null>(null);

  const plans = state?.plans ?? [];
  const selected = plans.find((p) => p.plan_id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && plans.length > 0) setSelectedId(plans[0].plan_id);
    if (selectedId && !plans.some((p) => p.plan_id === selectedId)) {
      // The plan went away between sweeps. Better to fall back to the top of the list than to
      // keep showing a detail panel for something that is no longer there.
      setSelectedId(plans[0]?.plan_id ?? null);
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

  useEffect(() => {
    api.actions().then(setCatalogue).catch(() => setCatalogue(null));
  }, []);

  const decide = async (
    decision: "approve" | "deny",
    reviewer: string,
    comment: string,
    restrictions: Restriction[],
  ) => {
    if (!selectedId || !detail) return;
    setBusy(true);
    setDetailError(null);
    try {
      // The digest of the plan that is on screen right now, sent back so the server can refuse if
      // the stored plan is no longer it. The prefix holds one plan per governed resource and a new
      // inspection overwrites it, so the plan can change under a page that is sitting open.
      //
      // A restriction carries a second digest for the same reason: it names resources that came from
      // the assessment on screen, and a later inspection can have replaced that too.
      const result = await api.decide(selectedId, {
        decision,
        reviewer,
        comment,
        expected_changes_sha256: detail.changes_sha256 ?? "",
        ...(restrictions.length > 0
          ? {
              restrictions,
              expected_impact_sha256: detail.assessment_sha256 ?? "",
            }
          : {}),
      });
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
        {/* Below the plan list, not merged into it. The list is what the buckets say; this is
            what a machine announced a moment ago and the sweep has not confirmed yet. */}
        <Notifications />
      </aside>
      <main>
        {detailError && <div className="error">{detailError}</div>}
        {detail ? (
          <PlanDetail
            detail={detail}
            decided={selected?.state === "decided"}
            busy={busy}
            assessmentState={selected?.assessment ?? null}
            catalogue={catalogue}
            onDecide={decide}
          />
        ) : (
          <div className="empty">왼쪽 목록에서 계획을 선택하세요.</div>
        )}
      </main>
    </div>
  );
}
