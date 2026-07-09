import { verifyWebhook, signForTest } from '../src/signing.js';

const SECRET = 'whsec_test';

describe('verifyWebhook', () => {
  test('accepts a correctly signed, fresh payload', () => {
    const body = JSON.stringify({ event: 'job.completed', request_id: 't1' });
    const ts = 1_700_000_000;
    const header = signForTest(body, SECRET, ts); // t=...,v1=...
    expect(verifyWebhook(body, header, SECRET, ts * 1000)).toBe(true);
  });

  test('rejects a tampered body', () => {
    const body = JSON.stringify({ event: 'job.completed', request_id: 't1' });
    const ts = 1_700_000_000;
    const header = signForTest(body, SECRET, ts);
    expect(verifyWebhook(body + '!', header, SECRET, ts * 1000)).toBe(false);
  });

  test('rejects a stale timestamp (outside 300s tolerance)', () => {
    const body = '{}';
    const ts = 1_700_000_000;
    const header = signForTest(body, SECRET, ts);
    expect(verifyWebhook(body, header, SECRET, (ts + 400) * 1000)).toBe(false);
  });

  test('rejects a malformed header', () => {
    expect(verifyWebhook('{}', 'not-a-valid-header', SECRET, 1_700_000_000_000)).toBe(false);
  });
});
