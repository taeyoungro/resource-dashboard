// Which service an AWS managed policy is ABOUT, or null when nothing says.
//
// AWSLambda_FullAccess is about lambda. It also reaches every CloudFormation stack and KMS key in
// the account, because a Lambda function refers to those - but an approver who opened that policy
// came to decide about functions, and 15 stacks above the 3 functions buries the thing they came
// for. The answer here picks the icon on the policy line, the count beside it, and which impact
// groups are shown against which are folded behind "연관".
//
// This used to read the NAME and nothing else, and the name is the wrong authority. AWS writes
// policy names as brands, and a brand is not an IAM prefix:
//
//     AmazonEC2ContainerRegistryFullAccess  is about  ecr:*
//     AmazonMSKFullAccess                   is about  kafka:*
//
// No prefix test, startsWith or containment connects those, and neither does botocore - it brands
// ecr "Amazon Elastic Container Registry" and kafka "Managed Streaming for Kafka", which are the
// deck's spellings, not the policy name's. So both policies resolved to null: no icon, no fold, and
// nothing to tell an approver the difference between a policy about one service and a policy about
// twelve. Widening the name test cannot fix that - "ecr" is three letters and turns up inside
// unrelated words - and naming the two of them in a table fixes those two.
//
// What a policy GRANTS is the authority. It is the policy itself rather than a label on it, it is
// already in hand (actions_granted, the patterns as the author wrote them), and it says the same
// thing for every policy AWS has published or will publish. Two statements are read off it, in the
// order below, and both are unconditional - neither carries a threshold to tune:
//
//     the policy names exactly one service     ->  that service
//     the policy grants exactly one in FULL    ->  that service   (svc:* among its patterns)
//
// AmazonMSKFullAccess names eleven services and grants exactly one of them wholesale, which is
// kafka. AmazonEC2ContainerRegistryReadOnly names only ecr. A policy that says neither - a Lambda
// VPC execution role naming five ec2 actions and three logs actions - stays null, which is what it
// was before and the honest answer for a policy that is about a job rather than a service.

/** Vendor prefix and access suffix AWS puts around the service name in a managed policy name. */
const VENDOR = /^(aws|amazon)/;
const SUFFIX = /(fullaccess|readonlyaccess|readonly|poweruser|administrator|access)$/;

/**
 * Brand aliases, read LAST - after both grant statements have declined to answer.
 *
 * AmazonEventBridgeReadOnlyAccess is the shape that still needs one: EventBridge's actions are
 * events:*, no name test connects the two, and the policy names events, scheduler, pipes and
 * schemas while granting none of them in full. Nothing in the policy points at one service, so the
 * alias is the only thing left that does. AWSKeyManagementServicePowerUser is the same shape - kms
 * and iam named, neither wholesale.
 *
 * Being last is what makes this table safe to leave alone rather than something to grow. It can add
 * an answer where there was none; it can no longer change one, so a stale entry costs nothing and
 * an entry the grants already settle is simply never reached. Anything new belongs in the grant
 * statements above or nowhere - a table with one row per brand is the thing this stopped being.
 *
 * The alias is still only BELIEVED when the aliased prefix is among the services this policy
 * actually names, which is the rule every other path here follows.
 */
const BRAND_STEM = {
  eventbridge: 'events',
  stepfunctions: 'states',
  keymanagementservice: 'kms',
  certificatemanager: 'acm',
  systemsmanager: 'ssm',
};

/** The service half of an action pattern, or null for `*` and for anything malformed. */
function serviceOf(pattern) {
  const service = String(pattern).split(':', 1)[0].toLowerCase();
  return service && !service.includes('*') ? service : null;
}

/** Every service this policy names at all, however few of its actions it names. */
function named(granted) {
  const out = new Set();
  for (const pattern of granted) {
    const service = serviceOf(pattern);
    if (service) out.add(service);
  }
  return out;
}

/**
 * Every service this policy grants IN FULL - `svc:*` written as one pattern.
 *
 * The distinction that makes this worth reading separately from the names: AmazonMSKFullAccess
 * names kms, iam, ec2, s3, logs and more, and grants exactly one of them - kafka - wholesale. The
 * others are the plumbing a cluster needs, and no approver opened that policy to decide about them.
 */
function wholesale(granted) {
  const out = new Set();
  for (const pattern of granted) {
    const colon = String(pattern).indexOf(':');
    if (colon < 0 || String(pattern).slice(colon + 1) !== '*') continue;
    const service = serviceOf(pattern);
    if (service) out.add(service);
  }
  return out;
}

/** The single member of a set, or null - "exactly one" is the whole statement, so it is spelled once. */
function sole(services) {
  return services.size === 1 ? [...services][0] : null;
}

/**
 * The service an AWS managed policy is about, or null.
 *
 * `granted` is the policy's action patterns as written (actions_granted). `candidates` is every
 * service the policy touches at all - its patterns, their expansion, and the resource groups it
 * reaches - and it is what a name is checked AGAINST, so a name that decomposes to a service this
 * policy never mentions is not believed.
 *
 * Customer managed policies are named by whoever wrote them and are excluded: mirror-cmp-Reporting
 * says nothing about a service, and the platform writes those names itself. The grant statements
 * would work on them, but folding a hand-written policy's groups behind a click is a change to the
 * screen an operator reads every day and no reported problem asks for it.
 */
export function primaryService(identifier, granted, candidates) {
  if (!String(identifier).startsWith('arn:aws:iam::aws:policy/')) return null;
  const patterns = granted ?? [];
  const mentioned = candidates ?? [];

  const bare = String(identifier).slice(String(identifier).lastIndexOf('/') + 1)
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const stem = bare.replace(VENDOR, '').replace(SUFFIX, '');

  // Longest first, so s3-object-lambda wins over s3 for a policy about the former - and compared
  // with its hyphens removed, because the name has already lost every character that is not a
  // letter or a digit. Without that the longest-first ordering means nothing for a hyphenated
  // prefix: "s3objectlambdaexecutionrole" starts with "s3" and never with "s3-object-lambda".
  // Lowercased on the way in: AWS writes "S3:GetBucketPolicy" in its own policy documents, and a
  // candidate that keeps its capital never matches a name, never matches a resource group's
  // service, and never finds an icon.
  // A candidate with nothing left after flattening is dropped rather than compared: "" is a prefix
  // of every name, so a stray "*" among the groups would answer for the whole policy.
  const ordered = [...new Set(mentioned.map((s) => String(s).toLowerCase()))]
    .filter((service) => service.replace(/[^a-z0-9]/g, ''))
    .sort((a, b) => b.length - a.length);
  const flat = new Map(ordered.map((service) => [service, service.replace(/[^a-z0-9]/g, '')]));
  const byName = stem && (
    ordered.find((service) => stem === flat.get(service))
    ?? ordered.find((service) => stem.startsWith(flat.get(service)))
    // Loose containment only for a name long enough not to collide by accident. Two- and
    // three-letter prefixes - es, s3, kms, ecr - turn up inside unrelated words: "access" alone
    // contains "es", which would make every policy in existence look like an Elasticsearch policy.
    ?? ordered.find((service) => service.length >= 4 && bare.includes(service))
  );
  if (byName) return byName;

  // What the policy grants, which is the policy rather than a label on it.
  return sole(named(patterns))
    ?? sole(wholesale(patterns))
    ?? (stem && BRAND_STEM[stem] && ordered.includes(BRAND_STEM[stem]) ? BRAND_STEM[stem] : null);
}
