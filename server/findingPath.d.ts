// Types for findingPath.js - shared with src the same way blockPath.d.ts is.

import type { Finding } from "../src/types";

export const LINK_W: number;
export const LINK_H: number;
export const GAP: number;
export const PATH_W: number;
export const PATH_H: number;
export const LINE_Y: number;
export const FOOT_Y: number;
export const PATH_FOOT: string;

/** 고리 셋. 순서는 카드의 뼈대이고 발견의 값이 아니다. */
export type PathLinkId = "grant" | "action" | "target";
/** 확립 · 미확인(근거가 확정하지 못함) · 주장 없음(이 판정이 그 주장을 하지 않음). */
export type PathLinkState = "established" | "unverified" | "unclaimed";

export interface PathLink {
  id: PathLinkId;
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
}

export interface PathLine {
  key: string;
  x1: number; x2: number;
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
  foot: string;
  /** 언제나 길이 3, 언제나 같은 순서. */
  links: PathLink[];
  /** 언제나 길이 2. */
  lines: PathLine[];
  cut: PathCut | null;
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
