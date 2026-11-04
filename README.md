# email-classified-agent

A small, stateless serverless agent that triages a personal Gmail inbox. Every new **unread** email in the inbox is classified by an LLM (via OpenRouter) into one of three Gmail labels that already exist in the account:

| Label              | Meaning                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Important Emails` | Needs the owner's attention or action, or is personally addressed and time-sensitive: messages from real people the owner corresponds with, bills / invoices / payment confirmations, account security alerts, bookings and appointments, delivery updates, replies in ongoing threads, mail from a bank, government, employer, school, doctor or landlord. |
| `Neutral Emails`   | Legitimate but low priority: newsletters the owner likely subscribed to, receipts for routine purchases, social network notifications, product updates, community digests, automated reports.                                                                                                                                                               |
| `Junk Emails`      | Unsolicited marketing, cold outreach, promotions the owner did not ask for, scams, phishing, "you've won", crypto / forex spam, SEO / link-building offers, anything deceptive or from an obviously fake sender.                                                                                                                                            |

Tie-break rules given to the model: when unsure between important and neutral, choose neutral; when unsure between neutral and junk, choose neutral; never choose junk for a message that appears to come from a real individual writing personally. The full prompt is in [`lib/classify.ts`](lib/classify.ts).

The agent **only adds a label**. It never marks mail as read, never moves, archives or deletes anything, and never creates labels. If classification fails, the email is left untouched and retried on the next pass.

Runs on the **Vercel Hobby (free) plan**, triggered by **Gmail push notifications via Google Cloud Pub/Sub**, with a daily cron as a safety net. Model: `nvidia/nemotron-3.5-lightning:free` through OpenRouter, with free fallbacks.

## Architecture

```
                 new mail arrives
                        │
                        ▼
   ┌──────────┐  users.watch   ┌────────────────┐   push subscription
   │  Gmail   │ ─────────────▶ │ Pub/Sub topic  │ ─────────────────────────┐
   └──────────┘                └────────────────┘                          │
        ▲                                                                  ▼
        │                                       POST https://<app>.vercel.app/api/gmail/notify?key=WEBHOOK_SECRET
        │                                                                  │
        │                                                                  ▼
        │                                            ┌──────────────────────────────────┐
        │   users.messages.list / get / modify       │  Vercel Function (Node.js)       │
        └─────────────────────────────────────────── │  1. verify secret, decode envelope│
                                                     │  2. processInbox():              │
   ┌──────────────┐  GET /api/cron/daily (daily)     │     find unread inbox mail with  │
   │ Vercel Cron  │ ───────────────────────────────▶ │     none of the 3 labels         │
   │ 0 3 * * *    │   Authorization: Bearer CRON_SECRET     classify each via OpenRouter │
   └──────────────┘   (also renews the Gmail watch)  │     add the matching label       │
                                                     └──────────────┬───────────────────┘
                                                                    │ POST /api/v1/chat/completions
                                                                    ▼
                                                     ┌──────────────────────────────────┐
                                                     │ OpenRouter                       │
                                                     │ nvidia/nemotron-3.5-lightning:free│
                                                     │ (+ fallbacks)                    │
                                                     └──────────────────────────────────┘
```

**Stateless by design.** There is no database and no history-ID tracking. An email is "unprocessed" if it is in the inbox, unread, newer than `LOOKBACK_DAYS`, and carries none of the three labels. The label itself is the processed marker. Every invocation, whether from a push notification or the daily cron, runs exactly the same loop:

```
labelIds = getLabelIds()                       # names → IDs, cached per invocation
ids      = findUnprocessed(labelIds)           # newest first, at most MAX_EMAILS_PER_RUN
for id in ids (sequentially):
    msg   = getMessage(id, "full")
    email = extract(msg)                       # from, subject, date, body, attachment names
    label = classify(email)                    # RateLimitedError → log and stop this run
    if label is None: skip
    fresh = getMessage(id, "minimal")          # re-check right before writing
    if fresh already has one of the 3 labels: skip (another run won the race)
    applyLabel(id, labelIds[label])            # addLabelIds only, never removeLabelIds
```

Pub/Sub's `historyId` is decoded and logged but never used.

## Repo layout

```
api/gmail/notify.ts     Pub/Sub push target
api/cron/daily.ts       watch renewal + safety sweep
lib/config.ts           env loading + validation (fails fast, names every problem)
lib/gmail.ts            OAuth client, label lookup, search, fetch, apply label, watch
lib/extract.ts          MIME walk → {from, subject, date, body, attachmentNames}
lib/classify.ts         OpenRouter call, forced tool call, fallback chain, 429 handling
lib/process.ts          the shared loop above
lib/runtime.ts          wires real Gmail + OpenRouter from config (mocked in handler tests)
lib/http.ts             constant-time secret check, bearer parsing, Pub/Sub envelope parsing
lib/logger.ts           structured JSON logger
scripts/                one-time OAuth flow, local sweep, local watch registration
tests/                  vitest unit tests; all network calls are mocked
```

## Prerequisites

- Node.js 22 (the project pins `engines.node` to `22.x`; Vercel also offers 24 and 26).
- A personal `@gmail.com` account with the three labels already created (Gmail → Settings → Labels → Create new label). Names are configurable through `LABEL_*`.
- Accounts on Google Cloud, Vercel (Hobby) and OpenRouter.

```bash
npm install
cp .env.example .env
```

## Setup, step by step

### 1. Google Cloud project and APIs

1. Open <https://console.cloud.google.com/> and create a project (top bar → project picker → **New project**).
2. **APIs & Services → Library**: search for and **Enable** both
   - **Gmail API**
   - **Cloud Pub/Sub API**

### 2. OAuth consent screen (publish it!)

1. **APIs & Services → OAuth consent screen** (in newer consoles this lives under **Google Auth Platform → Branding / Audience**).
2. User type: **External**. Fill in app name, support email and developer email. No scopes need to be added on this screen for the flow to work; the script requests `gmail.modify` at runtime.
3. Under **Audience / Test users** add your Gmail address.
4. **Publish the app** (set publishing status to **In production**) and confirm.

   Why: while the consent screen is in **Testing** status, Google issues refresh tokens that **expire after 7 days** ([docs](https://developers.google.com/identity/protocols/oauth2#expiration)). In production status the refresh token lasts until revoked (or unused for six months, or after a password change). Publishing an app that uses a sensitive Gmail scope normally triggers a verification request; you can ignore it for a single-user personal app. The consequence is an **"Google hasn't verified this app"** warning the first time you authorise. Click **Advanced → Go to <app name> (unsafe)** once, during step 3 below.

5. Create the OAuth client **after** publishing (next step) so the client is issued under the production consent screen.

### 3. OAuth client and refresh token

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Desktop app**. Name it anything. Create.
3. Copy the **Client ID** and **Client secret** into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. On your laptop run

   ```bash
   npm run token
   ```

   The script starts a listener on `http://127.0.0.1:53682` (override with `OAUTH_PORT`), prints an authorisation URL, and asks for the `https://www.googleapis.com/auth/gmail.modify` scope with `access_type=offline` and `prompt=consent`. Open the URL, pick the Gmail account to triage, click through the unverified-app warning, and approve. The refresh token is printed to the terminal and nowhere else.

   Desktop-app clients use the loopback redirect, so no redirect URI has to be registered in the console. If Google ever reports `redirect_uri_mismatch`, create a **Web application** client instead and add `http://127.0.0.1:53682` under _Authorised redirect URIs_.

5. Put the value into `.env` as `GOOGLE_REFRESH_TOKEN` and later into Vercel. Never commit it (`.gitignore` already excludes `.env`).

### 4. Pub/Sub topic and push subscription

1. **Pub/Sub → Topics → Create topic**, e.g. `gmail-push`. Note the full name `projects/<project-id>/topics/gmail-push`; that is `PUBSUB_TOPIC`.
2. Grant Gmail permission to publish: open the topic → **Permissions** (or the info panel) → **Add principal** → principal `gmail-api-push@system.gserviceaccount.com`, role **Pub/Sub Publisher** (`roles/pubsub.publisher`) → Save.
3. Generate the two secrets now (step 8) because the push URL contains one of them.
4. **Pub/Sub → Subscriptions → Create subscription**:
   - Topic: the one above.
   - Delivery type: **Push**.
   - Endpoint URL: `https://<your-app>.vercel.app/api/gmail/notify?key=<WEBHOOK_SECRET>`
     (you will know `<your-app>` after the first Vercel deploy in step 5; create the subscription afterwards or edit the endpoint later).
   - **Acknowledgement deadline: 600 seconds** (the maximum). The function may run for up to 300 s (`maxDuration`, see below); the ack deadline must be at least that or Pub/Sub will redeliver while the function is still working.
   - Leave "Enable authentication" off; the `?key=` secret protects the endpoint.
   - Message retention and expiration can stay at their defaults.

### 5. Vercel

1. Push this repo to GitHub, then on <https://vercel.com/new> **Import** it. Framework preset: **Other**. No build command or output directory is needed.
2. **Project → Settings → Environment Variables**: add every variable from `.env.example` for the **Production** environment (at least the required ones; see the table below). `CRON_SECRET` must use exactly that name, because Vercel sends it automatically on cron invocations.
3. Deploy (Vercel deploys on import and on every push to the default branch).
4. Confirm the project uses **Fluid compute** (Project → Settings → Functions). It is the default for new projects. With Fluid compute the Hobby plan allows `maxDuration` up to **300 s**, which `vercel.json` sets for every function under `api/`. Without Fluid compute the Hobby ceiling is lower; re-check the [limits page](https://vercel.com/docs/functions/limitations) and reduce the value in `vercel.json` if your deploy fails validation.
5. Cron jobs run **only on the production deployment**. Hobby allows at most **one run per day** and may trigger it anywhere within the scheduled hour; `vercel.json` schedules `/api/cron/daily` at `0 3 * * *` UTC. Vercel never retries a failed cron run.

### 6. OpenRouter

1. Create a key at <https://openrouter.ai/keys> → `OPENROUTER_API_KEY`.
2. Free-tier limits for `:free` models ([docs](https://openrouter.ai/docs/api-reference/limits)): **20 requests per minute**, and **50 requests per day** until you have purchased at least **$10** of credits once, after which it is **1000 requests per day**. `MAX_EMAILS_PER_RUN=15` keeps a single invocation under the per-minute limit. On HTTP 429 the agent stops the current run and leaves the rest for the next notification or the daily sweep.
3. Data retention: NVIDIA's free endpoints (and most `:free` endpoints) may log and train on prompts. OpenRouter will refuse to route to such endpoints unless your account privacy settings allow it: <https://openrouter.ai/settings/privacy> → enable training/logging-permitted providers. Symptom when it is off: HTTP 404 "No endpoints found matching your data policy", which the agent treats as a model failure and falls through the fallback chain.
4. Alternative: the paid `nvidia/nemotron-3.5-lightning` (no `:free` suffix) has no free-tier limits and a stricter data policy. Set `OPENROUTER_MODEL=nvidia/nemotron-3.5-lightning` and buy a few dollars of credits.

### 7. First run

Either locally (uses `.env`):

```bash
npm run watch
```

```bash
npm run sweep
```

or against the deployment:

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/cron/daily
```

`watch` / the cron route registers the Gmail watch and prints its expiration (about 7 days out). `sweep` prints a summary like `{"scanned":12,"labeled":11,"skipped":1,"failed":0,"rateLimited":false}`. After that, send yourself a test email and watch the Vercel function logs for `notify.received` followed by `process.labeled`.

### 8. Generating the secrets

```bash
openssl rand -hex 32
```

Run it twice: one value for `WEBHOOK_SECRET` (goes into the Pub/Sub push URL and Vercel env) and one for `CRON_SECRET` (Vercel env only).

## Environment variables

All are read and validated in [`lib/config.ts`](lib/config.ts). If a required one is missing, the handlers log the full list of problems and return HTTP 500.

| Name                         | Required | Default                                                                    | Purpose                                                                  |
| ---------------------------- | -------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GOOGLE_CLIENT_ID`           | yes      |                                                                            | OAuth client ID                                                          |
| `GOOGLE_CLIENT_SECRET`       | yes      |                                                                            | OAuth client secret                                                      |
| `GOOGLE_REFRESH_TOKEN`       | yes      |                                                                            | Refresh token from `npm run token`                                       |
| `PUBSUB_TOPIC`               | yes      |                                                                            | `projects/<id>/topics/<name>` passed to `users.watch`                    |
| `GMAIL_ADDRESS`              | no       |                                                                            | If set, notifications for any other address are acknowledged but ignored |
| `WEBHOOK_SECRET`             | yes      |                                                                            | Must equal `?key=` on the notify route                                   |
| `CRON_SECRET`                | yes      |                                                                            | Vercel sends `Authorization: Bearer <CRON_SECRET>` to cron routes        |
| `OPENROUTER_API_KEY`         | yes      |                                                                            | OpenRouter key                                                           |
| `OPENROUTER_MODEL`           | no       | `nvidia/nemotron-3.5-lightning:free`                                       | Primary model                                                            |
| `OPENROUTER_FALLBACK_MODELS` | no       | `xingchen-agi/xing4.0-29b-a4b:free,nvidia/nemotron-3-ultra-550b-a55b:free` | Comma-separated fallbacks, tried in order                                |
| `LABEL_IMPORTANT`            | no       | `Important Emails`                                                         | Gmail label name                                                         |
| `LABEL_NEUTRAL`              | no       | `Neutral Emails`                                                           | Gmail label name                                                         |
| `LABEL_JUNK`                 | no       | `Junk Emails`                                                              | Gmail label name                                                         |
| `MAX_EMAILS_PER_RUN`         | no       | `15`                                                                       | Classification calls per invocation                                      |
| `LOOKBACK_DAYS`              | no       | `7`                                                                        | Only consider mail newer than this                                       |
| `BODY_MAX_CHARS`             | no       | `4000`                                                                     | Body truncation before classification                                    |

## Endpoints

### `POST /api/gmail/notify?key=<WEBHOOK_SECRET>`

| Status | When                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| 405    | Method is not POST                                                                                                    |
| 500    | Configuration invalid (body lists the problems)                                                                       |
| 401    | `key` missing or wrong (constant-time comparison)                                                                     |
| 400    | Body is not a Pub/Sub push envelope (`message.data` must be base64 JSON with `emailAddress` and `historyId`)          |
| 200    | Envelope accepted. Always 200 from here on, even if processing fails, so Pub/Sub does not retry. Body has the summary |

### `GET /api/cron/daily` with `Authorization: Bearer <CRON_SECRET>`

Renews the Gmail watch, then runs the sweep. Returns `{ ok, watch: { expiration, historyId }, watchError, summary, sweepError }`; 200 when both steps succeeded, 500 otherwise (the sweep still runs if the watch renewal fails).

## Classification details

- Structured output is enforced with **tool calling**: a single tool `set_label` whose only parameter `label` is an enum of the three values, and `tool_choice` forcing that tool. `response_format` / JSON mode is deliberately not used because free hosts may not support it.
- Reasoning is turned off with OpenRouter's `reasoning: { enabled: false }` parameter; `temperature` is 0 and `max_tokens` is 256.
- If the response has no usable tool call, the text content is scanned for exactly one of the three words (case-insensitive). Still ambiguous → the email is skipped.
- Fallback chain: each request sends `model` plus OpenRouter's native `models` array (primary followed by the remaining fallbacks) so provider-side errors are rerouted by OpenRouter itself. If the request still fails client-side (HTTP 404 / 5xx, network error, 20 s timeout, non-JSON or unparseable response), the agent re-issues the request starting from the next model in the chain.
- HTTP 429 throws `RateLimitedError` immediately (logging `Retry-After` when present) and the loop stops for this invocation. The function never sleeps and retries.
- HTTP 401/403 stops the run as a fatal configuration error.
- Headers `HTTP-Referer` (this repo's URL) and `X-Title` (`email-classified-agent`) are sent for OpenRouter app attribution.
- The email body is passed as untrusted data and the system prompt tells the model to ignore instructions inside it.

## Local testing without Pub/Sub

```bash
npm run sweep
```

reads `.env`, runs the same loop as the deployed function once against your real inbox, and prints the summary. Nothing else is required; no watch, topic or deployment. Use it to check labels, credentials and the OpenRouter key before wiring up Pub/Sub.

Other scripts:

| Script              | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `npm run token`     | One-time OAuth flow; prints the refresh token         |
| `npm run watch`     | Calls `users.watch` once and prints the expiration    |
| `npm run dev`       | `vercel dev` for local HTTP testing of the two routes |
| `npm test`          | vitest (all network mocked)                           |
| `npm run lint`      | eslint                                                |
| `npm run typecheck` | `tsc --noEmit`                                        |
| `npm run format`    | prettier                                              |

## Known limitations and behaviours

- **Emails you read before the agent runs are never labelled.** The query is `is:unread`, on purpose: if you already opened it, you have triaged it yourself.
- **Mail older than `LOOKBACK_DAYS` (7) is ignored**, so a long outage leaves older unread mail unlabelled. Raise the value temporarily and run `npm run sweep` to catch up.
- **Per-run cap.** At most `MAX_EMAILS_PER_RUN` emails are classified per invocation and at most 200 list candidates are inspected. A burst larger than that is drained over the next notifications and the daily sweep.
- **Gmail's own "Important" marker is unrelated** to the `Important Emails` label. The system label `IMPORTANT` is never used for exclusion.
- **Watch expiry.** The Gmail watch lasts 7 days. The daily cron renews it, but Hobby cron delivery is best effort. Symptom: no `notify.received` log lines for new mail; the daily sweep still labels mail once a day. Fix: run `npm run watch` or call `/api/cron/daily` manually, and check the cron logs in Vercel → Project → Settings → Cron Jobs → View Logs.
- **Refresh-token expiry.** Symptom: every invocation fails with `invalid_grant` from Google and returns 500 / `ok:false`. Causes: consent screen still in Testing status (7-day expiry), you revoked the app, changed your Google password, or the token was unused for six months. Fix: make sure the consent screen is **In production**, run `npm run token` again and update `GOOGLE_REFRESH_TOKEN` in Vercel.
- **Rate limits.** With fewer than $10 of OpenRouter credits ever purchased, the free tier allows 50 requests per day. A busy inbox will exhaust that; unclassified mail simply waits. Buy $10 once or switch to the paid model.
- **Duplicate work.** Pub/Sub may deliver more than once and a notification can overlap the daily cron. The pre-write re-check in the loop keeps this harmless, at the cost of an occasional wasted classification call.
- **No alerting.** Failures are only visible in Vercel runtime logs (structured JSON lines) and in the cron job's response body.
- **Misclassification happens.** Move the email to the right label by hand; the agent never touches a message that already has one of the three labels.

## Verify before deploy

Everything below was checked against official documentation from this build environment on 2026-11-04 unless marked otherwise. Items marked **unverified** could not be confirmed from docs and should be checked on first deploy.

Confirmed from docs:

- Vercel Hobby with Fluid compute: `maxDuration` default and maximum **300 s** ([limits](https://vercel.com/docs/functions/limitations)); `vercel.json` `functions` glob `api/**/*.ts` with `maxDuration` ([vercel.json](https://vercel.com/docs/project-configuration/vercel-json)); Hobby crons once per day, hourly precision, production only, `CRON_SECRET` sent as `Authorization: Bearer …` ([cron docs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)).
- Gmail `users.watch` body `topicName`, `labelIds`, `labelFilterBehavior` (`labelFilterAction` is deprecated); `expiration` is epoch milliseconds; renew at least every 7 days; publisher principal `gmail-api-push@system.gserviceaccount.com` ([watch](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch), [push guide](https://developers.google.com/workspace/gmail/api/guides/push)).
- Gmail `users.messages.modify` takes `addLabelIds` / `removeLabelIds` and accepts the `gmail.modify` scope; `format=minimal` returns ID and labels, `format=full` returns the parsed `payload`.
- Pub/Sub push: 102/200/201/202/204 count as ack; ack deadline 10 to 600 s ([push](https://docs.cloud.google.com/pubsub/docs/push), [subscription properties](https://docs.cloud.google.com/pubsub/docs/subscription-properties)).
- OpenRouter: `reasoning: { enabled: false }` (and `effort: "none"`) disables reasoning ([reasoning tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens)); `models` array is the native fallback list and the response `model` field says which model answered ([model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)); forced tool choice shape `{"type":"function","function":{"name":…}}` ([tool calling](https://openrouter.ai/docs/guides/features/tool-calling)); free-tier limits 20/min and 50/day → 1000/day after $10 of credits ([limits](https://openrouter.ai/docs/api-reference/limits)); `X-Title` is accepted as an alias of `X-OpenRouter-Title`.
- The three model IDs exist on OpenRouter's public model list and all advertise `tools`, `tool_choice` and `reasoning` support. `nvidia/nemotron-3.5-lightning:free` does **not** advertise `response_format`, which is why tool calling is used.
- Google: refresh tokens issued under a consent screen in **Testing** status expire after 7 days; the limit is 100 live refresh tokens per client ([OAuth2 docs](https://developers.google.com/identity/protocols/oauth2#expiration)).

**Unverified** (check on first deploy):

1. Sending `model` together with `models` in one request. The fallback docs show only `models`; this project sends both so the primary is explicit. If OpenRouter rejects the combination, delete the `model` key in `buildRequestBody` in `lib/classify.ts` (the first entry of `models` is the primary anyway).
2. `reasoning: { enabled: false }` on NVIDIA's free endpoints specifically. The parameter is documented and the models advertise `reasoning` support, but per-model behaviour was not exercised. If a request is rejected with a 400 mentioning reasoning, switch to `reasoning: { effort: "none" }`.
3. Whether `users.messages.list` returns newest first. The docs do not state an order. The agent additionally sorts by `internalDate` from the `minimal` fetch when present; if `minimal` ever omits `internalDate`, the API order is kept as is.
4. Loopback redirect without console registration for **Desktop app** OAuth clients. Google's native-app docs describe the loopback flow for desktop clients but do not say explicitly that no registration is required. The fallback is described in setup step 3.
5. Vercel's Node.js builder with `"type": "module"` and NodeNext-style `.js` import specifiers resolving to `.ts` files outside `api/`. This is standard TypeScript behaviour and `tsc`, `tsx` and vitest all resolve it, but it was not exercised on a real Vercel build. After the first deploy, call `/api/cron/daily` with the bearer token and confirm a JSON response.
6. The exact Google Cloud console menu names. Google renames these regularly ("OAuth consent screen" is becoming "Google Auth Platform"); the steps are correct in substance.

## Development

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run typecheck
```

Tests cover extraction (plain, HTML-only, nested multipart, base64url, entities, truncation, attachments), the classifier (tool-call parsing, text fallback, fallback chain on 404/5xx/timeout/network, 429 → `RateLimitedError`, request payload), Gmail helpers (`applyLabel` never sends `removeLabelIds`, client-side label exclusion, `MAX_EMAILS_PER_RUN`), the processing loop (race skip, rate-limit stop, per-email failure isolation, counts) and both handlers.
