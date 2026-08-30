import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Notification } from "../types";
import { clock } from "../time";

/** What the listener has announced recently.
 *
 * Kept visibly separate from the plan list, and the wording says why: these are announcements, not
 * state. The plan list is what the buckets say and is authoritative; this is what a machine told us
 * a moment ago, and the next sweep is what confirms it. Mixing the two would make a fabricated
 * announcement look like a fact.
 *
 * It answers one thing the buckets cannot: what ran recently. A finished inspection deletes its
 * marker and leaves the plan prefix looking exactly as it would have if nothing had run.
 *
 * A bell in the top bar rather than a panel under the plan list
 * -------------------------------------------------------------
 * The list is long and this sat below it, so an announcement arriving while somebody read a plan
 * appeared off-screen and was seen at the next scroll or not at all. Latency is the only thing this
 * feed buys over the sweep, and a place nobody looks spends it.
 *
 * The count is UNREAD, not total: how many have arrived since the panel was last opened. Opening
 * clears it, which is what makes the number mean "look at this" rather than "there are things".
 */
const relative = (iso: string): string => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}시간 전`;
  return clock(iso);
};

function Row({ item }: { item: Notification }) {
  return (
    <li>
      <div className="row">
        <span className="badge">{item.kind}</span>
        <span className="role-name">{item.resource ?? item.request_id}</span>
      </div>
      <div className="meta small">
        <span>계정: {item.account_id ?? "—"}</span>
        <span>{relative(item.received_at)}</span>
        {item.event_count > 0 ? <span>이벤트 {item.event_count}건</span> : null}
        {/* max_wait means the buffer hit its hard ceiling rather than going quiet - the shape
            that risks the queue redelivering, so it is worth seeing without opening a log. */}
        {item.buffer_reason === "max_wait" ? (
          <span className="badge badge-warn">하드 마감</span>
        ) : null}
        {item.repeats > 0 ? (
          <span className="badge badge-warn">재전달 {item.repeats}회</span>
        ) : null}
        {/* The listener leaves an over-large marker out rather than trimming it. Nothing is lost -
            the object is in the bucket and the sweep fetches it - but it is worth seeing. */}
        {item.body_omitted ? <span className="badge">본문 미포함</span> : null}
      </div>
      {item.event_names.length > 0 ? (
        <div className="meta small">{item.event_names.join(", ")}</div>
      ) : null}
    </li>
  );
}

export function Notifications({ intervalSeconds = 15 }: { intervalSeconds?: number }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // The ids that were on screen the last time the panel was open. Unread is what is NOT in here,
  // so an announcement that arrives while the panel is open is counted the moment it closes rather
  // than being silently marked read - the reader saw the panel, not necessarily that row.
  //
  // A ref and not state: it changes on every poll while the panel is open and nothing renders from
  // it directly, so putting it in state would re-render the tree once a second for no visible
  // difference.
  const seen = useRef<Set<string>>(new Set());
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      const feed = await api.notifications();
      setItems(feed.notifications);
      setEnabled(feed.enabled);
      setError(null);
      setUnread(feed.notifications.filter((n) => !seen.current.has(n.id)).length);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, intervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [load, intervalSeconds]);

  // Marked read on OPEN rather than on close, so the number goes away when the panel appears -
  // which is the moment a person would otherwise wonder whether the click registered.
  const toggle = () => {
    setOpen((wasOpen) => {
      if (!wasOpen) {
        items.forEach((item) => seen.current.add(item.id));
        setUnread(0);
      }
      return !wasOpen;
    });
  };

  // An error the panel is closed over would otherwise be invisible: the feed stops updating and
  // nothing says so. The bell carries it, which is the only thing on screen at that point.
  const broken = Boolean(error) || !enabled;

  return (
    <div className="bell">
      <button
        className={open ? "bell-button open" : "bell-button"}
        onClick={toggle}
        aria-expanded={open}
        title={broken ? "알림을 받지 못하고 있습니다" : "최근 알림"}
      >
        <span aria-hidden="true">🔔</span>
        <span className="sr-only">최근 알림</span>
        {unread > 0 ? <span className="bell-count">{unread}</span> : null}
        {unread === 0 && broken ? <span className="bell-count warn">!</span> : null}
      </button>

      {open ? (
        <section className="notifications bell-panel">
          <header>
            <h2>최근 알림</h2>
          </header>
          {error ? <div className="error">{error}</div> : null}
          {!enabled ? (
            <div className="row-warn">
              서버에 <code>OPT_DASHBOARD_INGEST_KEY</code>가 없어 리스너가 알림을 보낼 수 없습니다.
              목록과 계획은 그대로 동작합니다 — 알림은 버킷 훑기를 앞당길 뿐이고 대신하지 않습니다.
            </div>
          ) : null}
          {items.length === 0 ? (
            <div className="empty">최근 알림이 없습니다.</div>
          ) : (
            <ul className="approval-list">
              {items.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </ul>
          )}
          <div className="meta small">
            알림은 <strong>통보이지 상태가 아닙니다.</strong> 무엇이 존재하는지는 버킷 훑기가
            정하고, 이 목록은 서버가 다시 시작하면 비워집니다.
          </div>
        </section>
      ) : null}
    </div>
  );
}
