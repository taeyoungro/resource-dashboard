// AWS management console LIST-page links for the impact assessment.
//
// Next to "resource type - N resources" the page offers the console page that lists resources of
// that TYPE - not a specific resource's detail page. An approver deciding about 12 instances wants
// the instances list with their own eyes on it, and a deep link to one instance would pick one for
// them.
//
// The host carries the account: https://<account id>.<region>.console.aws.amazon.com/... This is
// the multi-session console form. Signed-in Identity Center sessions get a random suffix after the
// account id (718100330247-w35htiu5.us-east-1...), and the console accepts the SAME path without
// the suffix - verified by hand against a live Access Portal session - resolving it to the
// caller's active session for that account, or to sign-in when there is none. So the link works
// without this page knowing anything about the viewer's session.
//
// Shared by the page and the tests. This file is imported by src/components/Impact.tsx (vite
// bundles it; consoleLinks.d.ts carries the types) and by consoleLinks.test.js under node --test,
// which is the one test runner this repository has. It must stay dependency-free.

// resource type as the assessment writes it -> console list page path. {region} is substituted;
// paths without it belong to global consoles (IAM) or global lists (S3 buckets).
//
// A TABLE, with the drift risk that implies - the same risk the action reference was moved into
// the assessment to avoid. It stays a table here because there is nothing to derive from: AWS
// publishes no API for console URLs, so a curated list is the only honest source. An unknown type
// gets NO link rather than a guessed one - a link that 404s or lands on the wrong list teaches an
// approver to stop trusting the ones that are right.
export const CONSOLE_LIST_PAGES = {
  'ec2:instance': '/ec2/home?region={region}#Instances:',
  'ec2:volume': '/ec2/home?region={region}#Volumes:',
  'ec2:security-group': '/ec2/home?region={region}#SecurityGroups:',
  'ec2:image': '/ec2/home?region={region}#Images:',
  'ec2:key-pair': '/ec2/home?region={region}#KeyPairs:',
  'ec2:elastic-ip': '/ec2/home?region={region}#Addresses:',
  'ec2:launch-template': '/ec2/home?region={region}#LaunchTemplates:',
  'ec2:vpc': '/vpcconsole/home?region={region}#vpcs:',
  'ec2:subnet': '/vpcconsole/home?region={region}#subnets:',
  'ec2:route-table': '/vpcconsole/home?region={region}#RouteTables:',
  'ec2:internet-gateway': '/vpcconsole/home?region={region}#igws:',
  'ec2:natgateway': '/vpcconsole/home?region={region}#NatGateways:',
  's3:bucket': '/s3/buckets?region={region}',
  'lambda:function': '/lambda/home?region={region}#/functions',
  'iam:role': '/iam/home#/roles',
  'iam:user': '/iam/home#/users',
  'iam:policy': '/iam/home#/policies',
  'iam:group': '/iam/home#/groups',
  'iam:oidc-provider': '/iam/home#/identity_providers',
  'dynamodb:table': '/dynamodbv2/home?region={region}#tables',
  'rds:db': '/rds/home?region={region}#databases:',
  'rds:cluster': '/rds/home?region={region}#databases:',
  'sqs:queue': '/sqs/v3/home?region={region}#/queues',
  'sns:topic': '/sns/v3/home?region={region}#/topics',
  'kms:key': '/kms/home?region={region}#/kms/keys',
  'ecs:cluster': '/ecs/v2/clusters?region={region}',
  'ecs:task-definition': '/ecs/v2/task-definitions?region={region}',
  'ecr:repository': '/ecr/private-registry/repositories?region={region}',
  'eks:cluster': '/eks/home?region={region}#/clusters',
  'glue:database': '/glue/home?region={region}#/v2/data-catalog/databases',
  'glue:table': '/glue/home?region={region}#/v2/data-catalog/tables',
  'glue:job': '/gluestudio/home?region={region}#/jobs',
  'logs:log-group': '/cloudwatch/home?region={region}#logsV2:log-groups',
  'cloudformation:stack': '/cloudformation/home?region={region}#/stacks',
  'secretsmanager:secret': '/secretsmanager/listsecrets?region={region}',
  'states:stateMachine': '/states/home?region={region}#/statemachines',
  'events:rule': '/events/home?region={region}#/rules',
  'athena:workgroup': '/athena/home?region={region}#/workgroups',
};

// Both go into the HOSTNAME, so both are validated as narrowly as the real values allow, not
// merely escaped. An account id or region that fails this shape gets no link at all: a crafted
// value would otherwise change the ORIGIN the approver is sent to, and this page renders data
// produced elsewhere.
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

/**
 * The console list page for one resource type in one account and region, or null.
 *
 * Null is an answer, not a failure: an unmapped type, or an account/region that does not look like
 * one. The caller renders nothing for null - no link is better than a wrong one.
 *
 * Resource Explorer reports "global" as the region of IAM resources; those consoles ignore the
 * region entirely, so the host falls back to us-east-1 the way the console itself does.
 */
export function consoleListUrl(accountId, region, resourceType) {
  const path = CONSOLE_LIST_PAGES[resourceType];
  if (!path) return null;
  if (!ACCOUNT.test(String(accountId))) return null;

  const where = region === 'global' ? 'us-east-1' : String(region);
  if (!REGION.test(where)) return null;

  return `https://${accountId}.${where}.console.aws.amazon.com${path.replaceAll('{region}', where)}`;
}

// ---- the plan list's two links: the SOURCE resource and the GOVERNED one ----
//
// A plan is keyed by the governed resource, and both ends of the projection have a console page:
// the source the user edited (a ps-*/service-* IAM role, or a cmp-* policy) and the artifact the
// pipeline manages from it (the permission set, the mirror-* role, the mirror-cmp-* twin). The
// governed side only EXISTS after an apply, which is why the caller shows it only on applied
// plans.
//
// IAM detail pages are stable deep links: /iam/home#/roles/details/<name> and
// /iam/home#/policies/details/<url-encoded policy ARN>. The permission set's page needs more: it
// lives under an Identity Center instance id (ssoins-...) that nothing client-side can derive.
// Both ids are in the permission set's ARN, which exists only after an apply - the plan writes
// "(known after apply)" where it will be - so the applier reads it back from state and records it
// in outcome.json, and the Governed link deep-links with it. An outcome without one (a plan
// applied before the applier recorded outputs) falls back to the Identity Center console home,
// one click short rather than a deep link that 404s - a wrong link would cost the trust the right
// ones earn.

// IAM names as this pipeline issues them - no paths, the documented IAM character set.
const IAM_NAME = /^[\w+=,.@-]+$/;

// The prefixes the pipeline governs, from GeneratorConfig: the source-role namespaces, the
// permission set namespace and the spec policy namespace. A resource outside them gets no links.
const SERVICE_PREFIXES = ['lambda-', 'ec2-', 'ecs-', 'eks-', 'glue-'];

function iamDetailUrl(accountId, hash) {
  if (!ACCOUNT.test(String(accountId))) return null;
  return `https://${accountId}.us-east-1.console.aws.amazon.com/iam/home#${hash}`;
}

export function iamRoleUrl(accountId, roleName) {
  if (!IAM_NAME.test(String(roleName))) return null;
  return iamDetailUrl(accountId, `/roles/details/${encodeURIComponent(roleName)}`);
}

export function iamPolicyUrl(accountId, policyName) {
  if (!IAM_NAME.test(String(policyName)) || !ACCOUNT.test(String(accountId))) return null;
  const arn = `arn:aws:iam::${accountId}:policy/${policyName}`;
  return iamDetailUrl(accountId, `/policies/details/${encodeURIComponent(arn)}`);
}

export function identityCenterUrl(accountId, region) {
  if (!ACCOUNT.test(String(accountId))) return null;
  const where = REGION.test(String(region)) ? region : 'us-east-1';
  return `https://${accountId}.${where}.console.aws.amazon.com/singlesignon/home?region=${where}`;
}

// The permission set ARN as Identity Center issues it. Its two ids are exactly what the console
// detail page is addressed by - #/instances/<instance id WITHOUT the ssoins- prefix>/
// permission-sets/details/<ps-id> - verified by hand against a live session. Both segments are
// written into the URL, so both are held to a narrow character set even though the ARN comes from
// the applier's own record: this page renders data produced elsewhere.
const PERMISSION_SET_ARN =
  /^arn:aws:sso:::permissionSet\/ssoins-([A-Za-z0-9._-]+)\/(ps-[A-Za-z0-9._-]+)$/;

/**
 * The permission set's console detail page, from its ARN, or null. Null when the ARN does not
 * parse - the caller falls back to identityCenterUrl, one click short of the permission set,
 * rather than offering a deep link built from a value that is not what it claims to be.
 */
export function permissionSetUrl(accountId, permissionSetArn, region) {
  if (!ACCOUNT.test(String(accountId))) return null;
  const match = PERMISSION_SET_ARN.exec(String(permissionSetArn ?? ''));
  if (!match) return null;
  const where = REGION.test(String(region)) ? region : 'us-east-1';
  return `https://${accountId}.${where}.console.aws.amazon.com/singlesignon/home`
    + `?region=${where}#/instances/${match[1]}/permission-sets/details/${match[2]}`;
}

/**
 * Both links for one plan, or null where one cannot be built. The governed artifact's name is the
 * pipeline's own naming rule - mirror-<source> for roles and twins. The permission set case links
 * its console detail page when the applier recorded the ARN in outcome.json, and the Identity
 * Center console home without it (see above).
 */
export function planLinks(accountId, resource,
                          { region = 'us-east-1', permissionSetArn = null } = {}) {
  const name = String(resource ?? '');
  if (!name || !ACCOUNT.test(String(accountId))) return { spec: null, governed: null };

  if (name.startsWith('ps-')) {
    return {
      spec: iamRoleUrl(accountId, name),
      governed: permissionSetUrl(accountId, permissionSetArn, region)
        ?? identityCenterUrl(accountId, region),
    };
  }
  if (SERVICE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return {
      spec: iamRoleUrl(accountId, name),
      governed: iamRoleUrl(accountId, `mirror-${name}`),
    };
  }
  if (name.startsWith('cmp-')) {
    return {
      spec: iamPolicyUrl(accountId, name),
      governed: iamPolicyUrl(accountId, `mirror-${name}`),
    };
  }
  return { spec: null, governed: null };
}
