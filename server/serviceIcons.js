// Which AWS service icon belongs to an IAM service prefix.
//
// The impact assessment names services the way IAM actions do - lambda, ec2, s3, states - and the
// icons extracted from the AWS Architecture Icons deck (tools/extract-aws-icons.mjs) are named the
// way AWS brands services - AWS-Lambda, Amazon-EC2, Amazon-Simple-Storage-Service,
// AWS-Step-Functions. Nothing derivable connects the two: s3 is Simple-Storage-Service, states is
// Step-Functions, logs is CloudWatch. So this is a table, the third of its kind here beside the
// console pages and for the same reason - there is no API to derive it from.
//
// An unmapped prefix gets NO icon, and that is the contract: the page renders nothing rather than
// a broken image or a guessed one. serviceIcons.test.js walks this table against the extracted
// files, so an entry pointing at an icon that does not exist fails the suite instead of a render.
//
// Only prefixes the governance pipeline can plausibly meet are mapped - the actions of the
// policies it governs, the services its own stacks use, and the common neighbours those policies
// reach through. Extending it is one line plus nothing else; the test checks the file exists.

export const SERVICE_ICONS = {
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
