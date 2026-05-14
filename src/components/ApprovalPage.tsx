import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ApprovalDetail as Detail, ApprovalSummary } from "../types";
import { ApprovalList } from "./ApprovalList";
import { ApprovalDetail } from "./ApprovalDetail";

const POLL_MS = 30000;

export function ApprovalPage({ apiKey }: { apiKey: string }) {
  const [items, setItems] = useState<ApprovalSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);

  const refreshList = useCallback(async () => {
    try {
      const rows = (await api.listApprovals()).filter(
        (r) => r && r.request_id && r.role_name,
      );
      setItems(rows);
      setError(null);
      if (!selectedId && rows.length > 0) setSelectedId(rows[0].request_id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedId]);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api.getApproval(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refreshList();
    const t = setInterval(refreshList, POLL_MS);
    return () => clearInterval(t);
  }, [refreshList]);

  useEffect(() => {
    if (selectedId) refreshDetail(selectedId);
  }, [selectedId, refreshDetail]);

  useEffect(() => {
    if (!apiKey) return;
    const url = `/api/approvals/stream?api_key=${encodeURIComponent(apiKey)}`;
    const es = new EventSource(url);
    es.addEventListener("snapshot", (e) => {
      try {
        const rows = (JSON.parse((e as MessageEvent).data) as ApprovalSummary[]).filter(
          (r) => r && r.request_id && r.role_name,
        );
        setItems(rows);
      } catch { /* ignore */ }
    });
    es.addEventListener("change", (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as { request_id: string };
        refreshList();
        if (selectedId && ev.request_id === selectedId) refreshDetail(selectedId);
      } catch { /* ignore */ }
    });
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => { es.close(); setLive(false); };
  }, [apiKey, refreshList, refreshDetail, selectedId]);

  const handleDecide = async (decision: "approve" | "deny", reviewer: string, comment: string) => {
    if (!selectedId) return;
    if (!window.confirm(`${decision === "approve" ? "승인" : "거부"} 하시겠습니까?`)) return;
    setBusy(true);
    try {
      const updated = await api.decide(selectedId, { decision, reviewer, comment });
      setDetail(updated);
      await refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>Approvals <span className={`live-dot ${live ? "on" : "off"}`} /></h1>
          <button className="refresh" onClick={refreshList}>새로고침</button>
        </header>
        {error && <div className="error">{error}</div>}
        <ApprovalList items={items} selectedId={selectedId} onSelect={setSelectedId} />
      </aside>
      <main>
        {detail ? (
          <ApprovalDetail detail={detail} onDecide={handleDecide} busy={busy} />
        ) : (
          <div className="empty">왼쪽 목록에서 요청을 선택하세요.</div>
        )}
      </main>
    </div>
  );
}
