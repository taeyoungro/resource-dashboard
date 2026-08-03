// Everything this process does to S3, in one file.
//
// Credentials come from the instance profile through the SDK's default chain. There is no key in
// the environment and no credentials file, so a compromise of this host yields a role that can
// list two buckets, read them, and write one prefix - and nothing else.
//
// Every listing passes an explicit Prefix. On the state bucket that is not a nicety: the role's
// s3:ListBucket carries a condition on s3:prefix limiting it to plans/, so a listing without one
// is denied rather than filtered.

import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
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
