# tdai-bridge — deploy + end-to-end runbook (Phase 1 + Phase 3)

> Operator-only. These steps require AWS credentials, a deployed API tier,
> Firebase Admin credentials, and the dev web app. They are NOT executed in
> the build sandbox.

## Prerequisites

- `sam` CLI installed and configured (`sam --version`).
- AWS credentials with permission to create Lambda + Function URL.
- Firebase service-account JSON (project ID, client email, private key, DB URL).
- The API-tier stack already deployed, with its `WEBHOOK_SIGNING_SECRET` SSM
  parameter value on hand — the bridge must sign-verify with the *same* secret.
- Local bridge env (`.env`) populated from `.env.example`.

## Step 1 — Write template (done)

`bridge/template.yaml` exists. No operator action.

## Step 2 — Deploy the bridge stack (operator)

From the repo root:

```bash
cd bridge
sam build
sam deploy --guided \
  --stack-name tdai-bridge-dev \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
      WebhookSecret=<same as api-tier WEBHOOK_SIGNING_SECRET> \
      FirebaseProjectId=<firebase-project-id> \
      FirebaseClientEmail=<svc-account-email> \
      FirebasePrivateKey="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n" \
      FirebaseDatabaseUrl=https://<project>.firebaseio.com \
      WebS3Bucket=<web STORAGE_BUCKET_NAME, e.g. textile-designer-ai-development> \
      CloudfrontDomain=<your CloudFront domain, or leave blank> \
      UseCloudfront=<true|false>
```

Expected: stack `tdai-bridge-dev` reaches `CREATE_COMPLETE`, the `BridgeUrl`
output is `https://<id>.lambda-url.<region>.on.aws/`. Copy it — the web app
uses it as `BRIDGE_WEBHOOK_URL`.

> ESM note: `package.json` has `"type": "module"` and the handler uses
> `import`. If `sam build` fails on ESM, switch the handler to CommonJS
> (`require`) — the logic is identical.

## Step 3 — End-to-end round-trip verification (operator)

Set the dev web env:
- `API_TIER_INTERNAL_KEY`
- `API_TIER_BASE_URL`
- `BRIDGE_WEBHOOK_URL`  (the `BridgeUrl` output from Step 2)
- `FIREBASE_DATABASE_URL`

Then:

1. **Submit.** Authenticate as a dev user and
   `POST /api/tasks/submit-api-tier` with a tiny `input_base64` PNG and
   `tool:"upscale"`.
   Expect `202 { taskId, api_job_id, status:"processing" }`.

2. **Task doc.** Confirm the `tasks/{taskId}` Firestore doc has
   `provider:"api-tier"` and `api_job_id` set, and that RTDB `tasks/{uid}`
   has the pointer to this task.

3. **Wait for finalize.** The API tier runs the job and `WebhookFn` POSTs the
   bridge Function URL with the signed payload.

4. **Success path + output ingest (Phase 3).** Confirm CloudWatch logs on
   `tdai-bridge-dev` show a 200, and `tasks/{taskId}` transitions to
   `completed` WITH:
   - `results` = `[{ s3_key, cloudfront_url|presigned_url, url_type }]`
   - `s3_keys` = bare keys (same length as outputs)
   - `thumbnail_keys` = the `.webp` keys (same length)
   - `completed_at`, `total_duration_ms` (+ `queue_duration_ms` /
     `processing_duration_ms` if `processing_started_at` is on the doc).
   Then confirm the object actually exists in the web bucket:
   ```bash
   aws s3api head-object --bucket <WebS3Bucket> \
     --key tasks/<org_id>/upscale/<yyyy>/<mm>/<dd>/<user_id>/<taskId>/1.png
   ```
   And confirm the result image renders in the UI (resolved from `s3_key`
   via `/api/s3/get-presigned-url`). The UI's `listenToTask` fires `onCompleted`.

   **Thumbnail verification:** a separate event-listener Lambda generates the
   actual `.webp` thumbnails from the uploaded PNG (same as for legacy tasks).
   After the task completes, confirm the `.webp` object appears in the web
   bucket at the `thumbnail_keys` path (or that the library/favorites grid
   renders the thumbnail). If `.webp` objects do NOT appear, the thumbnail
   listener is not firing for these paths — file a follow-up (the bridge does
   not generate thumbnails itself).

5. **Failure path.** Submit an intentionally bad input that the provider
   rejects. Confirm `tasks/{taskId}` → `failed` with `error_message`, RTDB
   mirrored, and the bridge returned 200 (idempotent, no retry storm).

6. **Idempotency.** Re-POST the same webhook payload (e.g. replay from the
   API-tier DLQ, or `curl` the Function URL with a re-signed identical body).
   Confirm the bridge returns 200 with `{"ok":"already_terminal"}` and there
   is no double-write on `tasks/{taskId}` or RTDB.

## Step 4 — Commits (done)

The template, env example, and this runbook are committed on
`feat/api-tier-web-integration` (Phase 1 + Phase 3). Operator action: none —
this section documents what landed.
