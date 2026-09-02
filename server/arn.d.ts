// Types for arn.js - shared with src the same way consoleLinks.d.ts is.

export interface ParsedArn {
  service: string;
  /** "global" when the ARN carries no region (IAM, S3). */
  region: string;
  /** "" when the ARN carries no account (S3, some apigateway shapes). */
  account: string;
  /** The identifying part, type token stripped, trailing UUID qualifier split off. */
  name: string;
  /** A trailing /UUID segment (CloudFormation stack ids), or null. */
  qualifier: string | null;
}

export declare function parseArn(arn: string): ParsedArn | null;

/** The short id a picture and a panel both call one resource by. See the comment in arn.js. */
export declare function resourceId(arn: string): string;
