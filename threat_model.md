# Threat Model

## Project Overview

فَطِنة (Fatinah) is an Arabic-language family quiz game for web and iOS (Capacitor). The backend is a single-file Python stdlib HTTP server (`server.py`) serving a single-page app (`index.html`), providing AI question generation via Anthropic Claude, promo-code redemption, player stats sync, and family category sync. Authentication uses Firebase ID tokens verified server-side via the Identity Toolkit REST API. Subscriptions are managed via Stripe (web/server-side) and RevenueCat (iOS in-app purchases). Data is stored in a local SQLite database. The app is not currently deployed.

## Assets

- **Firebase ID tokens / sessions** — authenticate users for all protected endpoints. Compromise allows impersonation.
- **Player data** — stats, achievements, seen questions, family categories stored per uid. PII is minimal (email from Firebase sign-in).
- **Promo codes** — grant free premium access. Abuse allows unauthorized premium use or code exhaustion.
- **Anthropic API key** — paid per token. Abuse causes financial harm.
- **Stripe secret key** — allows payment operations. Must never appear in logs.
- **ADMIN_SECRET** — protects promo-code management (`/api/promo/admin`). If absent or leaked, admin actions become accessible.
- **RevenueCat public key** (`appl_` prefix) — client-side iOS IAP key, not secret by design, but hardcoded in source.
- **SQLite database** (`subscriptions.db`) — contains subscription records, promo redemptions, question bank, player stats.

## Trust Boundaries

- **Browser/iOS app → Server** — all client requests are untrusted. Firebase token verification is the primary trust mechanism; `uid` must always be derived from the verified token, never from the request body.
- **Server → Anthropic API** — paid outbound call. Should be rate-limited and require authenticated callers.
- **Server → Firebase Identity Toolkit** — used to verify tokens; server caches results for 5 minutes.
- **Server → Stripe API** — payment operations; key must be secret.
- **Public vs. Authenticated endpoints** — most data endpoints require `Authorization: Bearer <idToken>`; `/api/generate`, `/api/promo/redeem`, and `/api/promo/status` currently do not.

## Scan Anchors

- **Production entry points:** `server.py` (`Handler.do_GET`, `Handler.do_POST`) — single HTTP handler for all routes on port 5000.
- **Highest-risk areas:**
  - `/api/promo/redeem` — missing auth + client-supplied uid (IDOR)
  - `/api/promo/status` — missing auth, uid from query param
  - `/api/generate` — missing auth, triggers paid Anthropic API call
  - `/api/promo/admin` — protected by `X-Admin-Secret` header vs env var `ADMIN_SECRET`
- **Public surface:** `/`, `/firebase-config.js`, `/server-config.js`, `/privacy`, `/terms`, `/vendor/*.js`, `/admin/promo` (HTML only), `/api/generate`, `/api/promo/redeem`, `/api/promo/status`
- **Authenticated surface:** `/api/family/list`, `/api/family/sync`, `/api/family/delete`, `/api/family/purge`, `/api/stats/sync`, `/api/seen/sync`, `/api/account/delete`
- **Admin surface:** `/api/promo/admin` (X-Admin-Secret)
- **Dev/setup only:** `setup_stripe.py`, `functions/index.js` (Firebase Cloud Function backup)

## Threat Categories

### Spoofing / Broken Object-Level Authorization

The server correctly verifies Firebase tokens server-side for most endpoints by calling `verify_firebase_token()` and deriving uid from the token. However, `/api/promo/redeem` accepts uid from the request body without any token check, allowing an attacker to act as any uid. All user-scoped endpoints MUST derive uid exclusively from the verified token.

### Elevation of Privilege

`/api/promo/admin` is protected by a shared secret (`ADMIN_SECRET`). If this env var is not set, the endpoint fails closed (403 to all). The admin HTML page (`/admin/promo`) is served unauthenticated but is UI-only — the actual API requires the secret. This is acceptable, but the page existence reveals the admin interface location.

### Denial of Service / Financial Abuse

`/api/generate` is callable by unauthenticated users with no rate limiting. Each call can consume ~4 000 Anthropic tokens (claude-opus-4-5). Unlimited invocations cause unbounded API spend. Rate limiting and authentication are required.

### Information Disclosure

`/api/promo/status` exposes per-user promo subscription state to any caller with a uid. The `GOOGLE_API_KEY` (Firebase web API key) is served to clients via `/firebase-config.js` — this is intentional for Firebase Web SDK. Stripe partial key in `setup_stripe.py` stdout is low-risk but undesirable.

### Tampering

Stats sync (`/api/stats/sync`) uses `MAX()` to take the higher of server vs client values. A malicious authenticated user can inflate their own stats. This is a game integrity issue, not a security boundary violation between users.

### Cryptography / Secrets

No plaintext passwords. Firebase tokens are validated via HTTPS. SQLite database is on the local filesystem (Replit persistent storage). The RevenueCat public key is hardcoded in client source — acceptable per RevenueCat design but rotation is difficult.
