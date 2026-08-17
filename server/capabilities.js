// What an action LETS YOU DO, as a small closed vocabulary.
//
// The candidate paths are built out of these, not out of action names: the instance-profile swap
// and the userData rewrite share no action at all and end in the same place, and only a vocabulary
// above the names puts them in one bucket. A rule table can only find the chains somebody already
// wrote down; capabilities let the generator propose chains nobody has.
//
// Three things this deliberately is not
// -------------------------------------
//   not a replacement for the names   The approver's next step is writing an allow_only list, and
//                                     you cannot write one from "modify-config". Every candidate
//                                     carries the verbatim actions underneath; the capability is a
//                                     sort key, a section header and a way to join across
//                                     policies. It never travels alone
//   not derived from the verb          Measured across 2,057 actions in twelve services: 158
//                                     (7.7%) match no recognised verb, and 31 more have a verb
//                                     that contradicts the access level - and the errors cluster
//                                     exactly where it matters. sts:GetFederationToken mints a
//                                     credential behind a Get; kms:GenerateDataKey mints key
//                                     material behind a name that reads passive; logs:StartQuery
//                                     is a Read. So the verb is the LAST resort, not the first
//   not derived from the access level  Five values cannot separate ec2:CreateRoute from
//                                     ec2:CreateTags from ec2:StopInstances. The level answers
//                                     "does this change anything", which is a different question
//
// So: a curated table for the actions that carry a path, verb and level as a fallback for the
// rest, and an explicit UNMAPPED bucket that is counted and reported rather than absorbed into a
// plausible-looking one. An action nobody classified is not an action that does nothing.
//
// A capability is a SET, not a value
// ----------------------------------
// ec2:ModifyInstanceAttribute is modify-config for most attributes and modify-code for exactly one
// of them - userData - and that single sub-attribute is what makes instance takeover work without
// iam:PassRole. Collapsing it to one capability turns the sharpest path in the set into "changed
// some configuration". lambda:UpdateFunctionConfiguration is the same shape: it is modify-config,
// and it can also change the execution role, which is replace-identity.

/** The closed vocabulary. Anything not here is a bug, not a new category invented at runtime. */
export const CAP = {
  // Identity - ending up as somebody else
  PASS_ROLE: 'pass-role',
  REPLACE_IDENTITY: 'replace-identity',
  MINT_CREDENTIAL: 'mint-credential',
  ATTACH_POLICY: 'attach-policy',
  WRITE_POLICY: 'write-policy',
  // Execution - running your code somewhere
  MODIFY_CODE: 'modify-code',
  MODIFY_CONFIG: 'modify-config',
  INVOKE: 'invoke',
  STOP_START: 'stop-start',
  CREATE: 'create',
  DELETE: 'delete',
  // Data - the plane the rule file has no bucket for, and where the two control-plane paths live
  WRITE_DATA: 'write-data',
  READ_DATA: 'read-data',
  READ_SECRET: 'read-secret',
  SHARE_EXTERNAL: 'share-external',
  SNAPSHOT: 'snapshot',
  // Network
  NETWORK_ROUTE: 'network-route',
  NETWORK_INGRESS: 'network-ingress',
  // Buying time
  TAMPER_AUDIT: 'tamper-audit',
  TAG: 'tag',
  UNMAPPED: 'unmapped',
};

/**
 * The curated part. Every entry is an action that carries a path, and the value is the SET.
 *
 * Kept as data rather than as rules so the same table serves the generator, the renderer's
 * grouping and the prompt's vocabulary. Additions are cheap; a wrong entry is not, so an action
 * whose capability is arguable is left out and lands in the verb fallback, where it is at least
 * visible as a guess.
 */
export const CURATED = {
  // ---- identity ----
  'iam:PassRole': [CAP.PASS_ROLE],
  'iam:CreateRole': [CAP.CREATE, CAP.REPLACE_IDENTITY],
  'iam:UpdateAssumeRolePolicy': [CAP.REPLACE_IDENTITY],
  'iam:AttachRolePolicy': [CAP.ATTACH_POLICY],
  'iam:AttachUserPolicy': [CAP.ATTACH_POLICY],
  'iam:AttachGroupPolicy': [CAP.ATTACH_POLICY],
  'iam:PutRolePolicy': [CAP.WRITE_POLICY],
  'iam:PutUserPolicy': [CAP.WRITE_POLICY],
  'iam:CreatePolicyVersion': [CAP.WRITE_POLICY],
  'iam:SetDefaultPolicyVersion': [CAP.WRITE_POLICY],
  'iam:CreateAccessKey': [CAP.MINT_CREDENTIAL],
  'iam:UpdateLoginProfile': [CAP.MINT_CREDENTIAL],
  'iam:CreateServiceLinkedRole': [CAP.CREATE],
  'sts:AssumeRole': [CAP.MINT_CREDENTIAL],
  // Credential minting behind a Get - the clearest case against verb mapping.
  'sts:GetFederationToken': [CAP.MINT_CREDENTIAL],
  'sts:GetWebIdentityToken': [CAP.MINT_CREDENTIAL],
  'sso:PutInlinePolicyToPermissionSet': [CAP.WRITE_POLICY],
  'sso:AttachManagedPolicyToPermissionSet': [CAP.ATTACH_POLICY],
  'sso:CreateAccountAssignment': [CAP.REPLACE_IDENTITY],
  'sso:ProvisionPermissionSet': [CAP.MODIFY_CONFIG],

  // ---- execution: taking over something that already holds a role ----
  // Two capabilities, and the second one is the whole path: userData is code that runs at boot as
  // whatever role is attached, and no iam:PassRole is needed to change it.
  'ec2:ModifyInstanceAttribute': [CAP.MODIFY_CONFIG, CAP.MODIFY_CODE],
  'ec2:StopInstances': [CAP.STOP_START],
  'ec2:StartInstances': [CAP.STOP_START],
  'ec2:RebootInstances': [CAP.STOP_START],
  'ec2:TerminateInstances': [CAP.DELETE],
  'ec2:RunInstances': [CAP.CREATE],
  'ec2:AssociateIamInstanceProfile': [CAP.REPLACE_IDENTITY],
  'ec2:ReplaceIamInstanceProfileAssociation': [CAP.REPLACE_IDENTITY],
  'ec2:CreateLaunchTemplateVersion': [CAP.MODIFY_CODE],
  'ec2:ModifyLaunchTemplate': [CAP.MODIFY_CODE],
  'lambda:UpdateFunctionCode': [CAP.MODIFY_CODE],
  'lambda:CreateFunction': [CAP.CREATE, CAP.MODIFY_CODE],
  // Can change the execution role, which is why it is not merely configuration.
  'lambda:UpdateFunctionConfiguration': [CAP.MODIFY_CONFIG, CAP.REPLACE_IDENTITY],
  'lambda:InvokeFunction': [CAP.INVOKE],
  'lambda:InvokeFunctionUrl': [CAP.INVOKE],
  'lambda:InvokeAsync': [CAP.INVOKE],
  'lambda:AddPermission': [CAP.SHARE_EXTERNAL],
  'lambda:CreateFunctionUrlConfig': [CAP.SHARE_EXTERNAL],
  'lambda:DeleteFunction': [CAP.DELETE],
  'lambda:UpdateFunctionUrlConfig': [CAP.SHARE_EXTERNAL],
  'ecs:RegisterTaskDefinition': [CAP.CREATE, CAP.MODIFY_CODE],
  'ecs:RunTask': [CAP.INVOKE, CAP.MODIFY_CODE],
  'ecs:UpdateService': [CAP.MODIFY_CONFIG, CAP.MODIFY_CODE],
  'ecs:StartTask': [CAP.INVOKE],
  'ecr:PutImage': [CAP.MODIFY_CODE],
  'ecr:BatchDeleteImage': [CAP.DELETE],
  'ssm:SendCommand': [CAP.INVOKE, CAP.MODIFY_CODE],
  'ssm:StartSession': [CAP.INVOKE],
  'ssm:PutParameter': [CAP.WRITE_DATA],
  'glue:UpdateJob': [CAP.MODIFY_CODE],
  'glue:CreateJob': [CAP.CREATE, CAP.MODIFY_CODE],
  'states:UpdateStateMachine': [CAP.MODIFY_CODE],

  // ---- data plane ----
  // The bucket the rule file has no rule for, and where the two control-plane paths live: forging
  // an approval item, and forging or deleting a state lock.
  'dynamodb:PutItem': [CAP.WRITE_DATA],
  'dynamodb:UpdateItem': [CAP.WRITE_DATA],
  'dynamodb:DeleteItem': [CAP.WRITE_DATA],
  'dynamodb:BatchWriteItem': [CAP.WRITE_DATA],
  'dynamodb:PartiQLInsert': [CAP.WRITE_DATA],
  'dynamodb:PartiQLUpdate': [CAP.WRITE_DATA],
  'dynamodb:PartiQLDelete': [CAP.WRITE_DATA],
  'dynamodb:Scan': [CAP.READ_DATA],
  'dynamodb:Query': [CAP.READ_DATA],
  'dynamodb:GetItem': [CAP.READ_DATA],
  'dynamodb:BatchGetItem': [CAP.READ_DATA],
  'dynamodb:PartiQLSelect': [CAP.READ_DATA],
  'dynamodb:GetRecords': [CAP.READ_DATA],
  'dynamodb:ExportTableToPointInTime': [CAP.READ_DATA, CAP.SHARE_EXTERNAL],
  'dynamodb:PutResourcePolicy': [CAP.SHARE_EXTERNAL],
  'dynamodb:DeleteTable': [CAP.DELETE],
  'dynamodb:UpdateTimeToLive': [CAP.DELETE],
  's3:PutObject': [CAP.WRITE_DATA],
  's3:DeleteObject': [CAP.DELETE],
  's3:GetObject': [CAP.READ_DATA],
  's3:GetObjectVersion': [CAP.READ_DATA],
  's3:PutBucketPolicy': [CAP.SHARE_EXTERNAL],
  's3:PutBucketAcl': [CAP.SHARE_EXTERNAL],
  'sqs:SendMessage': [CAP.WRITE_DATA],
  'sqs:ReceiveMessage': [CAP.READ_DATA],
  'sqs:DeleteMessage': [CAP.WRITE_DATA],
  'sqs:SetQueueAttributes': [CAP.SHARE_EXTERNAL],
  'secretsmanager:GetSecretValue': [CAP.READ_SECRET],
  'secretsmanager:PutSecretValue': [CAP.WRITE_DATA],
  'ssm:GetParameter': [CAP.READ_SECRET],
  'ssm:GetParameters': [CAP.READ_SECRET],
  'ssm:GetParametersByPath': [CAP.READ_SECRET],
  'kms:Decrypt': [CAP.READ_SECRET],
  'kms:GenerateDataKey': [CAP.READ_SECRET],
  'kms:PutKeyPolicy': [CAP.SHARE_EXTERNAL],
  'kms:ScheduleKeyDeletion': [CAP.DELETE],
  'kms:DisableKey': [CAP.DELETE],
  'ecr:GetAuthorizationToken': [CAP.MINT_CREDENTIAL],
  'ecr:GetDownloadUrlForLayer': [CAP.READ_DATA],
  'states:RevealSecrets': [CAP.READ_SECRET],

  // ---- reading what makes an attack aimable ----
  'ec2:GetConsoleOutput': [CAP.READ_SECRET],
  'ec2:GetConsoleScreenshot': [CAP.READ_SECRET],
  'ec2:GetPasswordData': [CAP.READ_SECRET],
  // userData, behind a name that reads like an inventory call and a level that says List.
  'ec2:DescribeInstanceAttribute': [CAP.READ_SECRET],
  'ec2:DescribeLaunchTemplateVersions': [CAP.READ_SECRET],
  'lambda:GetFunction': [CAP.READ_DATA],
  'iam:GetRole': [CAP.READ_DATA],
  'iam:GetRolePolicy': [CAP.READ_DATA],
  'iam:GetPolicyVersion': [CAP.READ_DATA],
  'iam:ListAttachedRolePolicies': [CAP.READ_DATA],
  'iam:ListRoles': [CAP.READ_DATA],
  'iam:ListRolePolicies': [CAP.READ_DATA],
  'iam:SimulatePrincipalPolicy': [CAP.READ_DATA],
  'cloudformation:GetTemplate': [CAP.READ_DATA],
  'cloudformation:DescribeStacks': [CAP.READ_DATA],
  'cloudformation:ListStackResources': [CAP.READ_DATA],

  // ---- copies of disks ----
  'ec2:CreateSnapshot': [CAP.SNAPSHOT],
  'ec2:CreateImage': [CAP.SNAPSHOT],
  'ec2:ModifySnapshotAttribute': [CAP.SHARE_EXTERNAL],
  'ec2:ModifyImageAttribute': [CAP.SHARE_EXTERNAL],
  'rds:CreateDBSnapshot': [CAP.SNAPSHOT],
  'rds:ModifyDBSnapshotAttribute': [CAP.SHARE_EXTERNAL],

  // ---- network ----
  'ec2:CreateRoute': [CAP.NETWORK_ROUTE],
  'ec2:ReplaceRoute': [CAP.NETWORK_ROUTE],
  'ec2:DeleteRoute': [CAP.NETWORK_ROUTE],
  'ec2:AttachInternetGateway': [CAP.NETWORK_ROUTE],
  'ec2:CreateInternetGateway': [CAP.NETWORK_ROUTE],
  'ec2:AuthorizeSecurityGroupIngress': [CAP.NETWORK_INGRESS],
  'ec2:AuthorizeSecurityGroupEgress': [CAP.NETWORK_INGRESS],
  'ec2:ModifyVpcEndpoint': [CAP.NETWORK_ROUTE],
  'ec2:DeleteVpc': [CAP.DELETE],
  'ec2:DeleteSubnet': [CAP.DELETE],
  'elasticloadbalancing:CreateLoadBalancer': [CAP.NETWORK_INGRESS],
  'elasticloadbalancing:SetSecurityGroups': [CAP.NETWORK_INGRESS],

  // ---- buying time ----
  'cloudtrail:StopLogging': [CAP.TAMPER_AUDIT],
  'cloudtrail:DeleteTrail': [CAP.TAMPER_AUDIT],
  'cloudtrail:UpdateTrail': [CAP.TAMPER_AUDIT],
  'logs:DeleteLogGroup': [CAP.TAMPER_AUDIT],
  'logs:DeleteLogStream': [CAP.TAMPER_AUDIT],
  'logs:PutRetentionPolicy': [CAP.TAMPER_AUDIT],
  'config:StopConfigurationRecorder': [CAP.TAMPER_AUDIT],
  'config:DeleteConfigurationRecorder': [CAP.TAMPER_AUDIT],
  'guardduty:DeleteDetector': [CAP.TAMPER_AUDIT],
  'guardduty:UpdateDetector': [CAP.TAMPER_AUDIT],
};

// The fallback, used only when the curated table has no entry. Deliberately coarse: it exists so a
// wide grant is not silently empty, not to be right about any particular action.
const VERBS = [
  ['Create', CAP.CREATE], ['Delete', CAP.DELETE], ['Terminate', CAP.DELETE],
  ['Remove', CAP.DELETE], ['Put', CAP.MODIFY_CONFIG], ['Update', CAP.MODIFY_CONFIG],
  ['Modify', CAP.MODIFY_CONFIG], ['Set', CAP.MODIFY_CONFIG], ['Attach', CAP.MODIFY_CONFIG],
  ['Detach', CAP.MODIFY_CONFIG], ['Associate', CAP.MODIFY_CONFIG],
  ['Disassociate', CAP.MODIFY_CONFIG], ['Register', CAP.CREATE], ['Deregister', CAP.DELETE],
  ['Invoke', CAP.INVOKE], ['Run', CAP.INVOKE], ['Execute', CAP.INVOKE],
  ['Start', CAP.STOP_START], ['Stop', CAP.STOP_START], ['Reboot', CAP.STOP_START],
  ['Tag', CAP.TAG], ['Untag', CAP.TAG],
];

/**
 * What this action lets you do. Always a set, never empty.
 *
 * Returns { caps, source } where source is 'curated', 'verb' or 'unmapped'. The source travels
 * because the three are worth very different amounts: a curated entry was decided, a verb match is
 * a guess that is wrong about one action in thirteen, and unmapped means nobody knows - which is
 * reported rather than absorbed into a bucket that looks like an answer.
 */
export function capabilitiesOf(action) {
  const curated = CURATED[action];
  if (curated) return { caps: curated, source: 'curated' };

  const name = action.slice(action.indexOf(':') + 1);
  for (const [verb, cap] of VERBS) {
    if (name.startsWith(verb)) return { caps: [cap], source: 'verb' };
  }
  return { caps: [CAP.UNMAPPED], source: 'unmapped' };
}
