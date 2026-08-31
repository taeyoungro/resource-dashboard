import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type {
  PlanDetail as Detail, Restriction, RiskAnalysisCitation, SweepState,
} from "../types";
import { PlanDetail } from "./PlanDetail";
import { PlanList } from "./PlanList";

interface Props {
  state: SweepState | null;
  error: string | null;
  onRefresh: () => void;
}

// Whether the left column is folded. A preference and not a secret, so localStorage rather than the
// sessionStorage the API key uses - somebody who folded the list yesterday meant it. Both calls are
// guarded: localStorage throws rather than answering null where storage is denied, and a page that
// cannot load because it could not read a preference would be a poor trade.
const FOLD_STORAGE = "opt_dashboard_sidebar_folded";

const foldPreference = {
  get: (): boolean => {
    try {
      return window.localStorage.getItem(FOLD_STORAGE) === "1";
    } catch {
      return false;
    }
  },
  set: (folded: boolean): void => {
    try {
      if (folded) window.localStorage.setItem(FOLD_STORAGE, "1");
      else window.localStorage.removeItem(FOLD_STORAGE);
    } catch {
      /* a preference that cannot be remembered is not worth an error on screen */
    }
  },
};

export function PlanPage({ state, error, onRefresh }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which question this panel is answering about the selected plan. Two views of one resource: what
  // it will reach, and who asked to be able to pass it. They are different decisions, and reading
  // one while meaning to make the other is the confusion this split exists to remove.
  const [view, setView] = useState<"assessment" | "passrole">("assessment");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folded, setFolded] = useState(foldPreference.get);

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

  const decide = async (
    decision: "approve" | "deny",
    reviewer: string,
    comment: string,
    restrictions: Restriction[],
    passroleGrantTo: string[],
    passroleRevokeFrom: string[],
    analysis: RiskAnalysisCitation | null,
  ) => {
    if (!selectedId || !detail) return;
    setBusy(true);
    setDetailError(null);
    try {
      // The digest of the plan that is on screen right now, sent back so the server can refuse if
      // the stored plan is no longer it. The prefix holds one plan per governed resource and a new
      // inspection overwrites it, so the plan can change under a page that is sitting open.
      //
      // The assessment digest travels the same way and for the same reason, and it is NOT tied to
      // the restriction. A restriction needs it because it names resources that came from the
      // assessment on screen, which a later inspection can have replaced - but the applier needs it
      // even without one, to read that assessment's passrole_grants and dispatch the PassRole
      // fence. Sent whenever the page has one; the server keeps it only if it still matches, and an
      // approval with no assessment at all proceeds without it.
      const result = await api.decide(selectedId, {
        decision,
        reviewer,
        comment,
        expected_changes_sha256: detail.changes_sha256 ?? "",
        ...(detail.assessment_sha256
          ? { expected_impact_sha256: detail.assessment_sha256 }
          : {}),
        ...(restrictions.length > 0 ? { restrictions } : {}),
        // Whose PassRole request the approver ticked. Absent unless somebody did.
        ...(passroleGrantTo.length > 0 ? { passrole_grant_to: passroleGrantTo } : {}),
        // And whose grant the approver took back. Absent unless somebody did - and an absence here
        // withdraws nothing, which is why it has to be sent rather than inferred from the list above.
        ...(passroleRevokeFrom.length > 0 ? { passrole_revoke_from: passroleRevokeFrom } : {}),
        // The analysis the reviewer had on screen, cited by digest. Sent only when a model answered
        // and the digest it answered about is the one this decision carries - the server refuses a
        // citation naming any other assessment, which is what makes the record answerable rather
        // than merely decorated.
        ...(analysis && analysis.impact_sha256 === detail.assessment_sha256
          ? { risk_analysis: analysis }
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

  /**
   * Send the work orders again, for the people the inline writer did not reach.
   *
   * Not a decision, and it carries none of a decision's values: no plan digest, no assessment
   * digest, no restriction. Everything the grant says was settled when the plan was approved, and
   * the server re-reads the bucket to establish that these are names the writer actually failed on.
   */
  const retryPassrole = async (users: string[], reviewer: string) => {
    if (!selectedId) return;
    setBusy(true);
    setDetailError(null);
    try {
      const result = await api.retryPassrole(selectedId, { users, reviewer });
      window.alert(`다시 보냈습니다.\n${result.written}`);
      onRefresh();
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Take a grant back, with no decision on the plan behind it.
   *
   * Deliberately not routed through decide(). It carries no digest and no restriction because it is
   * not a verdict on the plan - and it stays available after the plan has an outcome, which is
   * exactly when granting's own path has shut and a held grant would otherwise be permanent.
   */
  const revokePassrole = async (users: string[], reviewer: string) => {
    if (!selectedId) return;
    setBusy(true);
    setDetailError(null);
    try {
      const result = await api.revokePassrole(selectedId, { users, reviewer });
      window.alert(`회수했습니다.\n${result.written}`);
      onRefresh();
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fold = (next: boolean) => {
    setFolded(next);
    foldPreference.set(next);
  };
  const awaiting = state?.counts.awaiting_decision ?? 0;

  return (
    <div className={folded ? "app folded" : "app"}>
      <aside className={folded ? "sidebar folded" : "sidebar"}>
        {/* Folded, the column is a rail and the button IS the rail: one control, a target the width
            of the column, and it does not move when it is pressed. The rail says how many plans are
            awaiting a decision, because folding the list must not be a way to stop seeing that. */}
        <header>
          <div className="sidebar-head">
            <button
              className="fold"
              aria-expanded={!folded}
              title={
                folded
                  ? `목록 펼치기${awaiting > 0 ? ` — 결정 대기 ${awaiting}건` : ""}`
                  : "목록 접기"
              }
              onClick={() => fold(!folded)}
            >
              <span aria-hidden="true">{folded ? "›" : "‹"}</span>
              {folded && (
                <>
                  <span className="rail">계획</span>
                  {/* A badge and not part of the vertical label. Digits are rotated sideways in
                      vertical writing while Hangul stays upright, so a number in that run lands on
                      its side across the character above it. */}
                  {awaiting > 0 && <span className="badge badge-warn">{awaiting}</span>}
                </>
              )}
            </button>
            {!folded && <h1>계획</h1>}
          </div>
          {!folded && (
            <button className="refresh" onClick={onRefresh}>
              다시 읽기
            </button>
          )}
        </header>

        {/* Unmounted rather than hidden while folded. Everything in here comes from the server, so
            nothing is lost by taking it down, and Notifications polls on an interval - a poll nobody
            can see is a call worth not making. */}
        {!folded && (
          <>
            {error && <div className="error">{error}</div>}
            <PlanList
              items={plans}
              selectedId={selectedId}
              onSelect={(id) => { setSelectedId(id); setView("assessment"); }}
              onSelectPassrole={(id) => { setSelectedId(id); setView("passrole"); }}
            />
          </>
        )}
      </aside>
      <main>
        {/* The sidebar is where this normally goes, and folding must not be a way to stop seeing that
            the list could not be read - a stale list looks exactly like a quiet one. */}
        {folded && error && <div className="error">{error}</div>}
        {detailError && <div className="error">{detailError}</div>}
        {detail ? (
          <PlanDetail
            detail={detail}
            decided={selected?.state === "decided"}
            busy={busy}
            assessmentState={selected?.assessment ?? null}
            view={view}
            onView={setView}
            onDecide={decide}
            onRetryPassrole={retryPassrole}
            onRevokePassrole={revokePassrole}
          />
        ) : (
          <div className="empty">왼쪽 목록에서 계획을 선택하세요.</div>
        )}
      </main>
    </div>
  );
}
