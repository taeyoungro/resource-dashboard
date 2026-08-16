import type { Marker, SweepState } from "../types";

interface Props {
  state: SweepState | null;
  error: string | null;
  onRefresh: () => void;
  /**
   * Which half of the marker list this page shows. The server classifies every marker by age
   * against the grace period (OPT_MARKER_GRACE_SECONDS, default 15 minutes): younger is presumed
   * running, older is presumed dead. The two used to share one table with a badge column; they are
   * separate tabs now because "what is broken" and "what is merely busy" are different questions,
   * asked in different moods.
   */
  filter: "failed" | "running";
}

const age = (seconds: number | null): string => {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}분`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}시간`;
  return `${Math.round(seconds / 86400)}일`;
};

const COPY = {
  failed: {
    title: "실패한 작업",
    empty: "실패로 남아 있는 마커가 없습니다.",
    explain: (
      <>
        마커는 <strong>그 작업이 완료되지 않았음</strong>을 뜻합니다. 정상 종료하는 모든 경로가
        마커를 지우므로, 유예 시간을 넘겨서도 남아 있다는 것은 그 작업이 죽었다는 뜻입니다.
        이미지를 받지 못한 경우·경로 없는 서브넷·메모리 부족·시작 전 중지는 로그도 종료 코드도
        남기지 못하고 <strong>마커만 남깁니다.</strong> 그래서 이 목록이 그런 실패를 보는 유일한
        수단입니다.
      </>
    ),
  },
  running: {
    title: "진행 중인 작업",
    empty: "진행 중인 작업이 없습니다.",
    explain: (
      <>
        유예 시간 안의 마커입니다 — 작업이 아직 돌고 있는 것으로 추정합니다. 정상적으로 끝나면
        마커가 지워져 이 목록에서 사라지고, 유예 시간을 넘기면 <strong>실패</strong> 탭으로
        넘어갑니다. 여기 오래 머무는 항목이 보이면 끝나가는 것이 아니라 죽어가는 것입니다.
      </>
    ),
  },
} as const;

export function MarkerPage({ state, error, onRefresh, filter }: Props) {
  const markers = (state?.markers ?? []).filter((m: Marker) => m.state === filter);
  const copy = COPY[filter];

  return (
    <div className="app single">
      <main>
        <header className="page-head">
          <h1>{copy.title}</h1>
          <button className="refresh" onClick={onRefresh}>
            다시 읽기
          </button>
        </header>

        {error && <div className="error">{error}</div>}

        <p className="muted">{copy.explain}</p>

        {markers.length === 0 ? (
          <div className="empty">{copy.empty}</div>
        ) : (
          <table className="policy-table">
            <thead>
              <tr>
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
