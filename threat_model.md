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
- **RevenueCat public key** (`appl_` prefix) — client-side iOS IAP key, not secret by design; served via `/server-config.js` from env var `RC_API_KEY`.
- **SQLite database** (`subscriptions.db`) — contains subscription records, promo redemptions, question bank, player stats.

## Trust Boundaries

- **Browser/iOS app → Server** — all client requests are untrusted. Firebase token verification is the primary trust mechanism; `uid` must always be derived from the verified token, never from the request body.
- **Server → Anthropic API** — paid outbound call. Rate-limited (20 req / 5 min per uid) and requires authenticated callers.
- **Server → Firebase Identity Toolkit** — used to verify tokens; server caches results for 5 minutes.
- **Server → Stripe API** — payment operations; key must be secret.
- **Public vs. Authenticated endpoints** — all data/action endpoints now require `Authorization: Bearer <idToken>`. `/api/generate`, `/api/promo/redeem`, and `/api/promo/status` were previously unauthenticated and have since been fixed.

## Scan Anchors

- **Production entry points:** `server.py` (`Handler.do_GET`, `Handler.do_POST`) — single HTTP handler for all routes on port 5000.
- **Highest-risk areas:**
  - `/api/stats/sync`, `/api/family/sync`, `/api/promo/redeem` — missing body-size limits (DoS risk for authenticated callers)
  - `/api/promo/redeem` — raw exception details (`str(e)`) returned in 500 responses
  - `/api/promo/admin` — protected by `X-Admin-Secret` header vs env var `ADMIN_SECRET`
  - `_rate_buckets` dict in `rate_limited()` — accessed by multiple threads without a lock (race condition, minor rate-limit bypass risk)
- **Public surface:** `/`, `/firebase-config.js`, `/server-config.js`, `/privacy`, `/terms`, `/legal/**`, `/robots.txt`, `/vendor/*.js`, `/admin/promo` (HTML only), `/download/index.html`
- **Authenticated surface:** `/api/generate`, `/api/family/list`, `/api/family/sync`, `/api/family/delete`, `/api/family/purge`, `/api/stats/sync`, `/api/seen/sync`, `/api/promo/redeem`, `/api/promo/status`, `/api/account/delete`
- **Admin surface:** `/api/promo/admin` (X-Admin-Secret)
- **Dev/setup only:** `setup_stripe.py`, `functions/index.js` (Firebase Cloud Function backup)

## Threat Categories

### Spoofing / Authentication

All protected endpoints verify Firebase ID tokens server-side via `verify_firebase_token()`. The `uid` is derived exclusively from the verified token — it is never accepted from the request body or query string. Previously unauthenticated endpoints (`/api/generate`, `/api/promo/redeem`, `/api/promo/status`) were fixed in commit `0a51426`.

### Elevation of Privilege

`/api/promo/admin` is protected by a shared secret (`ADMIN_SECRET`). If this env var is not set, the endpoint fails closed (returns 403 to all). The admin HTML page (`/admin/promo`) is served unauthenticated but is UI-only — the actual API requires the secret.

### Denial of Service / Financial Abuse

`/api/generate` has authentication and a per-user rate limit (20 requests per 5-minute window). However, `/api/stats/sync`, `/api/family/sync`, `/api/promo/redeem`, and `/api/account/delete` have **no body-size cap**, unlike `/api/seen/sync` and `/api/generate` which enforce 64 KB. An authenticated user can send a multi-GB body to exhaust server memory. Rate limiting uses an in-memory dict (`_rate_buckets`) accessed by multiple threads without a lock, introducing a minor race condition.

### Information Disclosure

The `/api/promo/redeem` and `/api/promo/admin` handlers return raw `str(e)` from caught exceptions in 500 responses, potentially leaking SQLite error messages, table names, or constraint names. All other handlers use generic error text. The `GOOGLE_API_KEY` (Firebase web API key) is served to clients via `/firebase-config.js` — this is intentional for Firebase Web SDK. The RevenueCat public key is served via `/server-config.js` from env var `RC_API_KEY` — this is intentional per RevenueCat's design.

### Tampering

Stats sync (`/api/stats/sync`) uses `MAX()` to take the higher of server vs client values. A malicious authenticated user can inflate their own stats. This is a game integrity issue, not a security boundary violation between users.

### Cryptography / Secrets

No plaintext passwords. Firebase tokens are validated via HTTPS. SQLite database is on the local filesystem (Replit persistent storage). The RevenueCat public key is served from env var (no longer hardcoded in source).
