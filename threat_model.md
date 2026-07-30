# Threat Model

## Project Overview

فَطِنة (Fatinah) is an Arabic-language multiplayer trivia game for families, deployed publicly at https://ata20.com. The backend is a Python stdlib HTTP server (`server.py`) that serves a single-page HTML app (`index.html`), calls the Anthropic Claude API to generate quiz questions, and manages Stripe and RevenueCat subscriptions via a local SQLite database with Firestore synchronisation. iOS users interact through a Capacitor-wrapped native app. The app is deployed on Replit as an autoscale deployment with public visibility.

## Assets

- **Subscription records** — uid, email, Stripe customer/subscription IDs, status, promo expiry. Compromise allows granting or revoking premium access.
- **Promo codes** — discount codes that grant free premium access for a fixed duration. Brute-force enables free subscriptions.
- **Firebase ID tokens and UIDs** — user identifiers used as the primary auth mechanism server-side.
- **Stripe secret key** — retrieved at runtime from Replit Connectors; if leaked, enables arbitrary billing operations.
- **Firebase service account JSON** (`FIREBASE_SERVICE_ACCOUNT` env var) — grants Firestore write access.
- **Anthropic API key** (`ANTHROPIC_API_KEY`) — used to generate quiz questions; abuse leads to cost exhaustion.
- **User PII** — email addresses and display names stored in SQLite and Firestore.

## Trust Boundaries

- **Browser / iOS App → Server**: All HTTP requests cross here. The server verifies Firebase ID tokens (`uid_matches_token`) on all mutating endpoints. If `FIREBASE_PROJECT_ID` is unset `uid_matches_token` returns `False` (deny-by-default).
- **Server → SQLite**: Direct file access on the same host. No network exposure.
- **Server → Stripe API**: HTTPS with secret key from Replit Connectors. Webhook authenticity is verified via HMAC-SHA256 with replay-attack protection (5-minute window).
- **Server → Firebase/Firestore**: Service Account JWT-based auth for Firestore writes; Firebase Identity Toolkit REST for token verification.
- **Server → Anthropic Claude**: API key auth. No user-supplied data is used as shell input.
- **Public / Authenticated boundary**: All mutating POST endpoints (`/api/account/delete`, `/api/account/profile`, `/api/generate`, `/api/promo/redeem`, `/api/stripe/create-checkout`) require a valid Firebase ID token. Status GET endpoints (`/api/stripe/status`, `/api/promo/status`) also require a Bearer token.
- **Admin boundary**: `/api/promo/admin` and `/api/admin/db-status` are gated by `X-Admin-Secret` (ADMIN_SECRET env var). `/api/auth/check-anonymous` requires the same secret.

## Scan Anchors

- **Production entry points**: `server.py` — `do_GET` (lines ~470–744) and `do_POST` (lines ~759–1400) handlers
- **Highest-risk areas**: promo redemption (`/api/promo/redeem`, line ~1094) — rate limiter is bypassable via X-Forwarded-For spoofing; checkout creation (`/api/stripe/create-checkout`, line ~900); account delete/profile (`/api/account/delete`, `/api/account/profile`)
- **Auth enforcement**: `uid_matches_token()` (line 142) — deny-by-default when `FIREBASE_PROJECT_ID` is absent
- **Admin surfaces**: `/api/promo/admin`, `/api/admin/db-status`, `/admin/promo` HTML page (UI served without auth but all operations require ADMIN_SECRET at API layer)
- **Dev-only**: `setup_stripe.py` (utility script, not served over HTTP)
- **Client-side code**: `index.html` fetches the RevenueCat publishable key from `/api/rc-config`; no secrets hardcoded in HTML

## Threat Categories

### Spoofing

All mutating endpoints now require a Firebase ID token verified via Identity Toolkit REST. `uid_matches_token` returns `False` by default when Firebase is not configured, preventing auth bypass in misconfigured environments.

**Required guarantee**: Every endpoint that mutates state attributed to a specific uid MUST verify a valid Firebase ID token for that uid before executing. ✅ Currently enforced.

### Tampering

`/api/promo/redeem` requires a valid Firebase ID token and applies a rate limit of 10 attempts per 10 minutes per IP. However, the rate limiter trusts the first value of the `X-Forwarded-For` header, which is fully attacker-controlled. An authenticated user can cycle through spoofed IPs to bypass the limit and enumerate valid promo codes.

**Required guarantee**: The rate limiter MUST key on the real socket IP (`self.client_address[0]`), ignoring `X-Forwarded-For` unless the request originates from a verified trusted proxy. ⚠️ Currently bypassable.

### Information Disclosure

The `/legal/img/` path traversal was fixed in commit `e784ef9` using `os.path.basename` and `os.path.realpath` prefix checks.

Error responses from several POST handlers propagate `str(e)` directly to the client (`/api/stripe/create-checkout` line 1002, `/api/promo/redeem` line 1169, `/api/promo/admin` line 1238). This may expose Stripe API error details, database paths, or internal state in unexpected failure scenarios.

**Required guarantee**: Exception messages MUST NOT be sent verbatim to clients in production. Return a generic error with a server-side log reference instead.

### Denial of Service

`/api/generate` requires a valid Firebase ID token and an active subscription (verified server-side from webhook-updated records). Rate limiting exists for promo redemption but not for other endpoints.

**Required guarantee**: `/api/generate` SHOULD also apply per-IP rate limiting to limit cost exhaustion from subscribed users calling it in tight loops.

### Elevation of Privilege

The promo admin panel at `/admin/promo` serves an HTML page without authentication checks, but all operations it calls require `X-Admin-Secret` at the API layer — the UI exposure is informational only.

SQL queries use parameterised statements throughout; no SQL injection was identified.
