// Types for bucketPolicyGrade.js - shared with src the same way blockPath.d.ts is.

import type {
  BucketPolicyReading, FindingStatus, Grade, OpenStatement,
} from "../src/types";

/** How one reading is presented: its grade, where it sits in the order, and what it is called. */
export interface ReadingShape {
  grade: Grade;
  /** Order within a grade. What is unsettled sorts before what is settled. */
  weight: number;
  /** Null where a badge would claim more than the reading does - a delegation, for one. */
  status: FindingStatus | null;
  title: string;
}

/** The card shape for one reading. The account relation changes three of the four fields. */
export declare function shapeOf(reading: BucketPolicyReading): ReadingShape;

/** Comparator: grade, then unsettled before settled, then principal label. */
export declare function byWeight(a: BucketPolicyReading, b: BucketPolicyReading): number;

/** How one Allow reaching beyond this deployment's principals is presented. */
export interface OpenShape {
  grade: Grade;
  label: string;
  why: string;
}

export declare function openGrade(statement: OpenStatement): OpenShape;

/** Comparator for open statements, worst first. */
export declare function byOpenGrade(a: OpenStatement, b: OpenStatement): number;

export declare const GRADE: Record<Grade, Grade>;
export declare const STATUS: Record<FindingStatus, FindingStatus>;
