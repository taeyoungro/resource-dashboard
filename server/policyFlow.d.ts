// Types for policyFlow.js - shared with src the same way findingPath.d.ts is.

import type { Finding, Grade } from "../src/types";

export const PLATE_W: number;
export const PLATE_H: number;
export const PLATE_GAP: number;
export const PLATE_VGAP: number;
export const FLOW_GAP: number;
export const GRADE_BAR: number;
export const FLOW_FOOT: string;

/** 시작을 말하는 판이거나, 흐름의 한 단계이거나. */
export type FlowPlateKind = "policy" | "step";

export interface FlowPlate {
  /** React key. 한 정책에 흐름이 둘이면 같은 규칙이 두 판일 수 있으므로 규칙 아이디로는 부족하다. */
  key: string;
  kind: FlowPlateKind;
  /** 'policy' 판에서는 null. 그 밖에는 이 판이 여는 카드의 규칙 아이디. */
  ruleId: string | null;
  label: string;
  /** 없으면 "". 동작 이름도 자원의 수도 들어가지 않는다. */
  sub: string;
  /** 'policy' 판에서는 null. 판 왼쪽 띠의 색을 정하고, 카드 왼쪽 테두리와 같은 것을 말한다. */
  grade: Grade | null;
  /** 이 규칙이 답한 축. 하나일 수도 둘일 수도 있고, 판을 누르면 그 전부가 열린다. */
  axes?: Finding["axis"][];
  x: number; y: number; w: number; h: number;
  labelY: number; subY: number;
  /** 선이 닿는 높이. 판의 세로 중점이다. */
  midY: number;
  title: string;
}

/** 판과 판을 잇는 꺾은선. 높이가 같으면 두 점, 다르면 네 점. */
export interface FlowLine {
  key: string;
  points: Array<[number, number]>;
}

/** 차례가 확립되지 않은 채 같은 정책에서 발화한 규칙. 판이 아니라 칩이다. */
export interface FlowChip {
  ruleId: string;
  /** 규칙의 제목. 단계가 아니므로 stepLabel 이 없고, 칩은 폭 예산이 없다. */
  label: string;
  grade: Grade;
  axes: Finding["axis"][];
  title: string;
}

export interface PolicyFlow {
  policyId: string;
  policyName: string;
  width: number; height: number;
  footY: number;
  foot: string;
  /** 이 정책의 흐름 개수. 둘 이상이면 판이 위아래로 쌓인다. */
  flows: number;
  /** 그림 폭에 담지 못한 단계. 세어서 말하고 그리지 않는다. */
  omittedSteps: number;
  plates: FlowPlate[];
  lines: FlowLine[];
  chips: FlowChip[];
  /** <desc>. 순수 함수의 반환값이므로 단위 시험이 고정한다. */
  summary: string;
}

/** 등급의 한국어 낱말. 화면에 한 벌뿐이어야 하므로 GRADE_LABEL 을 그대로 넘긴다. */
export type FlowWords = Partial<Record<Grade, string>>;

/** 한 정책의 판정 전부에서. 그릴 흐름이 없으면 null. */
export declare function policyFlow(findings: Finding[], words?: FlowWords): PolicyFlow | null;

/** 판정 전부에서, 정책마다 하나씩. 흐름이 없는 정책은 나오지 않는다. */
export declare function policyFlows(findings: Finding[], words?: FlowWords): PolicyFlow[];
