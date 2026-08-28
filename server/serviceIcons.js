// Which AWS service icon belongs to an IAM service prefix.
//
// The impact assessment names services the way IAM actions do - lambda, ec2, s3, states - and the
// icons extracted from the AWS Architecture Icons deck (tools/extract-aws-icons.mjs) are named the
// way AWS brands services - AWS-Lambda, Amazon-EC2, Amazon-Simple-Storage-Service,
// AWS-Step-Functions.
//
// This used to say nothing derivable connects the two, and be a hand table because of it. That was
// wrong, and the cost was measured: 62 prefixes mapped against the 455 that exist, reaching 54 of
// the 291 shipped icons - so 237 icons (81%) were carried and never rendered, and every service
// outside the 62 showed nothing at all. Silently, because an unmapped prefix is defined to render
// nothing. The join below covers 200 prefixes and reaches 174 of the icons.
//
// botocore carries the bridge. Every service model has a serviceFullName, which is the brand the
// icon files are named after, and an endpointPrefix and signingName, which are what IAM keys on:
//
//     ecr    -> "Amazon Elastic Container Registry"  -> Amazon-Elastic-Container-Registry.svg
//     events -> "Amazon EventBridge"                 -> Amazon-EventBridge.svg
//
// tools/build-service-icons.py does that join and writes serviceIcons.generated.js. It never
// guesses: a brand that does not match an icon FILE NAME produces no entry.
//
// What stays by hand is below, and it is now only what a generator cannot decide - a brand the
// deck spells differently (Managed Streaming for Kafka against Managed Streaming for APACHE
// Kafka), and the calls where one icon answers for several prefixes because they are one product
// to a reader. The overrides win wherever both have an answer.
//
// An unmapped prefix still gets NO icon, and that is still the contract: the page renders nothing
// rather than a broken image or a guessed one. serviceIcons.test.js walks the merged table against
// the extracted files, so an entry pointing at an icon that does not exist fails the suite.

import { GENERATED_SERVICE_ICONS } from './serviceIcons.generated.js';

/** Decisions the join cannot make, and the spellings it cannot bridge. Wins over the generated. */
export const SERVICE_ICON_OVERRIDES = {
  ec2: 'Amazon-EC2',
  s3: 'Amazon-Simple-Storage-Service',
  lambda: 'AWS-Lambda',
  iam: 'AWS-Identity-and-Access-Management',
  sso: 'AWS-IAM-Identity-Center',
  'sso-directory': 'AWS-IAM-Identity-Center',
  identitystore: 'AWS-IAM-Identity-Center',
  kms: 'AWS-Key-Management-Service',
  cloudformation: 'AWS-CloudFormation',
  dynamodb: 'Amazon-DynamoDB',
  sqs: 'Amazon-Simple-Queue-Service',
  sns: 'Amazon-Simple-Notification-Service',
  ecs: 'Amazon-Elastic-Container-Service',
  ecr: 'Amazon-Elastic-Container-Registry',
  eks: 'Amazon-Elastic-Kubernetes-Service',
  glue: 'AWS-Glue',
  athena: 'Amazon-Athena',
  rds: 'Amazon-RDS',
  elasticache: 'Amazon-ElastiCache',
  bedrock: 'Amazon-Bedrock',
  sagemaker: 'Amazon-SageMaker',
  redshift: 'Amazon-Redshift',
  emr: 'Amazon-EMR',
  kinesis: 'Amazon-Kinesis',
  firehose: 'Amazon-Kinesis-Firehose',
  // CloudWatch answers for three prefixes: metrics, logs, and synthetics all live under one brand.
  cloudwatch: 'Amazon-CloudWatch',
  logs: 'Amazon-CloudWatch',
  events: 'Amazon-EventBridge',
  scheduler: 'Amazon-EventBridge',
  states: 'AWS-Step-Functions',
  secretsmanager: 'AWS-Secrets-Manager',
  ssm: 'AWS-Systems-Manager',
  apigateway: 'Amazon-API-Gateway',
  'execute-api': 'Amazon-API-Gateway',
  cloudfront: 'Amazon-CloudFront',
  route53: 'Amazon-Route-53',
  elasticfilesystem: 'Amazon-EFS',
  elasticloadbalancing: 'Elastic-Load-Balancing',
  autoscaling: 'Amazon-EC2-Auto-Scaling',
  cloudtrail: 'AWS-CloudTrail',
  config: 'AWS-Config',
  organizations: 'AWS-Organizations',
  cognito: 'Amazon-Cognito',
  'cognito-idp': 'Amazon-Cognito',
  'cognito-identity': 'Amazon-Cognito',
  xray: 'AWS-X-Ray',
  batch: 'AWS-Batch',
  backup: 'AWS-Backup',
  guardduty: 'Amazon-GuardDuty',
  securityhub: 'AWS-Security-Hub',
  detective: 'Amazon-Detective',
  securitylake: 'Amazon-Security-Lake',
  fms: 'AWS-Firewall-Manager',
  'network-firewall': 'AWS-Network-Firewall',
  acm: 'AWS-Certificate-Manager',
  'acm-pca': 'AWS-Private-Certificate-Authority',
  cloudhsm: 'AWS-CloudHSM',
  inspector2: 'Amazon-Inspector',
  macie2: 'Amazon-Macie',
  waf: 'AWS-WAF',
  wafv2: 'AWS-WAF',
  shield: 'AWS-Shield',
  // The deck says "Apache Kafka" and botocore says "Kafka", and no normalisation should be asked
  // to invent a missing word - so the one join that fails on a spelling is made here.
  kafka: 'Amazon-Managed-Streaming-for-Apache-Kafka',
  'kafka-cluster': 'Amazon-Managed-Streaming-for-Apache-Kafka',
  // Aurora DSQL has no icon of its own in the deck. The family icon is the closest true answer:
  // the product is branded "Amazon Aurora DSQL", and an approver reading it under the Aurora mark
  // is being told something correct rather than nothing.
  dsql: 'Amazon-Aurora',
};

/**
 * The table the page reads: everything botocore could join, with the hand decisions on top.
 *
 * Merge order is the whole contract - an override exists precisely because the generated answer is
 * absent or not the one a reader should see.
 */
export const SERVICE_ICONS = { ...GENERATED_SERVICE_ICONS, ...SERVICE_ICON_OVERRIDES };

// Resource types whose PRODUCT is not the product their IAM prefix names.
//
// IAM files VPC under ec2 - the actions are ec2:*, Resource Explorer types the resources
// ec2:vpc - but AWS brands VPC as its own product with its own icon, and an approver reading
// "ec2:vpc" under an EC2 icon is being told the wrong product. The same split holds for the rest
// of the networking family that lives inside the ec2 prefix (PrivateLink, Transit Gateway,
// Site-to-Site VPN) and for EBS volumes.
//
// Keyed by the group's resource_type, consulted BEFORE the service table, and carrying ONLY the
// types whose brand differs from their prefix - a type absent here falls back to its service icon,
// which is the right answer for ec2:instance. The console-links table stays keyed as it is: an
// icon says what a thing IS, a link says where its list is, and volumes genuinely list in the EC2
// console while being branded EBS.
export const RESOURCE_TYPE_ICONS = {
  'ec2:vpc': 'Amazon-Virtual-Private-Cloud',
  'ec2:subnet': 'Amazon-Virtual-Private-Cloud',
  'ec2:route-table': 'Amazon-Virtual-Private-Cloud',
  'ec2:internet-gateway': 'Amazon-Virtual-Private-Cloud',
  'ec2:natgateway': 'Amazon-Virtual-Private-Cloud',
  'ec2:network-acl': 'Amazon-Virtual-Private-Cloud',
  'ec2:vpc-peering-connection': 'Amazon-Virtual-Private-Cloud',
  'ec2:vpc-endpoint': 'AWS-PrivateLink',
  'ec2:transit-gateway': 'AWS-Transit-Gateway',
  'ec2:transit-gateway-attachment': 'AWS-Transit-Gateway',
  'ec2:vpn-connection': 'AWS-Site-to-Site-VPN',
  'ec2:vpn-gateway': 'AWS-Site-to-Site-VPN',
  'ec2:volume': 'Amazon-Elastic-Block-Store',
  'ec2:snapshot': 'Amazon-Elastic-Block-Store',
};

/**
 * The static path of the icon for one IAM service prefix, or null.
 *
 * The path is under the site's own origin (vite's public directory), so nothing here goes into a
 * hostname and the lookup key is the only input - an unknown key is null, never a guessed file.
 */
export function serviceIconPath(servicePrefix) {
  const name = SERVICE_ICONS[String(servicePrefix).toLowerCase()];
  return name ? `/aws-icons/${name}.svg` : null;
}

/**
 * The icon for one resource-type group: the TYPE's own product when the brand differs from the
 * IAM prefix, the service's icon otherwise. resourceType may be absent - a policy summary line has
 * a service and no type - and then this is exactly serviceIconPath.
 */
export function resourceIconPath(servicePrefix, resourceType) {
  const byType = resourceType && RESOURCE_TYPE_ICONS[String(resourceType).toLowerCase()];
  if (byType) return `/aws-icons/${byType}.svg`;
  return serviceIconPath(servicePrefix);
}
