import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { ResourceEvent } from "../types";

const POLL_MS = 30000;

const actionBadge = (a: ResourceEvent["action"]) => {
  const cls = a === "DELETE" ? "badge badge-danger" : a === "REFRESH" ? "badge badge-warn" : "badge badge-ok";
  return <span className={cls}>{a}</span>;
};

const outcomeBadge = (o: ResourceEvent["outcome"]) => {
  const cls =
    o === "destroyed" ? "badge status-denied"
    : o === "rag_rejected" ? "badge status-failed"
    : "badge status-applied";
  const label = o === "rag_rejected" ? "RAG REJECTED" : o;
  return <span className={cls}>{label}</span>;
};

export function ResourcePage({ apiKey }: { apiKey: string }) {
  const [items, setItems] = useState<ResourceEvent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const rows = (await api.listResources()).filter((r) => r && r.event_id);
      setItems(rows);
      setError(null);
      if (!selectedId && rows.length > 0) setSelectedId(rows[0].event_id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!apiKey) return;
    const url = `/api/resources/stream?api_key=${encodeURIComponent(apiKey)}`;
    const es = new EventSource(url);
    es.addEventListener("snapshot", (e) => {
      try {
        const rows = (JSON.parse((e as MessageEvent).data) as ResourceEvent[]).filter(
          (r) => r && r.event_id,
        );
        setItems(rows);
      } catch { /* ignore */ }
    });
    es.addEventListener("change", () => { refresh(); });
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => { es.close(); setLive(false); };
  }, [apiKey, refresh]);

  const selected = items.find((i) => i.event_id === selectedId) ?? null;

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>Resources <span className={`live-dot ${live ? "on" : "off"}`} /></h1>
          <button className="refresh" onClick={refresh}>새로고침</button>
        </header>
        {error && <div className="error">{error}</div>}
        {items.length === 0 ? (
          <div className="empty">반영된 리소스가 없습니다.</div>
        ) : (
          <ul className="approval-list">
            {items.map((it) => (
              <li
                key={it.event_id}
                className={it.event_id === selectedId ? "selected" : ""}
                onClick={() => setSelectedId(it.event_id)}
              >
                <div className="row">{actionBadge(it.action)}{outcomeBadge(it.outcome)}</div>
                <div className="role-name">{it.role_name}</div>
                <div className="meta">
                  <span>account: {it.account_id}</span>
                  <span>by: {it.requester_iic_user ?? "—"}</span>
                </div>
                <div className="meta small">{new Date(it.applied_at).toLocaleString()}</div>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <main>
        {selected ? (
          <div className="detail">
            <header>
              <h2>{selected.role_name}</h2>
              <div className="meta">
                <span>event_id: <code>{selected.event_id}</code></span>
                <span>account: {selected.account_id}</span>
                <span>action: {selected.action}</span>
                <span>outcome: {selected.outcome}</span>
              </div>
              <div className="meta">
                <span>requester: {selected.requester_iic_user ?? "—"}</span>
                <span>reviewer: {selected.reviewer ?? "—"}</span>
                <span>applied_at: {new Date(selected.applied_at).toLocaleString()}</span>
              </div>
            </header>
            {selected.outcome === "rag_rejected" && (
              <section>
                <h3>RAG 거부 사유</h3>
                <div className="report">{selected.reason ?? "(no reason recorded)"}</div>
              </section>
            )}
            <section>
              <h3>대상 계정</h3>
              <div className="meta">
                {selected.target_accounts.length === 0 ? "—" : selected.target_accounts.join(", ")}
              </div>
            </section>
            <section>
              <h3>{selected.outcome === "rag_rejected" ? "RAG 거부된 정책" : "정책 ARN"} ({selected.policy_arns.length})</h3>
              {selected.policy_arns.length === 0 ? (
                <div className="empty small">정책 없음.</div>
              ) : (
                <ul className="arn-list">
                  {selected.policy_arns.map((arn) => (
                    <li key={arn}><code>{arn}</code></li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : (
          <div className="empty">왼쪽 목록에서 리소스를 선택하세요.</div>
        )}
      </main>
    </div>
  );
}
