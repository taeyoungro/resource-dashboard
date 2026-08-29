import type { FindingStatus, Grade } from "./types";

// 등급과 상태의 표기. 두 화면이 같은 어휘를 쓰기 위해 여기 한 벌만 둔다.
//
// 위험 분석과 자원 정책 판정은 서로 다른 질문에 답하지만, 승인자에게는 같은 색과 같은 낱말이어야
// 한다 — 한 화면에서 "높음"이 다른 화면에서 "높음"과 다르게 보이면 그 순간 두 화면의 등급을 서로
// 비교할 수 없게 된다. 두 곳에 따로 적어 두면 언젠가 한쪽만 바뀐다.
//
// 등급이 무엇에 대한 것인지는 화면마다 다르고, 그것은 각 화면이 적는다. 위험 카드의 등급은 "이
// 권한으로 무엇을 할 수 있는가"이고, 자원 정책 카드의 등급은 "이 버킷 정책이 이 주체에 대해 무엇을
// 말하는가"이다. 같은 낱말을 쓰되 두 수를 더하지는 않는다.

export const GRADE_LABEL: Record<Grade, string> = {
  CRITICAL: "치명", HIGH: "높음", MEDIUM: "보통", LOW: "낮음", NONE: "없음",
};

export const GRADE_CLASS: Record<Grade, string> = {
  CRITICAL: "grade grade-critical",
  HIGH: "grade grade-high",
  MEDIUM: "grade grade-medium",
  LOW: "grade grade-low",
  NONE: "grade",
};

export const STATUS_LABEL: Record<FindingStatus, string> = {
  CONFIRMED: "확인",
  UNVERIFIED: "미확인",
  NOT_ASSESSABLE: "평가 불가",
};
