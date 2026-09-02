// Reading an ARN the way a person does: service, region, account, and the NAME.
//
// The impact panel used to print resource ARNs whole. In a group of fifteen CloudFormation stacks
// that is `arn:aws:cloudformation:us-east-1:718100330247:stack/` repeated fifteen times - sixty
// characters of prefix in front of the one segment that differs - plus a stack UUID after it that
// nobody reads. The approver's question is "WHICH stacks", and the answer is the names.
//
// This parser splits an ARN into the parts a person needs, so the page can print the name
// prominently, the noise quietly, and the constant parts (service, region, account) once per group
// instead of once per row. It does NOT try to understand every ARN shape AWS has - it applies
// three rules that hold across the shapes Resource Explorer inventories:
//
//   1. arn:partition:service:region:account:REST - the first five fields are positional, and REST
//      may itself contain ':' (lambda's function:name, logs' log-group:/aws/lambda/x).
//   2. REST usually leads with a type token - stack/, function:, key/, role/ - which repeats what
//      the group heading already says, so it is stripped when present. A REST with no separator
//      (an S3 bucket, an SQS queue) IS the name and nothing is stripped.
//   3. A trailing /UUID segment is a QUALIFIER, split off so it can be de-emphasised: a
//      CloudFormation stack id ends in one and the name is what identifies the stack. It is only
//      split when something remains - a KMS key's name IS a UUID, and stripping it would leave
//      nothing.
//
// Anything that does not parse returns null and the caller renders the raw string - a value this
// cannot read is shown whole, never hidden.
//
// Shared by the page and the tests, dependency-free, plain JS with a .d.ts beside it - same
// arrangement as consoleLinks.js, and for the same reason: node --test is the one test runner
// here and it cannot load TypeScript.

const TYPE_TOKEN = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} arn
 * @returns {{ service: string, region: string, account: string, name: string,
 *             qualifier: string | null } | null}
 */
export function parseArn(arn) {
  if (typeof arn !== 'string' || !arn.startsWith('arn:')) return null;
  const parts = arn.split(':');
  if (parts.length < 6) return null;
  const [, , service, region, account] = parts;
  const rest = parts.slice(5).join(':');
  if (!service || !rest) return null;

  // Rule 2. The separator search covers '/' and ':' because both are in live use as the
  // type-to-name separator. A leading '/' (apigateway's :/restapis/...) means no token.
  let name = rest;
  const separator = rest.search(/[/:]/);
  if (separator > 0 && TYPE_TOKEN.test(rest.slice(0, separator))) {
    name = rest.slice(separator + 1);
  }
  if (!name) return null;

  // Rule 3. Only a TRAILING uuid, only split on '/', and only when a name remains.
  let qualifier = null;
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash > 0) {
    const tail = name.slice(lastSlash + 1);
    if (UUID.test(tail)) {
      qualifier = tail;
      name = name.slice(0, lastSlash);
    }
  }

  // Region '' is how global services write their ARNs (IAM, S3). Named rather than left empty so
  // the caller can say it instead of printing a gap.
  return {
    service,
    region: region || 'global',
    account: account || '',
    name,
    qualifier,
  };
}

/**
 * The short id a picture and a panel both call one resource by.
 *
 * ONE function because there were two, and they agreed only by accident. The relationship picture
 * cut the resource part at the last '/' and the resource panel cut it at the last '/' and then the
 * last ':' - identical on `instance/i-0aaa111`, which was every ARN the picture drew while it drew
 * EC2 alone. Drawing any policy put `arn:aws:rds:…:db:opt-main` on a plate, and the plate said
 * `db:opt-main` while the panel that opens from clicking it said `opt-main`: one resource, two ids,
 * on one screen.
 *
 * The rule is the ARN's own: everything after the last separator between the type token and the
 * name, and '/' and ':' are both in live use as that separator (`role/opt-Applier`, `db:opt-main`).
 * An ARN whose resource part has neither is already the name (`arn:aws:s3:::opt-logs`).
 *
 * Deliberately NOT parseArn().name, which strips only a LEADING type token and would answer
 * `/aws/lambda/foo` for a log group where both callers have always answered `foo`. That is arguably
 * the better name and it is a different change, with the console links and the resource lines to
 * move with it.
 */
export function resourceId(arn) {
  if (typeof arn !== 'string') return '';
  const rest = arn.split(':').slice(5).join(':');
  const cut = Math.max(rest.lastIndexOf('/'), rest.lastIndexOf(':'));
  return rest.slice(cut + 1) || rest;
}
