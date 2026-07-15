# tdai-bridge

A single Node 20 AWS Lambda (HTTP Function URL) that **connects the public API tier
to the web app**, keeping **org credits in Firestore as the single ledger**.

```
 designer-ai-web  ──submit (unmetered key, x-request-id=taskId)──▶  designer-ai-api-tier
        │                                                                  │
        │ reserves/deducts                                                  │ runs tool,
        │ org credits in                                                    │ finalizes
        │ Firestore                                                         │
        │                                                                  ▼
        │   ◀──── signed webhook POST {event, job_id, tool, status, outputs, request_id} ──── finalize._deliver_webhook
        ▼
   THIS BRIDGE  ──▶ ingests outputs to web S3, writes terminal status + results
                   to Firestore tasks/{taskId} AND RTDB tasks/{uid}, settles
                   (deduct/release) the reserved org credits.
```

The API tier charges **0 credits** for the web's unmetered internal key; the bridge
settles the *web-catalog* cost against the org in Firestore so there is one book.

## What it does (per webhook)

1. **Verify** the `X-TDAI-Signature` HMAC (`src/signing.js`, mirrors the API tier's
   `sign_outbound`/`verify_outbound`). Bad/expired signature → 401.
2. **Correlate** via `payload.request_id` (= the web's Firestore `taskId`, sent by
   the web as `x-request-id`). Read `tasks/{taskId}` from Firestore.
3. **Idempotency gate** — if the task is already terminal (`completed`/`failed`),
   return 200 `{"ok":"already_terminal"}` and stop. Retries are safe.
4. **Ingest outputs** (success only) — download each signed output URL, upload to
   the web S3 bucket under the legacy key pattern
   `tasks/{org_id}/{type}/{yyyy}/{mm}/{dd}/{user_id}/{taskId}/{n}.{ext}`, build
   `results`/`s3_keys`/`thumbnail_keys`. A failure returns 500 so the API tier
   retries (S3 PutObject is idempotent).
5. **Write terminal status** to Firestore `tasks/{taskId}` **and mirror the full
   doc to RTDB `tasks/{uid}`** (the UI's RTDB listener can emit RTDB-only data, so
   RTDB must carry `results`/`s3_keys`, not just `status`).
6. **Settle credits** — `deductReserved` on success / `releaseReserved` on failure,
   each a Firestore transaction over `orgs` + `org_users` + `tasks`, idempotent via
   `tasks/{taskId}.credits_settled`. Mirror updated balances to RTDB.

Non-2xx on transient errors (bad ingest, Firestore write fail) forces the API tier's
retry; the terminal gate + `credits_settled` flag make retries safe.

## Layout

```
src/
  handler.js    # Lambda entry: verify → read → gate → ingest → write → settle
  signing.js    # HMAC verify (verifyWebhook) + test signer (signForTest)
  firebase.js   # lazy Admin SDK singleton (Firestore + RTDB)
  ingest.js     # download signed outputs → upload to web S3 → results/s3_keys/thumbnail_keys
  s3.js         # S3 client (static creds in LOCAL_MODE, execution role in prod)
  settle.js     # writeTerminalStatus + transactional deductReserved/releaseReserved
template.yaml   # SAM: Node 20 Lambda, Function URL (AuthType NONE), S3 policy, env
test/           # jest tests (handler, ingest, settle, signing)
dev-server.mjs  # LOCAL-ONLY HTTP wrapper (maps a request to the Function-URL event)
dev-fire-webhook.mjs  # LOCAL-ONLY webhook faker (signs + POSTs, exercises the real path)
local/create_local_resources.mjs  # LOCAL-ONLY moto SQS queue creator (legacy; not needed now)
RUNBOOK.md      # deploy + e2e verification steps
```

## Configuration (`.env` / `.env.example`)

| Var | Purpose |
|---|---|
| `WEBHOOK_SIGNING_SECRET` | HMAC secret — **must match** the API tier's (`WEBHOOK_SIGNING_SECRET` env / SSM). Mismatch → every webhook 401. |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` / `FIREBASE_DATABASE_URL` | Firebase Admin service account. Private key as single line with literal `\n` escapes (replaced at init). |
| `AWS_S3_BUCKET` | Web storage bucket (the web's `STORAGE_BUCKET_NAME`). Outputs land here. |
| `AWS_REGION` | Bucket/Lambda region (default `ap-south-1`). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN(_KEY)` | **LOCAL_MODE only.** Static creds for the web bucket. Production omits these and uses the Lambda execution role. STS temp keys (`ASIA…`) require the session token. |
| `LOCAL_MODE` / `IS_LOCAL` | `1` → use explicit static S3 creds. Auto-detected as local when `AWS_LAMBDA_FUNCTION_NAME` is unset. |
| `CLOUDFRONT_DOMAIN` / `USE_CLOUDFRONT` | Optional — make `results` carry a `cloudfront_url` instead of a presigned S3 URL. |

## Local end-to-end

The bridge has **no SQS dependency** — the API tier POSTs the webhook directly
(`finalize._deliver_webhook`). To run the full loop locally you need all three up.

```bash
# 1. moto (mock DDB/S3 for the API tier) — already used by the API tier
moto_server -p 5000

# 2. API tier (its own repo) — LOCAL_MODE makes dispatch + webhook synchronous
#    WEBHOOK_SIGNING_SECRET must equal the bridge's
cd ../designer-ai-api-tier && ./local/run_local.sh

# 3. bridge
cd ../bridge
node --env-file=.env dev-server.mjs     # listens on :9001

# 4. web (its own repo) — env: BRIDGE_WEBHOOK_URL=http://localhost:9001,
#    API_TIER_BASE_URL, API_TIER_INTERNAL_KEY, NEXT_PUBLIC_API_TIER_TOOLS=upscale
cd ../designer-ai-web/web && npm run dev
```

Then submit an `upscale` from the UI. Watch the bridge console for:
```
[bridge] WROTE firestore tasks/<id> status=completed keys=status,...,results,s3_keys,thumbnail_keys,...
[bridge] WROTE rtdb tasks/<uid> status=completed keys=<n>
```
Both lines + a 200 from the API tier (`[webhook] OK: bridge returned 200`) = success.

### Driving the webhook manually (no Replicate run)

`dev-fire-webhook.mjs` signs a payload with the same HMAC and POSTs it to the
bridge — useful to test the bridge in isolation:
```bash
node --env-file=.env dev-fire-webhook.mjs <taskId> [--event completed|failed] \
     [--output https://...] [--tool upscale] [--bridge http://localhost:9001]
```

## Deploy (production)

```bash
sam build
sam deploy --guided --stack-name tdai-bridge-dev --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    WebhookSecret=<same as api-tier WEBHOOK_SIGNING_SECRET> \
    FirebaseProjectId=... FirebaseClientEmail=... \
    FirebasePrivateKey="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n" \
    FirebaseDatabaseUrl=https://<project>.firebaseio.com \
    WebS3Bucket=<web STORAGE_BUCKET_NAME> \
    CloudfrontDomain=<optional> UseCloudfront=<true|false>
```
Output `BridgeUrl` → set as the web's `BRIDGE_WEBHOOK_URL`. Auth is HMAC
(Function URL `AuthType: NONE`); no API Gateway. See `RUNBOOK.md` for full e2e
verification. **No SQS queue or WebhookFn is needed** — the API tier POSTs the
bridge directly.

## Webhook contract

```
POST <BridgeUrl>/
X-TDAI-Signature: t=<unix-ts>,v1=<hmac-sha256 of "{ts}.{body}">
Content-Type: application/json

{"event":"job.completed|job.failed","job_id":"job_...","tool":"<public name>",
 "status":"completed|failed","outputs":[{"type":"png","url":"https://...","expires_in":3600}],
 "request_id":"<web taskId>"}
```
- `outputs` entries are **objects** (`{type,url,expires_in}`); the bridge also
  tolerates bare URL strings.
- 200 = handled (or already terminal). 500 = transient, API tier retries once.
- The bridge never echoes upstream internals; errors are generic envelopes.

## Tests

```bash
npm test   # jest (handler / ingest / settle / signing)
```
