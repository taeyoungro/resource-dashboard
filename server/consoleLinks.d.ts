// Types for consoleLinks.js, which src/components/Impact.tsx imports across the src boundary.
// The logic lives in plain JS beside the other server modules because node --test is the one test
// runner this repository has, and it cannot load TypeScript.

export declare const CONSOLE_LIST_PAGES: Record<string, string>;

export declare function consoleListUrl(
  accountId: string,
  region: string,
  resourceType: string,
): string | null;

export declare function iamRoleUrl(accountId: string, roleName: string): string | null;

export declare function iamPolicyUrl(accountId: string, policyName: string): string | null;

export declare function identityCenterUrl(accountId: string, region?: string): string | null;

export declare function permissionSetUrl(
  accountId: string,
  permissionSetArn: string | null,
  region?: string,
): string | null;

export declare function planLinks(
  accountId: string | null,
  resource: string | null,
  options?: { region?: string; permissionSetArn?: string | null },
): { spec: string | null; governed: string | null };

