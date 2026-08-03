import type { Marker, SweepState } from "../types";

interface Props {
  state: SweepState | null;
  error: string | null;
  onRefresh: () => void;
}

const age = (seconds: number | null): string => {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}분`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}시간`;
  return `${Math.round(seconds / 86400)}일`;
};

const stateBadge = (m: Marker) =>
  m.state === "failed" ? (
    <span className="badge badge-danger">실패</span>
  ) : (
    <span className="badge badge-warn">실행 중</span>
  );

export function MarkerPage({ state, error, onRefresh }: Props) {
  const markers = state?.markers ?? [];

  return (
    <div className="app single">
      <main>
        <header className="page-head">
          <h1>남아 있는 마커</h1>
          <button className="refresh" onClick={onRefresh}>
            다시 읽기
          </button>
        </header>

        {error && <div className="error">{error}</div>}

        <p className="muted">
          마커는 <strong>그 작업이 완료되지 않았음</strong>을 뜻합니다. 정상 종료하는 모든 경로가
          마커를 지우므로, 남아 있다는 것은 실행 중이거나 죽었다는 것입니다. 이미지를 받지 못한
          경우·경로 없는 서브넷·메모리 부족·시작 전 중지는 로그도 종료 코드도 남기지 못하고
          <strong> 마커만 남깁니다.</strong> 그래서 이 목록이 그런 실패를 보는 유일한 수단입니다.
        </p>

        {markers.length === 0 ? (
          <div className="empty">남아 있는 마커가 없습니다.</div>
        ) : (
          <table className="policy-table">
            <thead>
              <tr>
                <th>상태</th>
                <th>컨테이너</th>
                <th>자원</th>
                <th>계정</th>
                <th>경과</th>
                <th>키</th>
              </tr>
            </thead>
            <tbody>
              {markers.map((m) => (
                <tr key={m.key}>
                  <td>{stateBadge(m)}</td>
                  <td>{m.kind}</td>
                  <td>
                    {m.resource ?? <span className="muted">본문을 읽지 못함</span>}
                    {m.request_kind ? <span className="meta small"> {m.request_kind}</span> : null}
                    {m.decision ? (
                      <span className="meta small">
                        {" "}
                        {m.decision} · {m.reviewer ?? "검토자 없음"}
                      </span>
                    ) : null}
                  </td>
                  <td>{m.account_id ?? "—"}</td>
                  <td>{age(m.age_seconds)}</td>
                  <td className="muted small">{m.key}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
