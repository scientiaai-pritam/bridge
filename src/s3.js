import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Local-dev flag. Set LOCAL_MODE=1 in bridge/.env (mirrors the API tier's
// aws.LOCAL_MODE). When set, the SDK uses explicit static credentials from env
// (needed because the default chain picks up the operator's AWS SSO profile
// instead of the web bucket's creds). In production (Lambda), leave it unset so
// the SDK falls back to the Lambda execution role.
const LOCAL_MODE = (process.env.LOCAL_MODE || process.env.IS_LOCAL || '').toLowerCase() === '1'
  || process.env.AWS_LAMBDA_FUNCTION_NAME === undefined;

let _client = null;
export function client() {
  if (_client) return _client;
  const cfg = {
    region: process.env.AWS_REGION || 'ap-south-1',
  };
  if (LOCAL_MODE) {
    const keyId = process.env.AWS_ACCESS_KEY_ID;
    const secret = process.env.AWS_SECRET_ACCESS_KEY;
    if (keyId && secret) {
      cfg.credentials = { accessKeyId: keyId, secretAccessKey: secret };
      // STS temporary credentials come as a triplet; the token is required.
      const token = process.env.AWS_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN_KEY;
      if (token) cfg.credentials.sessionToken = token;
    }
  }
  // else: production Lambda — rely on the default credential chain (execution role).
  _client = new S3Client(cfg);
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
