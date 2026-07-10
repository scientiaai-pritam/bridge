import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let _client = null;
export function client() {
  if (_client) return _client;
  _client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    // Bridge runs with an execution role that has S3 access; static creds optional.
  });
  return _client;
}

export function bucket() {
  const b = process.env.AWS_S3_BUCKET || process.env.STORAGE_BUCKET_NAME;
  if (!b) throw new Error('AWS_S3_BUCKET (web storage bucket) is not configured');
  return b;
}

export const USE_CLOUDFRONT = () => (process.env.USE_CLOUDFRONT || '').toLowerCase() === 'true';
export function cloudfrontUrlFor(key) {
  const domain = process.env.CLOUDFRONT_DOMAIN || process.env.CDN_DOMAIN;
  if (!USE_CLOUDFRONT() || !domain) return null;
  const clean = key.startsWith('/') ? key.slice(1) : key;
  return `https://${domain}/${clean}`;
}

export async function uploadBytes(b, key, body, contentType) {
  await client().send(new PutObjectCommand({
    Bucket: b, Key: key, Body: body, ContentType: contentType || 'application/octet-stream',
  }));
}

export async function presignGet(b, key, expiresSec = 86400) {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: b, Key: key }), { expiresIn: expiresSec });
}
