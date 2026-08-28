// AWS API reference links for the action names printed on a finding card.
//
// An approver reading "발화 동작 lambda:UpdateFunctionCode" has to decide whether that action is as
// dangerous as the card says, and the honest place to check is AWS's own page for it. The card
// already prints the name in full and never abbreviates it (T-7); this only makes that name
// clickable and changes no text.
//
// A TABLE, with the drift risk that implies - the same choice consoleLinks.js makes, for the same
// reason. AWS publishes no index of documentation URLs, so the base path per service is curated. A
// service absent from the table gets NO link, and a link that 404s is worse than no link at all: it
// teaches an approver to stop clicking the ones that are right.
//
// What the table cannot see, and how that is handled. An IAM action name is USUALLY the name of an
// API operation, and where it is, API_<Action>.html is that operation's page. It is not always:
// some IAM actions gate an operation with a different name, and some gate no operation at all -
// iam:PassRole is a permission checked during another service's call and has no page of its own.
// Those are listed below with what they really are, and they render as plain text. The list was
// built by joining every action this repository's rules and capability table name (292 of them)
// against botocore's operation names for the same service prefix; eleven did not match, and each
// one is accounted for here.

/** IAM service prefix -> its API reference page, with {Action} substituted. */
export const API_REFERENCES = {
  ec2: 'https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_{Action}.html',
  lambda: 'https://docs.aws.amazon.com/lambda/latest/api/API_{Action}.html',
  iam: 'https://docs.aws.amazon.com/IAM/latest/APIReference/API_{Action}.html',
  dynamodb: 'https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_{Action}.html',
  s3: 'https://docs.aws.amazon.com/AmazonS3/latest/API/API_{Action}.html',
  kms: 'https://docs.aws.amazon.com/kms/latest/APIReference/API_{Action}.html',
  sts: 'https://docs.aws.amazon.com/STS/latest/APIReference/API_{Action}.html',
  ssm: 'https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_{Action}.html',
  ecs: 'https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_{Action}.html',
  ecr: 'https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_{Action}.html',
  sqs: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_{Action}.html',
  sns: 'https://docs.aws.amazon.com/sns/latest/api/API_{Action}.html',
  rds: 'https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_{Action}.html',
  logs: 'https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_{Action}.html',
  cloudtrail: 'https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_{Action}.html',
  cloudformation: 'https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_{Action}.html',
  config: 'https://docs.aws.amazon.com/config/latest/APIReference/API_{Action}.html',
  guardduty: 'https://docs.aws.amazon.com/guardduty/latest/APIReference/API_{Action}.html',
  glue: 'https://docs.aws.amazon.com/glue/latest/webapi/API_{Action}.html',
  states: 'https://docs.aws.amazon.com/step-functions/latest/apireference/API_{Action}.html',
  secretsmanager: 'https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_{Action}.html',
  elasticloadbalancing: 'https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_{Action}.html',
  organizations: 'https://docs.aws.amazon.com/organizations/latest/APIReference/API_{Action}.html',
  // The permission set actions belong to IAM Identity Center's admin API, which IAM keys as sso.
  sso: 'https://docs.aws.amazon.com/singlesignon/latest/APIReference/API_{Action}.html',
};

/**
 * Actions whose page is not API_<name>.html under their service's base, and actions with no page.
 *
 * `null` means the action gates something rather than being an operation of its own. That is a real
 * category in IAM and not a gap in this table: iam:PassRole is evaluated while another service
 * creates a resource, s3:GetObjectVersion is GetObject with a version, and the dynamodb PartiQL
 * four are permissions on ExecuteStatement. None of them has a page to open.
 *
 * A string is the full URL, for the two cases where the name is right but the book is not: Lambda
 * splits its newer surfaces into separate references, and Invoke is spelled InvokeFunction in IAM.
 */
export const ACTION_DOC_OVERRIDES = {
  'iam:PassRole': null,
  'lambda:InvokeFunctionUrl': null,
  'lambda:PassCapacityProvider': null,
  's3:GetObjectVersion': null,
  'states:RevealSecrets': null,
  'dynamodb:PartiQLSelect': null,
  'dynamodb:PartiQLInsert': null,
  'dynamodb:PartiQLUpdate': null,
  'dynamodb:PartiQLDelete': null,
  // IAM says InvokeFunction; the operation, and the page, are Invoke.
  'lambda:InvokeFunction': 'https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html',
};

/** Lambda's newer surfaces are separate references under the same product. */
const LAMBDA_BOOKS = [
  // Every action of these two surfaces carries the surface's word, which is what makes matching on
  // the word safe rather than a prefix guess: there is no Lambda action containing Microvm or
  // NetworkConnector that is documented in the main reference.
  [/Microvm/, 'https://docs.aws.amazon.com/lambda/latest/microvm-api/API_{Action}.html'],
  [/NetworkConnector/, 'https://docs.aws.amazon.com/lambda/latest/lambda-core/API_{Action}.html'],
];

/**
 * The AWS documentation page for one IAM action, or null when there is nothing to open.
 *
 * Null is the answer for a service this table does not carry, and for an action that gates rather
 * than names an operation. Callers render the name as plain text in both cases - the name is the
 * information, and the link is a convenience on top of it.
 */
export function actionDocUrl(action) {
  const text = String(action);
  const colon = text.indexOf(':');
  if (colon < 1) return null;
  const service = text.slice(0, colon).toLowerCase();
  const name = text.slice(colon + 1);
  // A wildcard is not an action, and an empty name has no page.
  if (!name || name.includes('*')) return null;

  if (text in ACTION_DOC_OVERRIDES) return ACTION_DOC_OVERRIDES[text];

  if (service === 'lambda') {
    for (const [pattern, template] of LAMBDA_BOOKS) {
      if (pattern.test(name)) return template.replace('{Action}', name);
    }
  }
  const base = API_REFERENCES[service];
  return base ? base.replace('{Action}', name) : null;
}
