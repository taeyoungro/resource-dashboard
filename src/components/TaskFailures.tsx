import { useEffect, useState } from "react";
import type { TaskFailure } from "../types";
import { api } from "../api";
import { clock } from "../time";

/**
 * Containers that stopped badly, and the one thing to do about them.
 *
 * The markers page already shows that a task did not finish — that is what a marker outliving its
 * task means. What it cannot show is WHICH failure it was: a plan lock timeout and a task killed
 * before it ran a line leave the same object in the same bucket. stopCode, exitCode and
 * stoppedReason separate them, they live in the ECS task state change event, and until
 * opt-SolutionTaskFailureNotifier existed nothing carried them anywhere a person looks.
 *
 * Why the retry is a button and not a rule
 * ----------------------------------------
 * Re-putting the object automatically would run forever on a deterministic failure: the task fails,
 * the object is re-put, the rule fires, the task fails. The reason is on screen precisely so that a
 * person can decide whether running it again is the right answer — often something has to be fixed
 * first, and sometimes no number of attempts clears it.
 *
 * What the button actually does
 * -----------------------------
 * The server reads the object that started the task and writes back what it read. That write is what
 * fires the rule again. It is the only way to run a container again without ecs:RunTask, and that is
 * the whole reason it is acceptable on a page people log in to: RunTask carries container overrides,
 * so a role holding it runs anything as any role it may pass, while re-putting an object starts a
 * FIXED task definition with the overrides its own rule composes.
 */
export function TaskFailures() {
  const [failures, setFailures] = useState<TaskFailure[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    api.taskFailures()
      .then((feed) => {
        setFailures(feed.failures);
        setEnabled(feed.enabled);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  };

  useEffect(load, []);

  const retry = (entry: TaskFailure) => {
    const who = reviewer.trim();
    if (!who) {
      window.alert("다시 실행한 사람의 이름을 입력하세요. 기록에 그대로 남습니다.");
      return;
    }
    if (!window.confirm(
      `${entry.marker_key} 를 다시 넣어 이 작업을 한 번 더 실행합니다.\n\n`
      + "객체는 읽은 그대로 다시 쓰입니다 — 내용은 바뀌지 않고, 다시 쓰였다는 사실이 규칙을 "
      + "발화시킵니다. 같은 사유로 실패하는 상태라면 결과도 같습니다.",
    )) return;

    setBusy(entry.id);
    api.retryTask(entry.id, who)
      .then(() => { setError(null); load(); })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(null));
  };

  if (failures === null && !error) return null;
  if (!enabled) {
    return (
      <div className="warn-inline">
        <code>OPT_DASHBOARD_INGEST_KEY</code> 가 설정되지 않아 실패 보고를 받지 않습니다. 컨테이너가
        실패하면 마커만 남고 사유는 CloudWatch 에만 있습니다.
      </div>
    );
  }
  if (failures !== null && failures.length === 0) return null;

  return (
    <section className="task-failures">
      <h3>
        실패한 작업 <span className="muted small">{failures?.length ?? 0}건</span>
      </h3>
      <p className="muted small">
        컨테이너가 0 이 아닌 코드로 끝났거나 아예 시작하지 못했습니다. 마커는 그대로 남아 있고 —
        그것이 「이 작업은 끝나지 않았다」는 뜻입니다 — <strong>아무것도 자동으로 다시 돌리지
        않습니다.</strong> 사유를 보고 다시 실행할지 정하십시오.
      </p>

      {error && <div className="error">{error}</div>}

      <table className="policy-table">
        <thead>
          <tr>
            <th>컨테이너</th>
            <th>왜 멈췄나</th>
            <th>마지막</th>
            <th>다시 실행</th>
          </tr>
        </thead>
        <tbody>
          {(failures ?? []).map((entry) => (
            <tr key={entry.id}>
              <td>
                <code>{family(entry.task_definition_arn)}</code>
                {entry.attempts > 1 && (
                  <div className="meta small">{entry.attempts}회째</div>
                )}
              </td>
              <td>
                {/* The three fields a marker cannot say, in the order they answer the question. */}
                <div>{entry.stop_code ?? "—"}</div>
                {entry.exit_codes.length > 0 ? (
                  <div className="meta small">종료 코드 {entry.exit_codes.join(", ")}</div>
                ) : (
                  <div className="meta small">
                    종료 코드 없음 — 한 줄도 실행되지 않았습니다
                  </div>
                )}
                {entry.stopped_reason && (
                  <div className="muted small">{entry.stopped_reason}</div>
                )}
                {entry.marker_key && (
                  <div className="muted small"><code>{entry.marker_key}</code></div>
                )}
              </td>
              <td>{clock(entry.stopped_at ?? new Date(entry.last_seen).toISOString())}</td>
              <td>
                {!entry.retryable ? (
                  <span className="muted small">
                    다시 넣을 객체가 없습니다 — 손으로 시작한 작업입니다
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => retry(entry)}
                    >
                      {busy === entry.id ? "보내는 중" : "다시 실행"}
                    </button>
                    {entry.retried_at && (
                      <div className="meta small">
                        {entry.retried_by} 이(가) {clock(new Date(entry.retried_at).toISOString())} 에 실행함
                      </div>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="decision">
        <div className="row">
          <input
            placeholder="다시 실행한 사람 (기록에 그대로 남습니다)"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
          />
        </div>
      </div>
    </section>
  );
}

/** opt-inspector, out of the task definition ARN. The revision is noise on this screen. */
function family(arn: string | null): string {
  if (!arn) return "—";
  const name = arn.split("/").pop() ?? arn;
  return name.split(":")[0];
}
