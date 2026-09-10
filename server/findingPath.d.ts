// Types for findingPath.js - shared with src the same way blockPath.d.ts is.

import type { Finding } from "../src/types";

export const LINK_W: number;
export const LINK_H: number;
export const GAP: number;
export const ROW_GAP: number;
export const PATH_W: number;
export const PATH_H: number;
export const LINE_Y: number;
export const FOOT_Y: number;
export const PATH_FOOT: string;
export const CHAIN_FOOT: string;

/** 확립 · 미확인(근거가 확정하지 못함) · 주장 없음(이 판정이 그 주장을 하지 않음). */
export type PathLinkState = "established" | "unverified" | "unclaimed";

/**
 * 그림의 판 하나.
 *
 * `id` 는 언제나 첫 판이 "grant" 이고 끝 판이 "target" 이다. 가운데는 흐름이 없으면 "action"
 * 하나이고, 있으면 규칙 아이디마다 하나다 - 그래서 여기가 열린 문자열이다.
 */
export interface PathLink {
  id: string;
  label: string;
  /** 없으면 "". 동작 이름은 절대 들어가지 않는다. */
  sub: string;
  state: PathLinkState;
  /** 마우스로 짚었을 때의 덧말. 여기에만 있는 사실은 하나도 없다. */
  title: string;
  /** 끊긴 자리의 하류. 지우지 않고 낮춘다. */
  dim: boolean;
  x: number; y: number; w: number; h: number;
  labelY: number; subY: number;
  /** 선이 닿는 높이. 판의 세로 중점이고, 등뼈와 다를 수 있다. */
  midY: number;
  /** 흐름의 판에만. 그 단계의 규칙 아이디. */
  step?: string;
  /** 흐름의 판에만. 이 카드가 서 있는 단계인지. */
  self?: boolean;
}

/** 판과 판을 잇는 꺾은선. 높이가 같으면 두 점, 다르면 네 점. */
export interface PathLine {
  key: string;
  points: Array<[number, number]>;
  dim: boolean;
}

export interface PathCut {
  /** cut 끊김(막대) · clamp 물렸으나 끊기지 않음(고리). 색이 아니라 모양이 이것을 가른다. */
  kind: "cut" | "clamp";
  state: "full" | "fenced" | "partial";
  cx: number; cy: number;
  title: string;
}

export interface FindingPath {
  width: number; height: number;
  lineY: number; footY: number;
  /** 흐름이 있으면 CHAIN_FOOT, 없으면 PATH_FOOT. 두 문장은 반대의 것을 말한다. */
  foot: string;
  /** 언제나 부여가 먼저, 자원이 끝. 가운데만 흐름을 따라 늘어난다. */
  links: PathLink[];
  lines: PathLine[];
  cut: PathCut | null;
  /** 흐름이 있을 때만. 카드가 「단계 N개」를 말로도 적기 위해 읽는다. */
  flow: { steps: number; omitted: number } | null;
  /** <desc>. 순수 함수의 반환값이므로 graphSummary 와 같이 단위 시험이 고정한다. */
  summary: string;
}

/** 낱말표는 화면에 한 벌뿐이므로 그쪽에서 받아 온다 - CONTAINMENT[containment] 를 그대로 넘긴다. */
export interface PathWords { label: string; why: string }

/** 그릴 경로가 없으면 null - 발화 동작이 하나도 없는 판정. */
export declare function findingPath(
  finding: Finding,
  containment: "full" | "fenced" | "partial" | "none",
  words: PathWords,
): FindingPath | null;
