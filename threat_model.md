# Threat Model

## Project Overview

فَطِنة (Fatinah) is an Arabic-language multiplayer trivia game for families, deployed publicly at https://ata20.com. The backend is a Python stdlib HTTP server (`server.py`) that serves a single-page HTML app (`index.html`), calls the Anthropic Claude API to generate quiz questions, and manages RevenueCat/Apple IAP subscriptions via a local SQLite database with Firestore synchronisation. iOS users interact through a Capacitor-wrapped native app. The app is deployed on Replit as an autoscale deployment with public visibility. Stripe integration has been removed; Apple IAP via RevenueCat is the sole subscription payment method.

## Assets

- **Subscription records** — uid, email, RevenueCat app_user_id, status, promo expiry. Compromise allows granting or revoking premium access.
- **Promo codes** — discount codes that grant free premium access for a fixed duration. Brute-force enables free subscriptions.
- **Firebase ID tokens and UIDs** — user identifiers used as the primary auth mechanism server-side.
- **Firebase service account JSON** (`FIREBASE_SERVICE_ACCOUNT` env var) — grants Firestore write access.
- **Anthropic API key** (`ANTHROPIC_API_KEY`) — used to generate quiz questions; abuse leads to cost exhaustion.
- **RevenueCat webhook secret** (`REVENUECAT_WEBHOOK_SECRET`) — authorises RevenueCat webhook delivery; compromise allows forged subscription state changes.
- **User PII** — email addresses and display names stored in SQLite and Firestore.
- **ADMIN_SECRET** — guards admin endpoints (`/api/promo/admin`, `/api/admin/db-status`, `/api/auth/check-anonymous`).

## Trust Boundaries

- **Browser / iOS App → Server**: All HTTP requests cross here. The server verifies Firebase ID tokens (`uid_matches_token`) on all mutating endpoints. If `FIREBASE_PROJECT_ID` is unset `uid_matches_token` returns `False` (deny-by-default). **⚠️ If `GOOGLE_API_KEY` is unset while `FIREBASE_PROJECT_ID` is set, token verification is silently skipped — this is the current production state.**
- **Server → SQLite**: Direct file access on the same host. No network exposure.
- **Server → RevenueCat Webhook**: Webhook authenticity is verified via `hmac.compare_digest` of an Authorization header secret (no body HMAC; this is the RevenueCat model). Fail-closed: endpoint returns 503 if secret is not configured.
- **Server → Firebase/Firestore**: Service Account JWT-based auth for Firestore writes; Firebase Identity Toolkit REST for token verification.
- **Server → Anthropic Claude**: API key auth. No user-supplied data is used as shell input.
- **Public / Authenticated boundary**: All mutating POST endpoints (`/api/account/delete`, `/api/account/profile`, `/api/generate`, `/api/promo/redeem`, `/api/rc/link-identity`) require a valid Firebase ID token. Status GET endpoint (`/api/subscription/status`) also requires a Bearer token.
- **Admin boundary**: `/api/promo/admin` and `/api/admin/db-status` are gated by `X-Admin-Secret` (ADMIN_SECRET env var). `/api/auth/check-anonymous` requires the same secret.

## Scan Anchors

- **Production entry points**: `server.py` — `do_GET` (lines ~585–760) and `do_POST` (lines ~807–1350) handlers
- **Highest-risk areas**: promo redemption (`/api/promo/redeem`, line ~1030) — dual rate limiter (per-socket-IP + per-uid); RevenueCat webhook (`/api/revenuecat/webhook`, line ~1177); account delete (`/api/account/delete`, line ~881)
- **Auth enforcement**: `uid_matches_token()` (line 153) — deny-by-default when `FIREBASE_PROJECT_ID` is absent; **⚠️ bypass when `GOOGLE_API_KEY` is absent but `FIREBASE_PROJECT_ID` is set**
- **Admin surfaces**: `/api/promo/admin`, `/api/admin/db-status`, `/admin/promo` HTML page (UI served without auth but all operations require ADMIN_SECRET at API layer)
- **Dev-only**: `setup_stripe.py` (utility script, not served over HTTP)
- **Client-side code**: `index.html` fetches the RevenueCat iOS publishable key from `/api/rc-config`; Firebase client config from `/firebase-config.js`. No secrets hardcoded in HTML; `REVENUECAT_IOS_API_KEY` (appl_ prefix) is an intentionally public iOS publishable key.

## Threat Categories

### Spoofing

All mutating endpoints require a Firebase ID token verified via Identity Toolkit REST. `uid_matches_token` returns `False` by default when Firebase is not configured, preventing auth bypass in misconfigured environments.

**⚠️ ACTIVE ISSUE**: When `GOOGLE_API_KEY` is absent but `FIREBASE_PROJECT_ID` is set (current production state), `uid_matches_token` silently returns `True` for any non-empty uid with no token validation. An attacker who knows a victim's Firebase UID can invoke any authenticated endpoint on their behalf, including account deletion.

**Required guarantee**: Every endpoint that mutates state attributed to a specific uid MUST verify a valid Firebase ID token for that uid before executing. `GOOGLE_API_KEY` MUST be set in all production environments. ❌ Currently bypassed.

### Tampering

`/api/promo/redeem` requires a valid Firebase ID token and applies two rate limits: a primary per-account limit (10 attempts / 10 minutes per verified uid, checked after token verification) and a coarser per-IP abuse guard (100 attempts / 10 minutes) keyed on the real socket IP. The `X-Forwarded-For` header is ignored entirely.

The RevenueCat webhook resolves subscription updates through a pre-registered `revenuecat_identities` table rather than trusting any uid or email in the webhook payload directly, preventing spoofed webhooks from granting subscriptions to arbitrary accounts (as long as the webhook secret is not compromised).

**Required guarantee**: The rate limiter MUST key on the real socket IP (`self.client_address[0]`), ignoring `X-Forwarded-For`; per-account limit MUST also apply. ✅ Currently enforced.

### Information Disclosure

The `/legal/img/` path traversal was fixed in commit `e784ef9` using `os.path.basename` and `os.path.realpath` prefix checks.

Exception error propagation to clients has been fixed: all POST handlers now return generic error messages with a server-side `ref` ID rather than `str(e)`. ✅ Fixed.

`setup_stripe.py` prints the first 12 characters of the Stripe secret key when run by a developer — partial key prefix was removed in commit `dceb0b7`. Dev-only script, not HTTP-reachable.

**Required guarantee**: Exception messages MUST NOT be sent verbatim to clients in production. ✅ Enforced.

### Denial of Service

`/api/generate` requires a valid Firebase ID token and an active subscription (verified server-side from webhook-updated records). Rate limiting exists for promo redemption but not for generate or other endpoints.

**Required guarantee**: `/api/generate` SHOULD apply per-IP/per-uid rate limiting to limit cost exhaustion from subscribed users calling it in tight loops.

### Elevation of Privilege

The promo admin panel at `/admin/promo` serves an HTML page without authentication checks, but all operations it calls require `X-Admin-Secret` at the API layer — the UI exposure is informational only.

SQL queries use parameterised statements throughout; no SQL injection was identified.
