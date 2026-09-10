// Types for policyFlow.js - shared with src the same way findingPath.d.ts is.

import type { ContainmentState, Finding, Grade } from "../src/types";

export const STEP_W: number;
export const STEP_H: number;
export const OUT_W: number;
export const PLATE_GAP: number;
export const PLATE_VGAP: number;
export const FLOW_GAP: number;
export const ARRIVAL_UNITS: number;
export const FLOW_FOOT: string;

/** 흐름의 한 단계이거나, 그 흐름이 도달하는 곳이거나. */
export type FlowPlateKind = "step" | "outcome";

export interface FlowPlate {
  /** React key. 한 정책에 흐름이 둘이면 같은 규칙이 두 판일 수 있으므로 규칙 아이디로는 부족하다. */
  key: string;
  kind: FlowPlateKind;
  /** 'outcome' 판에서는 null. 그 밖에는 이 판이 여는 카드의 규칙 아이디. */
  ruleId: string | null;
  /** ①②③. 같은 열의 둘은 차례가 없으므로 같은 번호를 나눠 갖는다. 도착 판에서는 "". */
  number: string;
  /** 단계의 이름, 또는 도착의 낱말. 요약과 덧말이 쓰는 온전한 한 줄. */
  label: string;
  /** 판에 실제로 그려지는 줄들. SVG 는 줄바꿈하지 않으므로 미리 나눠 둔다. 최대 두 줄. */
  story: string[];
  /** 단계는 "R-1 · 높음", 도착은 "도달". 없으면 "". */
  note: string;
  /** 'outcome' 판에서는 null. 판 왼쪽 띠의 색을 정하고, 카드 왼쪽 테두리와 같은 것을 말한다. */
  grade: Grade | null;
  /**
   * 지금 작성 중인 결정이 이 단계를 끊었는가. 낱말표에 containmentOf 가 없으면 null.
   *
   * 축이 둘인 규칙에서는 덜 막힌 쪽을 쓴다 - 한쪽이 열려 있으면 경로는 열려 있고, 더 막힌 쪽을
   * 적으면 그림이 실제보다 안전하다고 말한다.
   */
  contained: ContainmentState | null;
  /** 이 규칙이 답한 축. 판을 누르면 그 전부가 열린다. */
  axes?: Finding["axis"][];
  x: number; y: number; w: number; h: number;
  labelY: number;
  storyY: number[];
  noteY: number;
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
  contained: ContainmentState | null;
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
  /** 그려진 단계의 수. 도착 판은 세지 않는다. */
  steps: number;
  /** 아직 차단되지 않은 단계의 수. 낱말표에 containmentOf 가 없으면 null. */
  openSteps: number | null;
  /** 그림 폭에 담지 못한 단계. 세어서 말하고 그리지 않는다. */
  omittedSteps: number;
  plates: FlowPlate[];
  lines: FlowLine[];
  chips: FlowChip[];
  /** <desc>. 순수 함수의 반환값이므로 단위 시험이 고정한다. */
  summary: string;
}

/**
 * 화면의 낱말표와 결정 상태. 그림은 한국어를 스스로 들지 않는다.
 *
 * 등급의 표기가 화면에 한 벌뿐이어야 하고, 차단 여부는 지금 작성 중인 결정에 달린 것이라 순수
 * 함수가 알 수 없다. 도착의 한국어는 여기 없다 - chain 이 값과 함께 싣고 온다.
 */
export interface FlowWords {
  grade?: Partial<Record<Grade, string>>;
  containmentOf?: (finding: Finding) => ContainmentState;
}

/** 이야기 한 줄을 판 안에서 줄로 나눈다. 두 줄에 안 들어가는 것은 버린다. */
export declare function wrapStory(text: string, budget?: number, lines?: number): string[];

/** 한 정책의 판정 전부에서. 그릴 흐름이 없으면 null. */
export declare function policyFlow(findings: Finding[], words?: FlowWords): PolicyFlow | null;

/** 판정 전부에서, 정책마다 하나씩. 흐름이 없는 정책은 나오지 않는다. */
export declare function policyFlows(findings: Finding[], words?: FlowWords): PolicyFlow[];
