import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { ApprovalDetail as Detail, ApprovalSummary } from "./types";
import { ApprovalList } from "./components/ApprovalList";
import { ApprovalDetail } from "./components/ApprovalDetail";

const POLL_MS = 5000;

export default function App() {
  const [items, setItems] = useState<ApprovalSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState<string>(
    () => window.localStorage.getItem("pipeline_api_key") ?? "",
  );

  const refreshList = useCallback(async () => {
    try {
      const rows = await api.listApprovals();
      setItems(rows);
      setError(null);
      if (!selectedId && rows.length > 0) setSelectedId(rows[0].request_id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedId]);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const d = await api.getApproval(id);
      setDetail(d);
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

  const saveKey = () => {
    api.setApiKey(apiKey);
    refreshList();
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>IAM Approvals</h1>
          <div className="api-key">
            <input
              type="password"
              placeholder="X-API-Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button onClick={saveKey}>저장</button>
          </div>
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
