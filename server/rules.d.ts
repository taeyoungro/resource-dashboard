// Types for rules.js - the loaded judgement rules, shared with src the same way topology.d.ts is.
//
// Only what src actually reads. The rule objects themselves are read by the engine and never by a
// component, so they are not described here: a component that started reading a predicate would be
// re-implementing findings.js in the browser, and this file not helping is the point.

export declare class RuleError extends Error {}

/** 도착의 한국어 표기. 흐름 그림이 끝 판에 적는 낱말이고, 화면에 한 벌뿐이다. */
export declare const OUTCOME_LABEL: Record<string, string>;

/** 규칙 파일의 sha256. 카드가 「어느 판본이 이것을 냈는가」에 답하기 위해 쓴다. */
export declare const RULES_SHA256: string;

/** 구역의 차례. 카드 목록이 이 순서로 묶는다. */
export declare const SECTION_ORDER: string[];
