// Everything this process does to S3, in one file.
//
// Credentials come from the instance profile through the SDK's default chain. There is no key in
// the environment and no credentials file, so a compromise of this host yields a role that can
// list two buckets, read them, and write one prefix - and nothing else.
//
// With the resource policy review turned on it can also NAME every bucket in this account and read
// their policies. That is a real widening of the sentence above and it is stated here rather than
// left to the template: a bucket policy is not object data, but it does describe who reaches the
// bucket, which is worth something to somebody who took this host. It buys the one question the
// review answers and it is off by default - see config.resourcePolicyReview. What the host still
// cannot do is WRITE a bucket policy, and that boundary is the point: a host that could edit one
// could open a bucket to the internet, which is a larger blast radius than an approval screen
// should carry.
//
// Every listing passes an explicit Prefix. On the state bucket that is not a nicety: the role's
// s3:ListBucket carries a condition on s3:prefix limiting it to plans/, so a listing without one
// is denied rather than filtered.

import { createHash } from 'node:crypto';
import {
  GetBucketPolicyCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export class S3Error extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
    // AccessDenied and NoSuchKey mean different things to a caller and the same thing to a stack
    // trace, so the name is kept where the caller can branch on it.
    this.awsCode = cause?.name ?? cause?.Code ?? 'Unknown';
  }
}

export function client(config) {
  return new S3Client({ region: config.region, maxAttempts: 4 });
}

export async function listPrefix(s3, bucket, prefix, { delimiter } = {}) {
  const out = [];
  let token;
  do {
    let page;
    try {
      page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
          Delimiter: delimiter,
        }),
      );
    } catch (err) {
      throw new S3Error(`list s3://${bucket}/${prefix} failed: ${err.message}`, err);
    }
    for (const item of page.Contents ?? []) {
      out.push({
        key: item.Key,
        size: item.Size,
        lastModified: item.LastModified?.toISOString() ?? null,
        // The ETag of a single-part upload is the MD5 of the body. Free here, where a digest
        // would otherwise cost a GetObject, so it is what identifies an object across a listing.
        // The approval marker carries a sha256 instead - see digest() - because that one has to
        // stand up to somebody replacing the plan on purpose.
        etag: (item.ETag ?? '').replaceAll('"', ''),
      });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function getBytes(s3, bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (err) {
    throw new S3Error(`get s3://${bucket}/${key} failed: ${err.message}`, err);
  }
}

export async function getText(s3, bucket, key) {
  return (await getBytes(s3, bucket, key)).toString('utf-8');
}

export async function getJson(s3, bucket, key) {
  const text = await getText(s3, bucket, key);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new S3Error(`s3://${bucket}/${key} is not JSON: ${err.message}`, err);
  }
}

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function putJson(s3, bucket, key, body) {
  const payload = Buffer.from(JSON.stringify(body, null, 2) + '\n', 'utf-8');
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: payload,
        ContentType: 'application/json',
        // No IfNoneMatch. Two reviewers deciding the same request is a race this cannot resolve
        // by failing one of them, because the loser would have no way to see which decision won.
        // The second write replaces the first and both are in CloudTrail, which is where the
        // question "who decided this" is actually answered.
      }),
    );
  } catch (err) {
    throw new S3Error(`put s3://${bucket}/${key} failed: ${err.message}`, err);
  }
  return payload.length;
}

/**
 * Every bucket in this account, by name.
 *
 * s3:ListAllMyBuckets is account-wide by construction - it takes no bucket and cannot be narrowed
 * to one - so this returns names and creation dates and nothing else. It is the picker's input; the
 * policy read below is a separate call against a bucket somebody chose.
 *
 * The region is NOT here. ListBuckets does not report one and asking for it per bucket would be a
 * GetBucketLocation on every bucket in the account to draw a list, so the caller learns the region
 * of the one bucket it goes on to read.
 */
export async function listBuckets(s3) {
  try {
    const page = await s3.send(new ListBucketsCommand({}));
    return (page.Buckets ?? [])
      .map((b) => ({ name: b.Name, createdAt: b.CreationDate?.toISOString() ?? null }))
      .filter((b) => b.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    throw new S3Error(`list buckets failed: ${err.message}`, err);
  }
}

/**
 * One bucket's policy as text, or null when it has none.
 *
 * The two are different facts and the caller must be able to tell them apart, which is why a bucket
 * with no policy is null rather than an empty document: no policy means nothing is granted across
 * accounts and nothing is denied here, and an empty document would be read as the second half only.
 *
 * NoSuchBucketPolicy is the ordinary answer for most buckets and is not an error. AccessDenied is,
 * and it is left to the caller - a bucket this host may not read the policy of must not be reported
 * as a bucket with no policy.
 */
export async function getBucketPolicy(s3, bucket) {
  try {
    const out = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    return typeof out.Policy === 'string' ? out.Policy : null;
  } catch (err) {
    const code = err?.name ?? err?.Code ?? '';
    if (code === 'NoSuchBucketPolicy') return null;
    throw new S3Error(`get policy of s3://${bucket} failed: ${err.message}`, err);
  }
}
