import { parseArn } from "../../server/arn.js";

/**
 * One resource, printed the way a person reads it: the NAME prominent, the noise quiet.
 *
 * A group of fifteen CloudFormation stacks used to print
 * `arn:aws:cloudformation:us-east-1:718100330247:stack/` fifteen times - sixty characters of
 * prefix in front of the one segment that differs, and a stack UUID after it that nobody reads.
 * The approver's question is "which stacks", so the name carries the emphasis, the UUID qualifier
 * is folded to a quiet tail, and the constant context (service, region, account) is printed once
 * in the group heading rather than once per row.
 *
 * Two honesty rules:
 *
 *   the full ARN never disappears   it is the value a restriction actually names, so it rides on
 *                                   title (hover) - and an ARN this cannot parse is printed WHOLE,
 *                                   never hidden behind a broken name
 *   deviation is louder than habit  when a row's region or account differs from the rest of its
 *                                   group, that difference is printed on the row itself. A
 *                                   cross-region resource hiding under a uniform-looking list is
 *                                   exactly what an approver must not miss
 */
export function ResourceName({
  arn, groupRegion, groupAccount,
}: {
  arn: string;
  /** The region the group heading claims for every row, or null when the group is mixed. */
  groupRegion: string | null;
  /** Same, for the account. */
  groupAccount: string | null;
}) {
  const parsed = parseArn(arn);
  if (!parsed) {
    return <code title={arn}>{arn}</code>;
  }
  const showRegion = groupRegion === null || parsed.region !== groupRegion;
  const showAccount = parsed.account !== ""
    && (groupAccount === null || parsed.account !== groupAccount);
  return (
    <span className="res" title={arn}>
      <code className="res-name">{parsed.name}</code>
      {parsed.qualifier && <span className="res-qualifier">/{parsed.qualifier}</span>}
      {(showRegion || showAccount) && (
        <span className="res-context">
          {showRegion && parsed.region}
          {showRegion && showAccount && " · "}
          {showAccount && parsed.account}
        </span>
      )}
    </span>
  );
}

/** The one value every row shares, or null when they do not all share it. */
export function uniform(values: (string | undefined)[]): string | null {
  const seen = [...new Set(values.filter((v): v is string => Boolean(v)))];
  return seen.length === 1 ? seen[0] : null;
}
