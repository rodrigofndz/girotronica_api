# PROJECT_NAME API

Backend API for PROJECT_NAME. The frontend lives in FRONTEND_REPO.

## Stack

- **Hono** on Cloud Functions (2nd gen), TypeScript
- **Firestore** as the datastore — this API is the only thing that touches it
- **Firebase Auth** for identity; this API verifies ID tokens and enforces roles
- **Stripe** for payments, webhook handled by a separate function

## Endpoints

Deployed as two functions:

- `api` — the Hono app, all routes under `/api`
- `stripeWebhook` — Stripe events, unauthenticated, signature-verified

Clients send `Authorization: Bearer <firebase-id-token>`.

## Authorization

Firestore rules deny everything. This API uses the Admin SDK, which
bypasses rules — so the auth middleware is the only thing protecting the
database. A route that skips it is fully exposed.

Roles are read from `users/{uid}.role` on each request.

## Local development

Requires Node NODE_VERSION, pnpm, and the Firebase CLI.

pnpm install
firebase emulators:start

Emulates Auth, Functions and Firestore. The API is served at
`http://127.0.0.1:5001/PROJECT_ID/REGION/api`.

For Stripe webhooks:

stripe listen --forward-to localhost:5001/PROJECT_ID/REGION/stripeWebhook

## Secrets

Managed with Secret Manager, not env files:

firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET

## Deploy

firebase deploy --only functions

