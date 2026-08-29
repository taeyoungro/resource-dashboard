import { useEffect, useState } from "react";
import { api } from "../api";
import type {
  BucketList, BucketPolicyOutcome, BucketPolicyReading, BucketReview, OpenStatement,
} from "../types";

// 자원 기반 정책을 읽는 화면. 읽기만 한다.
//
// 이 화면이 대답하는 질문은 하나다: 고른 버킷의 정책이 우리가 발급한 주체 — 미러 역할과 권한
// 세트 — 중 누구에 대해 무엇을 말하는가. 대시보드는 s3:ListAllMyBuckets 과 s3:GetBucketPolicy 만
// 갖고, 자원 정책을 쓰는 권한은 갖지 않는다. 쓸 수 있는 호스트는 버킷을 열 수 있고 그것은 승인
// 화면이 짊어질 폭발 반경이 아니다.
//
// 화면이 지켜야 하는 두 가지
// -------------------------
//   침묵을 결론으로 읽지 않는다  버킷과 같은 계정에 있는 주체는 자기 정책만으로 닿는다. 자원
//                              정책이 그를 말하지 않는 것은 아무 뜻도 아니다. 계정이 다르면
//                              양쪽이 다 허용해야 하므로 그때의 침묵은 답이다. 두 문장은 다르고
//                              화면도 다르게 적는다.
//   못 읽은 조건을 숨기지 않는다  출처 주소, VPC 엔드포인트, 전송 암호화, 객체 접두사는 주체만
//                              보고 판정할 수 없다. 그런 조건이 붙은 허용은 허용이 아니라 조건부
//                              이고, 읽지 못한 키를 이름으로 적는다.

const OUTCOME_LABEL: Record<BucketPolicyOutcome, { label: string; className: string; why: string }> = {
  DENIED: {
    label: "명시적 거부",
    className: "badge badge-ok",
    why: "이 정책이 이 주체를 명시적으로 거부합니다. 자원 정책의 거부는 어느 계정의 어떤 허용보다도 "
      + "앞서므로, 이것은 조건 없이 확정된 답입니다.",
  },
  ALLOWED: {
    label: "이 정책이 허용함",
    className: "badge badge-danger",
    why: "이 정책이 이 주체를 지목해 허용하며, 조건은 전부 판정되었습니다. 접근이 성립한다는 뜻은 "
      + "아닙니다 — 계정이 다르면 이것은 필요조건일 뿐이고 그 주체의 자기 정책도 허용해야 하며, "
      + "같은 계정이면 자기 정책만으로도 이미 닿을 수 있었습니다. 이 화면은 자기 정책을 읽지 "
      + "않습니다.",
  },
  UNREADABLE: {
    label: "판정하지 않음",
    className: "badge badge-warn",
    why: "이 정책에 이 화면이 해석하지 않는 문장이 있습니다. 그런 문장은 어느 주체에게나 걸릴 수 "
      + "있으므로, 이 주체에 대해서도 아무것도 결론짓지 않습니다.",
  },
  CONDITIONAL: {
    label: "조건부 허용",
    className: "badge badge-warn",
    why: "허용이 이 주체를 지목하지만, 조건 중에 주체만 보고는 판정할 수 없는 것이 있습니다. "
      + "허용이라고도 아니라고도 말하지 않습니다 — 아래에 읽지 못한 키를 적었습니다.",
  },
  DELEGATED: {
    label: "계정에 위임됨",
    className: "badge badge-warn",
    why: "정책이 이 주체가 아니라 그 계정을 지목합니다. 버킷은 동의했고, 실제로 누가 닿는지는 그 "
      + "계정의 자기 정책이 정합니다. 이 산출물은 그것을 읽지 않습니다.",
  },
  SILENT: {
    label: "언급 없음",
    className: "badge",
    why: "이 정책은 이 주체를 말하지 않습니다. 뜻은 계정에 달렸습니다 — 아래 표시를 보십시오.",
  },
};

/** 침묵의 뜻. 계정 관계를 모르면 판정하지 않는다. */
function silenceMeans(reading: BucketPolicyReading): string | null {
  if (reading.outcome !== "SILENT") return null;
  if (reading.sameAccount === null) {
    return "이 버킷이 어느 계정인지 이 배포는 듣지 못했으므로, 언급이 없다는 것의 뜻을 판정하지 "
      + "않습니다. OPT_ACCOUNT_ID 를 설정하면 판정합니다.";
  }
  if (reading.sameAccount) {
    return "버킷과 같은 계정입니다 — 자원 정책이 그를 말하지 않아도 이 주체의 자기 정책만으로 닿을 "
      + "수 있습니다. 이 화면은 자기 정책을 읽지 않으므로 여기서는 아무것도 결론짓지 않습니다.";
  }
  return "버킷과 다른 계정입니다 — 계정을 넘는 접근은 양쪽이 다 허용해야 하므로, 이 정책을 통해서는 "
    + "닿지 않습니다. 객체 ACL 과 액세스 포인트는 이 화면이 읽지 않는 다른 문입니다.";
}

function Reading({ reading }: { reading: BucketPolicyReading }) {
  const badge = OUTCOME_LABEL[reading.outcome];
  const silence = silenceMeans(reading);
  return (
    <div className="finding rbp-reading">
      <div className="finding-row">
        <span className={badge.className} title={badge.why}>{badge.label}</span>
        <code className="res-name">{reading.principal.label}</code>
        <span className="muted">
          {reading.principal.kind === "permission_set" ? "권한 세트" : "미러 역할"}
          {" · 계정 "}{reading.principal.accountId}
        </span>
      </div>

      <div className="finding-row">
        <span className="finding-label">정책이 지목해야 하는 이름</span>
        <span>
          <code>{reading.principal.arn}</code>
          {reading.principal.arnIsPattern && (
            <span className="muted" title={
              "권한 세트가 멤버 계정에서 실체화되는 IAM 역할의 이름에는 AWS 가 정하는 접미사가 "
              + "붙습니다. 이 배포는 그 값을 읽지 않으므로 정확한 ARN 이 아니라 패턴을 압니다 — "
              + "이 카드는 '이 권한 세트의 역할'이라고 말할 수 있고 '이 역할'이라고는 말할 수 "
              + "없습니다."
            }>
              {" "}· 패턴입니다 (접미사 미상)
            </span>
          )}
        </span>
      </div>

      {reading.statements.length > 0 && (
        <div className="finding-row">
          <span className="finding-label">해당 문장</span>
          <span className="finding-actions">
            {reading.statements.map((s, i) => (
              <code key={`${s.sid ?? "no-sid"}:${i}`}
                    className={s.effect === "Deny" ? "deny" : undefined}
                    title={s.unreadable
                      ? `${s.unreadable} 을(를) 쓰는 문장이라 이 화면이 판정하지 않습니다`
                      : `${s.effect} · ${s.match ?? "?"} 로 일치`}>
                {s.sid ?? "(Sid 없음)"} · {s.effect === "Deny" ? "거부" : "허용"}
              </code>
            ))}
          </span>
        </div>
      )}

      {reading.unknownKeys.length > 0 && (
        <div className="finding-row">
          <span className="finding-label">읽지 못한 조건</span>
          <span className="finding-actions">
            {reading.unknownKeys.map((k) => <code key={k}>{k}</code>)}
          </span>
        </div>
      )}

      {reading.unreadable.length > 0 && (
        <p className="finding-narrative muted">
          {reading.unreadable.join(", ")} 을(를) 쓰는 문장이 있습니다. 그 형태는 이 화면이
          해석하지 않으므로, 직접 읽어야 합니다.
        </p>
      )}

      {silence && <p className="finding-narrative muted">{silence}</p>}
    </div>
  );
}

/** 우리 주체가 아닌 쪽으로 열린 허용. 다른 질문이라 따로 둔다. */
function Open({ statements }: { statements: OpenStatement[] }) {
  if (statements.length === 0) return null;
  return (
    <div className="finding-section">
      <h4>
        계정 밖으로 열린 허용 <span className="muted small">
          {statements.length}건 — 우리가 발급한 주체가 아닌 쪽을 지목하는 허용입니다. 위 목록과
          다른 질문이며, 이 버킷을 처음 보는 사람이 먼저 묻는 쪽입니다
        </span>
      </h4>
      {statements.map((s, i) => (
        <div className="finding" key={`${s.sid ?? "no-sid"}:${i}`}>
          <div className="finding-row">
            <span className={s.anyPrincipal && s.conditionKeys.length === 0
              ? "badge badge-danger" : "badge badge-warn"}>
              {s.anyPrincipal
                ? (s.conditionKeys.length === 0 ? "모든 주체 · 조건 없음" : "모든 주체 · 조건 있음")
                : "외부 지목"}
            </span>
            <code>{s.sid ?? "(Sid 없음)"}</code>
          </div>
          {s.accounts.length > 0 && (
            <div className="finding-row">
              <span className="finding-label">계정</span>
              <span className="finding-actions">
                {s.accounts.map((a) => <code key={a}>{a}</code>)}
              </span>
            </div>
          )}
          {s.arns.length > 0 && (
            <div className="finding-row">
              <span className="finding-label">주체</span>
              <span className="finding-actions">
                {s.arns.map((a) => <code key={a}>{a}</code>)}
              </span>
            </div>
          )}
          <div className="finding-row">
            <span className="finding-label">동작</span>
            <span className="finding-actions">
              {s.actions.map((a) => <code key={a}>{a}</code>)}
            </span>
          </div>
          {s.conditionKeys.length > 0 && (
            <div className="finding-row">
              <span className="finding-label">조건 키</span>
              <span className="finding-actions">
                {s.conditionKeys.map((k) => <code key={k}>{k}</code>)}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ResourcePolicyPage() {
  const [list, setList] = useState<BucketList | null>(null);
  const [bucket, setBucket] = useState<string>("");
  const [review, setReview] = useState<BucketReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPolicy, setShowPolicy] = useState(false);

  useEffect(() => {
    api.buckets().then(setList).catch((e) => setError(e.message));
  }, []);

  const read = async (name: string) => {
    setBusy(true);
    setReview(null);
    setError(null);
    try {
      setReview(await api.bucketReview(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page rbp">
      <p className="muted">
        버킷 하나의 자원 기반 정책을 읽어, 이 배포가 발급한 주체 중 누구에 대해 무엇을 말하는지
        판정합니다. <strong>읽기만 합니다</strong> — 이 대시보드는 자원 정책을 쓰는 권한을 갖지
        않으며, 정책 수정은 다른 곳에서 합니다.
      </p>

      {error && <div className="error">{error}</div>}

      {list && (
        <div className="finding-row">
          <span className="finding-label">버킷</span>
          <span>
            <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
              <option value="">— 고르십시오 ({list.buckets.length}개) —</option>
              {list.buckets.map((b) => (
                <option key={b.name} value={b.name}>{b.name}</option>
              ))}
            </select>
            <button type="button" disabled={!bucket || busy} onClick={() => read(bucket)}>
              {busy ? "읽는 중…" : "정책 읽기"}
            </button>
            {list.account_id
              ? <span className="muted"> · 계정 {list.account_id}</span>
              : <span className="muted" title="OPT_ACCOUNT_ID 가 설정되지 않았습니다">
                  {" "}· 계정 미상
                </span>}
          </span>
        </div>
      )}

      {review && (
        <>
          <div className="sweep-bar">
            <span>
              <code>{review.bucket}</code>
              {" — "}
              {review.error
                ? "정책을 읽지 못했습니다"
                : review.has_policy
                  ? `자원 정책 있음 · 대조한 주체 ${review.governed_count}개`
                  : "자원 정책 없음"}
            </span>
            {review.has_policy && !review.error && (
              <button type="button" onClick={() => setShowPolicy((v) => !v)}>
                {showPolicy ? "원문 접기" : "원문 보기"}
              </button>
            )}
          </div>

          {review.error && (
            <div className="error">
              {review.error} — 정책이 <strong>있는데</strong> 읽지 못한 것입니다. 정책이 없는 버킷과
              다른 사실이므로 아래에 아무것도 판정하지 않았습니다.
            </div>
          )}

          {!review.has_policy && (
            <p className="muted">
              이 버킷에는 자원 기반 정책이 없습니다. 계정을 넘는 접근은 이 정책으로 허용되지 않으며,
              같은 계정 주체의 접근은 각자의 자기 정책이 정합니다.
            </p>
          )}

          {showPolicy && review.policy != null && (
            <pre className="policy-json">{JSON.stringify(review.policy, null, 2)}</pre>
          )}

          <Open statements={review.open} />

          {review.principals.length > 0 && (
            <div className="finding-section">
              <h4>
                우리가 발급한 주체 <span className="muted small">
                  {review.principals.length}개 — 나쁜 쪽부터
                </span>
              </h4>
              {review.principals.map((r) => <Reading key={r.principal.id} reading={r} />)}
            </div>
          )}

          <div className="finding-section">
            <h4>이 판정이 읽지 않은 것</h4>
            <ul className="finding-list muted small">
              <li>
                <strong>자기 정책.</strong> 계정을 넘는 접근은 이 정책과 그 주체의 자기 정책이
                <em>둘 다</em> 허용해야 성립합니다. 위의 &ldquo;이 정책이 허용함&rdquo;은
                필요조건이지 접근이 아닙니다.
              </li>
              <li>
                <strong>퍼블릭 액세스 차단.</strong> 이 정책에 모든 주체를 지목하는 허용이 하나라도
                있고 <code>RestrictPublicBuckets</code> 가 켜져 있으면, S3 는 정책 <em>전체</em>를
                퍼블릭으로 보아 같은 정책 안의 다른 계정 위임까지 함께 무효로 만듭니다. 이 화면은
                차단 설정을 읽지 않으므로 그런 버킷에서는 위의 허용·위임이 실제보다 넓게 보입니다.
              </li>
              <li>
                <strong>다른 문들.</strong> 객체 ACL, 액세스 포인트 정책, VPC 엔드포인트 정책,
                조직의 서비스·자원 제어 정책, 그리고 암호화된 객체의 KMS 키 정책은 각각 별개의
                관문입니다. 여기의 어떤 문장도 &ldquo;들어오는 길은 이것뿐&rdquo;이라는 뜻으로 읽으면
                안 됩니다.
              </li>
              <li>
                <strong>자원 범위.</strong> <code>arn:aws:s3:::버킷</code> 과
                <code>arn:aws:s3:::버킷/*</code> 는 다른 자원이고, 접두사로 좁힌 문장도 있습니다.
                이 판정은 주체만 보며 어느 객체까지 닿는지는 말하지 않습니다.
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
