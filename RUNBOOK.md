# tdai-bridge — Phase 1 deploy + end-to-end runbook

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
      FirebaseDatabaseUrl=https://<project>.firebaseio.com
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

4. **Success path.** Confirm CloudWatch logs on `tdai-bridge-dev` show a 200,
   and `tasks/{taskId}` transitions to `completed`.
   (Phase 1: `s3_keys` / `results` are NOT yet populated — that arrives in
   Phase 3 with `bridge/src/ingest.js`. The UI's `listenToTask` should fire
   `onCompleted`.)

5. **Failure path.** Submit an intentionally bad input that the provider
   rejects. Confirm `tasks/{taskId}` → `failed` with `error_message`, RTDB
   mirrored, and the bridge returned 200 (idempotent, no retry storm).

6. **Idempotency.** Re-POST the same webhook payload (e.g. replay from the
   API-tier DLQ, or `curl` the Function URL with a re-signed identical body).
   Confirm the bridge returns 200 with `{"ok":"already_terminal"}` and there
   is no double-write on `tasks/{taskId}` or RTDB.

## Step 4 — Commit (done locally; git policy is no-commit in the sandbox)

```bash
git add bridge/template.yaml bridge/.env.example bridge/RUNBOOK.md
git commit -m "feat(bridge): SAM template + deploy + Phase-1 round-trip runbook"
```
