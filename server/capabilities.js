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
  /**
   * Turning off a control that would otherwise have refused something.
   *
   * Its own capability because it changes no resource and reaches no data - it changes what the
   * NEXT call is allowed to do. ec2:DisableSnapshotBlockPublicAccess is the clearest case: it grants
   * nothing at all, and it is the reason a later ModifySnapshotAttribute succeeds. A grant holding
   * both is not two findings, it is one path with its gate already removed.
   *
   * Distinct from tamper-audit, which removes the RECORD rather than the control - one buys time
   * after the fact, this one clears the way before it.
   */
  DISABLE_GUARDRAIL: 'disable-guardrail',
  /**
   * Seeing or redirecting traffic that was not addressed to you.
   *
   * Neither read-data nor network-ingress. The data is in flight rather than at rest, nothing is
   * opened to the outside, and the victim workload is untouched and unaware - a mirror session
   * copies packets off an interface that keeps working exactly as before.
   */
  INTERCEPT: 'intercept',
  /** Committing money. Not a breach; a bill, and one an approver is entitled to see coming. */
  SPEND: 'spend',
  /**
   * Re-pointing an existing binding at a different object.
   *
   * Its own capability because it is neither create nor modify: nothing new appears and the
   * resource's own configuration is untouched. What changes is WHICH object the resource is bound
   * to, and the new object's properties become the resource's properties at once.
   *
   * ec2:ReplaceRouteTableAssociation is the case that named it. A subnet is private because the
   * route table it is associated with has no default route to an internet gateway; re-associate it
   * with one that does and the subnet is public, without creating a route, touching a gateway or
   * modifying the subnet. Every action in the predicate of X-2 is absent from that sentence.
   *
   * Derived, never hand-listed: the table already marks these actions - the request names an
   * association id and the object at the other end is resolved from it, which is the same fact that
   * makes allow_only unsafe for them (projection 6, `deref:`). It was computed for the restriction
   * composer and the risk analysis never read it.
   */
  REBIND: 'rebind',
  UNMAPPED: 'unmapped',
};

/** Reference type names that identify a principal, for splitting what a permissions write reaches. */
const PRINCIPAL_TYPES = new Set(['role', 'user', 'group', 'instance-profile']);

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
  // Also spend: a fleet of instances is a bill whether or not it carries a role.
  'ec2:RunInstances': [CAP.CREATE, CAP.SPEND],
  'ec2:AssociateIamInstanceProfile': [CAP.REPLACE_IDENTITY],
  'ec2:ReplaceIamInstanceProfileAssociation': [CAP.REPLACE_IDENTITY],
  'ec2:CreateLaunchTemplateVersion': [CAP.MODIFY_CODE],
  'ec2:ModifyLaunchTemplate': [CAP.MODIFY_CODE],
  'lambda:UpdateFunctionCode': [CAP.MODIFY_CODE],
  'lambda:CreateFunction': [CAP.CREATE, CAP.MODIFY_CODE],
  // Can change the execution role, which is why it is not merely configuration - and can attach a
  // layer or move the handler, entry point and runtime, which changes what runs under a role that
  // stays put. One name, three meanings, and IAM separates none of them.
  'lambda:UpdateFunctionConfiguration': [CAP.MODIFY_CONFIG, CAP.REPLACE_IDENTITY, CAP.MODIFY_CODE],
  'lambda:InvokeFunction': [CAP.INVOKE],
  'lambda:InvokeFunctionUrl': [CAP.INVOKE],
  'lambda:InvokeAsync': [CAP.INVOKE],
  'lambda:AddPermission': [CAP.SHARE_EXTERNAL],
  'lambda:CreateFunctionUrlConfig': [CAP.SHARE_EXTERNAL],
  'lambda:DeleteFunction': [CAP.DELETE],
  'lambda:UpdateFunctionUrlConfig': [CAP.SHARE_EXTERNAL],
  // The newer resource-policy pair. PutResourcePolicy REPLACES the whole document rather than
  // appending a statement, so the one name both admits an outsider and wipes what was there.
  'lambda:PutResourcePolicy': [CAP.SHARE_EXTERNAL, CAP.DELETE],
  'lambda:AddLayerVersionPermission': [CAP.SHARE_EXTERNAL],
  // The three REVOCATIONS, curated to override a derivation that has them backwards.
  //
  // The reference gives all six of these actions access level 'Permissions management' on a
  // non-principal type, and derivedCapabilities turns that into share-external - correct for the
  // three above, exactly wrong for these. The cost was not theoretical: candidatePaths lists
  // share-external in the exfiltrate edge's targetless capabilities, so an action whose whole
  // effect is to DELETE a policy was being offered to an approver as one that opens contents to a
  // principal outside the account.
  'lambda:RemovePermission': [CAP.DELETE],
  'lambda:DeleteResourcePolicy': [CAP.DELETE],
  'lambda:RemoveLayerVersionPermission': [CAP.DELETE],
  // Reads whose RESPONSE is the material. Every one of these returns FunctionConfiguration, which
  // carries the environment variables in plaintext and the execution role ARN; GetFunction adds a
  // presigned download of the deployment package. The list forms take no target, so they answer for
  // every function at once, and reading a published version returns variables the current
  // configuration no longer has.
  'lambda:GetFunction': [CAP.READ_DATA, CAP.READ_SECRET],
  'lambda:GetFunctionConfiguration': [CAP.READ_DATA, CAP.READ_SECRET],
  'lambda:ListFunctions': [CAP.READ_DATA, CAP.READ_SECRET],
  'lambda:ListVersionsByFunction': [CAP.READ_DATA, CAP.READ_SECRET],
  'lambda:GetLayerVersion': [CAP.READ_DATA],
  // Re-pointings the derivation cannot see. Neither request resolves an association id - UpdateAlias
  // names the function and the alias, UpdateEventSourceMapping names its own mapping id - so both
  // fail the deref: test that CAP.REBIND is otherwise derived from, and both re-point a binding
  // anyway. UpdateAlias moves which version production traffic reaches without touching code;
  // UpdateEventSourceMapping carries FunctionName and cannot carry an event source at all, so the
  // only thing an update can move is which function a live stream is delivered to.
  'lambda:UpdateAlias': [CAP.REBIND],
  'lambda:UpdateEventSourceMapping': [CAP.REBIND, CAP.MODIFY_CONFIG],
  'lambda:PublishLayerVersion': [CAP.CREATE],
  'lambda:PublishVersion': [CAP.CREATE],
  // Code signing: the control that refuses an unsigned deployment. Deleting the attachment is the
  // obvious way off; rewriting the config's trusted publishers is the way THROUGH while it stays
  // attached. Both directions are curated for the same reason ec2:EnableSerialConsoleAccess and
  // ec2:DisableSerialConsoleAccess both are - the action is the control's write surface, and
  // whoever holds it decides what the control says.
  'lambda:DeleteFunctionCodeSigningConfig': [CAP.DISABLE_GUARDRAIL],
  'lambda:PutFunctionCodeSigningConfig': [CAP.DISABLE_GUARDRAIL],
  'lambda:UpdateCodeSigningConfig': [CAP.DISABLE_GUARDRAIL],
  'lambda:DeleteCodeSigningConfig': [CAP.DISABLE_GUARDRAIL],
  // The account-wide switch that decides whether a resource policy granting public access is
  // allowed to exist at all. Turning it off is what makes a later AddPermission with a wildcard
  // principal succeed, which is this capability's definition exactly.
  'lambda:PutPublicAccessBlockConfig': [CAP.DISABLE_GUARDRAIL],
  // Capacity and concurrency. Provisioned environments and a scaling floor are a standing bill;
  // reserved concurrency is not billed in either direction, so its only subject is availability.
  'lambda:PutProvisionedConcurrencyConfig': [CAP.SPEND],
  'lambda:PutFunctionScalingConfig': [CAP.SPEND, CAP.DELETE],
  'lambda:CreateCapacityProvider': [CAP.CREATE, CAP.SPEND],
  'lambda:UpdateCapacityProvider': [CAP.SPEND, CAP.DELETE],
  'lambda:DeleteCapacityProvider': [CAP.DELETE],
  'lambda:PutFunctionConcurrency': [CAP.DELETE],
  // Curated for VISIBILITY rather than for a rule. Under a whole-service grant the digest's fold
  // keeps an action only if a rule names it, the reference classifies it, or it is curated - so an
  // action the verb table cannot guess is deleted before the matcher ever sees it. Delete,
  // Put and Send match nothing useful here, and these would be invisible rather than coarse.
  'lambda:DeleteFunctionConcurrency': [CAP.MODIFY_CONFIG],
  'lambda:DeleteProvisionedConcurrencyConfig': [CAP.MODIFY_CONFIG],
  'lambda:DeleteFunctionEventInvokeConfig': [CAP.MODIFY_CONFIG],
  'lambda:PutFunctionRecursionConfig': [CAP.MODIFY_CONFIG],
  'lambda:PutRuntimeManagementConfig': [CAP.MODIFY_CONFIG],
  'lambda:DeleteLayerVersion': [CAP.DELETE],
  'lambda:StopDurableExecution': [CAP.DELETE],
  'lambda:PutFunctionEventInvokeConfig': [CAP.MODIFY_CONFIG, CAP.SHARE_EXTERNAL],
  'lambda:UpdateFunctionEventInvokeConfig': [CAP.MODIFY_CONFIG, CAP.SHARE_EXTERNAL],
  'lambda:GetDurableExecution': [CAP.READ_DATA],
  'lambda:GetDurableExecutionHistory': [CAP.READ_DATA],
  'lambda:SendDurableExecutionCallbackSuccess': [CAP.WRITE_DATA],
  'lambda:SendDurableExecutionCallbackFailure': [CAP.WRITE_DATA],
  'lambda:SendDurableExecutionCallbackHeartbeat': [CAP.WRITE_DATA],
  'lambda:CheckpointDurableExecution': [CAP.WRITE_DATA],
  // Managed instances and isolated execution environments. These sign as lambda and AWS writes
  // their IAM actions under the lambda prefix, so a grant of the whole service holds them.
  // RunMicrovm takes an execution role and starts the environment in one call, which is why E-1
  // treats it as a branch of its own rather than requiring a separate wake-up action. The two
  // token actions hand out a short-lived session onto something already running.
  'lambda:RunMicrovm': [CAP.CREATE, CAP.INVOKE, CAP.PASS_ROLE],
  'lambda:CreateMicrovmAuthToken': [CAP.MINT_CREDENTIAL],
  'lambda:CreateMicrovmShellAuthToken': [CAP.MINT_CREDENTIAL],
  'lambda:CreateMicrovmImage': [CAP.CREATE, CAP.MODIFY_CODE, CAP.PASS_ROLE],
  'lambda:UpdateMicrovmImage': [CAP.MODIFY_CODE],
  'lambda:TerminateMicrovm': [CAP.DELETE],
  'lambda:SuspendMicrovm': [CAP.STOP_START],
  'lambda:ResumeMicrovm': [CAP.STOP_START],
  // A network connector provisions an interface into a VPC subnet and decides what the environment
  // can reach and what can reach it, which is X-2's subject rather than a Lambda one.
  'lambda:CreateNetworkConnector': [CAP.CREATE, CAP.NETWORK_ROUTE, CAP.PASS_ROLE],
  'lambda:UpdateNetworkConnector': [CAP.MODIFY_CONFIG, CAP.NETWORK_ROUTE],
  'lambda:DeleteNetworkConnector': [CAP.DELETE],
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

  // ---- ec2, from the `ec2:*` path catalogue ----
  //
  // The classes below came from a hand-written cross-check of what `{"Action":"ec2:*"}` opens.
  // Every action named here was confirmed to exist against the shipped action table before being
  // added; the ones the catalogue flagged as unverified all exist, including
  // ec2:CreateVpcEncryptionControl.
  //
  // The distinction the catalogue is built on and that we did not have: an edge that needs
  // iam:PassRole is gated by PassRole analysis, and an edge that does NOT is open the moment ec2:*
  // is granted. Almost everything here is the second kind.

  // Turning a control off. None of these grants anything; each is why a later call succeeds.
  'ec2:DisableSnapshotBlockPublicAccess': [CAP.DISABLE_GUARDRAIL],
  'ec2:DisableImageBlockPublicAccess': [CAP.DISABLE_GUARDRAIL],
  'ec2:DisableEbsEncryptionByDefault': [CAP.DISABLE_GUARDRAIL],
  'ec2:ModifyEbsDefaultKmsKeyId': [CAP.DISABLE_GUARDRAIL],
  'ec2:ResetEbsDefaultKmsKeyId': [CAP.DISABLE_GUARDRAIL],
  'ec2:DisableAllowedImagesSettings': [CAP.DISABLE_GUARDRAIL],
  'ec2:ReplaceImageCriteriaInAllowedImagesSettings': [CAP.DISABLE_GUARDRAIL],
  'ec2:DisableImageDeregistrationProtection': [CAP.DISABLE_GUARDRAIL],
  'ec2:ModifyVpcBlockPublicAccessOptions': [CAP.DISABLE_GUARDRAIL],
  'ec2:CreateVpcBlockPublicAccessExclusion': [CAP.DISABLE_GUARDRAIL],
  // Re-enabling IMDSv1 or raising the hop limit. It steals nothing by itself; it restores the
  // condition under which an application-layer request forgery reaches the instance credential.
  // Verified against the request model: HttpTokens, HttpPutResponseHopLimit, HttpEndpoint.
  'ec2:ModifyInstanceMetadataOptions': [CAP.DISABLE_GUARDRAIL],
  // The same weakening set for every instance launched afterwards, at account scope.
  'ec2:ModifyInstanceMetadataDefaults': [CAP.DISABLE_GUARDRAIL],
  // The serial console. Opening it is a channel onto the instance that does not go through the
  // network at all, so nothing in a security group or a route table sees it.
  'ec2:EnableSerialConsoleAccess': [CAP.DISABLE_GUARDRAIL],
  'ec2:DisableSerialConsoleAccess': [CAP.DISABLE_GUARDRAIL],
  // The access control in front of an application, rewritten by the caller it is meant to gate.
  'ec2:ModifyVerifiedAccessEndpointPolicy': [CAP.DISABLE_GUARDRAIL],
  'ec2:ModifyVerifiedAccessGroupPolicy': [CAP.DISABLE_GUARDRAIL],
  'ec2:ModifyVerifiedAccessTrustProvider': [CAP.DISABLE_GUARDRAIL],
  // Encryption enforcement for a VPC.
  'ec2:CreateVpcEncryptionControl': [CAP.DISABLE_GUARDRAIL],
  'ec2:ModifyVpcEncryptionControl': [CAP.DISABLE_GUARDRAIL],
  'ec2:DeleteVpcEncryptionControl': [CAP.DISABLE_GUARDRAIL],
  'ec2:ModifyVpcBlockPublicAccessExclusion': [CAP.DISABLE_GUARDRAIL],
  'ec2:DeleteVpcBlockPublicAccessExclusion': [CAP.DISABLE_GUARDRAIL],

  // The record rather than the control.
  'ec2:DeleteFlowLogs': [CAP.TAMPER_AUDIT],

  // Traffic that was not addressed to you. The victim interface keeps working and is unaware.
  'ec2:CreateTrafficMirrorSession': [CAP.INTERCEPT],
  'ec2:CreateTrafficMirrorTarget': [CAP.INTERCEPT],
  'ec2:CreateTrafficMirrorFilter': [CAP.INTERCEPT],
  'ec2:ModifyTrafficMirrorSession': [CAP.INTERCEPT],
  // Re-pointing name resolution for a whole VPC.
  'ec2:CreateDhcpOptions': [CAP.INTERCEPT],
  'ec2:AssociateDhcpOptions': [CAP.INTERCEPT],

  // Ways in and out that the four existing entries did not name.
  'ec2:AssociateAddress': [CAP.NETWORK_INGRESS],
  'ec2:CreateNatGateway': [CAP.NETWORK_ROUTE],
  'ec2:CreateNetworkAclEntry': [CAP.NETWORK_INGRESS],
  'ec2:ReplaceNetworkAclEntry': [CAP.NETWORK_INGRESS],
  'ec2:ModifySubnetAttribute': [CAP.NETWORK_INGRESS],
  'ec2:AssignPrivateIpAddresses': [CAP.NETWORK_INGRESS],
  'ec2:AssignIpv6Addresses': [CAP.NETWORK_INGRESS],
  'ec2:ModifyManagedPrefixList': [CAP.NETWORK_INGRESS],
  'ec2:RestoreManagedPrefixListVersion': [CAP.NETWORK_INGRESS],
  'ec2:AuthorizeClientVpnIngress': [CAP.NETWORK_INGRESS],
  'ec2:CreateClientVpnEndpoint': [CAP.NETWORK_INGRESS],
  'ec2:CreateClientVpnRoute': [CAP.NETWORK_INGRESS],
  // Joining networks that were separate. A hub attachment reaches every VPC on the hub.
  'ec2:CreateVpcPeeringConnection': [CAP.NETWORK_ROUTE],
  'ec2:AcceptVpcPeeringConnection': [CAP.NETWORK_ROUTE],
  'ec2:CreateTransitGatewayVpcAttachment': [CAP.NETWORK_ROUTE],
  'ec2:CreateTransitGatewayRoute': [CAP.NETWORK_ROUTE],
  'ec2:AssociateTransitGatewayRouteTable': [CAP.NETWORK_ROUTE],
  'ec2:EnableTransitGatewayRouteTablePropagation': [CAP.NETWORK_ROUTE],
  'ec2:CreateVpnGateway': [CAP.NETWORK_ROUTE],
  'ec2:AttachVpnGateway': [CAP.NETWORK_ROUTE],
  'ec2:CreateCustomerGateway': [CAP.NETWORK_ROUTE],
  'ec2:CreateVpnConnection': [CAP.NETWORK_ROUTE],
  'ec2:EnableVgwRoutePropagation': [CAP.NETWORK_ROUTE],
  // An interface in two places at once is a bridge between them. Verified: AttachNetworkInterface
  // takes InstanceId and NetworkInterfaceId, so one instance can sit in two subnets.
  'ec2:CreateNetworkInterface': [CAP.NETWORK_ROUTE],
  'ec2:AttachNetworkInterface': [CAP.NETWORK_ROUTE],
  // Dynamic routing, on-premises routing, and the Wavelength edge. Each changes where traffic goes
  // without touching a route table entry by hand.
  'ec2:CreateRouteServer': [CAP.NETWORK_ROUTE],
  'ec2:EnableRouteServerPropagation': [CAP.NETWORK_ROUTE],
  'ec2:CreateLocalGatewayRoute': [CAP.NETWORK_ROUTE],
  'ec2:CreateCarrierGateway': [CAP.NETWORK_ROUTE],
  // Publishing an internal load balancer to other accounts through PrivateLink.
  'ec2:CreateVpcEndpointServiceConfiguration': [CAP.SHARE_EXTERNAL],
  'ec2:ModifyVpcEndpointServicePermissions': [CAP.SHARE_EXTERNAL],
  'ec2:AcceptVpcEndpointConnections': [CAP.SHARE_EXTERNAL],

  // Moving a disk image somewhere else, and getting deleted ones back.
  'ec2:ExportImage': [CAP.SHARE_EXTERNAL],
  'ec2:CreateStoreImageTask': [CAP.SHARE_EXTERNAL],
  'ec2:CreateRestoreImageTask': [CAP.SNAPSHOT],
  'ec2:RestoreSnapshotFromRecycleBin': [CAP.SNAPSHOT],
  'ec2:RestoreSnapshotTier': [CAP.SNAPSHOT],
  // Replacing the operating system while the instance keeps its id, addresses, interfaces and role.
  //
  // Stronger than the catalogue that named it says. It corrected an earlier draft with "the restore
  // source is limited to the original root snapshot or a matching AMI, so an arbitrary volume
  // cannot be injected" - and the current request model takes VolumeId, documented as "the ID of
  // the volume to use as the replacement root volume", constrained only to the same availability
  // zone, available state, and matching encryption. AWS widened the API after that was written.
  'ec2:CreateReplaceRootVolumeTask': [CAP.MODIFY_CODE],
  // A key pair is only injected into instances launched afterwards - it does not replace what an
  // existing instance already trusts - so this is a foothold on future capacity, not on current.
  'ec2:ImportKeyPair': [CAP.CREATE],

  // Removing what is running, or the connection to it, without terminating anything.
  'ec2:SendDiagnosticInterrupt': [CAP.DELETE],
  'ec2:RevokeSecurityGroupIngress': [CAP.DELETE],
  'ec2:RevokeSecurityGroupEgress': [CAP.DELETE],
  'ec2:DisassociateAddress': [CAP.DELETE],
  'ec2:ReleaseAddress': [CAP.DELETE],
  'ec2:UnassignPrivateIpAddresses': [CAP.DELETE],
  'ec2:DeleteNetworkInterface': [CAP.DELETE],
  'ec2:DetachNetworkInterface': [CAP.DELETE],
  'ec2:DetachVolume': [CAP.DELETE],
  'ec2:DeleteVolume': [CAP.DELETE],
  'ec2:DetachInternetGateway': [CAP.DELETE],
  'ec2:DeleteNatGateway': [CAP.DELETE],
  'ec2:DeleteRouteTable': [CAP.DELETE, CAP.NETWORK_ROUTE],
  'ec2:DeleteTransitGatewayVpcAttachment': [CAP.DELETE],
  'ec2:DeleteVpnConnection': [CAP.DELETE],
  'ec2:DeleteSecurityGroup': [CAP.DELETE],
  'ec2:DeleteVpcEndpoint': [CAP.DELETE],
  'ec2:DeregisterImage': [CAP.DELETE],
  'ec2:DisableImage': [CAP.DELETE],

  // Money. Capacity purchases and fleets commit spend without touching a single existing resource.
  'ec2:CreateFleet': [CAP.CREATE, CAP.SPEND],
  'ec2:RequestSpotFleet': [CAP.CREATE, CAP.SPEND],
  'ec2:RequestSpotInstances': [CAP.CREATE, CAP.SPEND],
  'ec2:CreateCapacityReservation': [CAP.SPEND],
  'ec2:CreateCapacityReservationFleet': [CAP.SPEND],
  'ec2:CreateCapacityReservationBySplitting': [CAP.SPEND],
  'ec2:MoveCapacityReservationInstances': [CAP.SPEND],
  'ec2:PurchaseCapacityBlock': [CAP.SPEND],
  'ec2:PurchaseReservedInstancesOffering': [CAP.SPEND],
  'ec2:PurchaseScheduledInstances': [CAP.SPEND],
  'ec2:PurchaseHostReservation': [CAP.SPEND],
  'ec2:AllocateAddress': [CAP.SPEND],
  'ec2:EnableFastSnapshotRestores': [CAP.SPEND],
  'ec2:MonitorInstances': [CAP.SPEND],

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
 * A lookup over the facts the assessment already carries about each action.
 *
 * The reference is built by the querier from the action table and travels inside impact.json, which
 * is how the dashboard learns an action's access level without holding the table. It was already
 * read for one thing - which actions AWS calls Tagging - and this widens that to everything it
 * knows: the level, the resource types, whether the action creates what it names, and the
 * allow_only verdict, whose `deref:` form is what identifies a rebinding.
 *
 * Returns null for an action the reference does not cover. That is a real case rather than a bug:
 * the reference is scoped to the services the assessment touched and is cut to a byte budget, so a
 * service the budget dropped has no entries and the caller falls back to the verb.
 */
export function referenceIndex(assessment) {
  const services = assessment?.action_reference?.services ?? {};
  const verdicts = assessment?.action_reference?.allow_only ?? {};
  return {
    get(action) {
      const colon = action.indexOf(':');
      if (colon < 0) return null;
      const service = action.slice(0, colon);
      const name = action.slice(colon + 1);
      const row = services[service]?.[name];
      if (!row) return null;
      return {
        // The action name without its service, which the rebinding check below reads.
        name,
        level: row[0] ?? null,
        types: row[1] ?? [],
        creates: row[2] === true,
        refuse: verdicts[service]?.[name]?.refuse ?? null,
      };
    },
  };
}

/**
 * What the reference alone establishes about an action, or [] when it establishes nothing.
 *
 * This is the half that scales. The curated table is 136 entries against 12,328 mutating actions,
 * and the verb fallback that carries the rest reads the first word - which puts 46% of them in a
 * bucket no attack-path edge consumes. Measured over the shipped table: 67% of the 415 actions AWS
 * itself labels Permissions management reach no edge, and sts:AssumeRoleWithSAML is one of them.
 *
 * The proof that this is the right source rather than a longer verb list is Tagging. The tag-tamper
 * path was unreachable for exactly this reason, it was fixed by reading the access level instead of
 * the verb, and Tagging now sits at 6% unreached against Write's 48%.
 */
export function derivedCapabilities(fact) {
  if (!fact) return [];
  const caps = [];
  // A re-pointing, and only that. See CAP.REBIND.
  //
  // `deref:` alone is too wide, and measuring it against the shipped table is what showed it: of
  // the 18 ec2 actions carrying it, three re-point a binding (Replace*Association), eight REMOVE
  // one (Disassociate*/Detach*, which is a deletion rather than a swap), and the rest merely take
  // an attachment id as an INPUT - ec2:CreateTransitGatewayMeteringPolicy names
  // MiddleboxAttachmentIds and re-points nothing at all. All eighteen are correctly unsafe for
  // allow_only, which is what the flag was computed for; only the first three are this capability.
  //
  // The discriminator is a name check ON TOP of a structural one, which is not the verb fallback
  // this file argues against: the structural fact is already established by the API model, and the
  // name only says which of three directions it goes. AWS is consistent here - a swap is
  // Replace<Thing>Association - and the check is narrow enough that a miss falls back to the
  // ordinary path rather than inventing a capability.
  if (typeof fact.refuse === 'string' && fact.refuse.startsWith('deref:')
      && /^Replace[A-Za-z]*Association$/.test(fact.name ?? '')) {
    caps.push(CAP.REBIND);
  }
  if (fact.level === 'Permissions management') {
    // Writing permissions ONTO a principal and opening a resource TO one are different paths with
    // different edges, and the level does not separate them - the resource types do. iam:PutRolePolicy
    // names a role; s3:PutBucketPolicy names a bucket and its effect is to admit somebody else.
    caps.push(fact.types.some((t) => PRINCIPAL_TYPES.has(t))
      ? CAP.WRITE_POLICY : CAP.SHARE_EXTERNAL);
  }
  if (fact.level === 'Tagging') caps.push(CAP.TAG);
  if (fact.creates) caps.push(CAP.CREATE);
  return caps;
}

/**
 * What this action lets you do. Always a set, never empty.
 *
 * Returns { caps, source } where source is 'curated', 'reference', 'verb' or 'unmapped'. The source
 * travels because the four are worth very different amounts: a curated entry was decided, a
 * reference entry is AWS's own published classification, a verb match is a guess that is wrong
 * about one action in thirteen, and unmapped means nobody knows - which is reported rather than
 * absorbed into a bucket that looks like an answer.
 *
 * Curated wins outright rather than being unioned with the reference. The 136 entries are the ones
 * a person decided BECAUSE the published facts do not show them - ec2:ModifyInstanceAttribute is
 * modify-code for one sub-attribute and no level says so - and letting a derivation add to them
 * would change 136 already-reasoned answers as a side effect of widening the other 12,192.
 */
export function capabilitiesOf(action, reference = null) {
  const curated = CURATED[action];
  if (curated) return { caps: curated, source: 'curated' };

  const derived = derivedCapabilities(reference?.get(action));
  if (derived.length) return { caps: derived, source: 'reference' };

  const name = action.slice(action.indexOf(':') + 1);
  for (const [verb, cap] of VERBS) {
    if (name.startsWith(verb)) return { caps: [cap], source: 'verb' };
  }
  return { caps: [CAP.UNMAPPED], source: 'unmapped' };
}
