# Threat Model

## Project Overview

فَطِنة (Fatinah) is an Arabic-language multiplayer trivia game for families, deployed publicly at https://ata20.com. The backend is a Python stdlib HTTP server (`server.py`) that serves a single-page HTML app (`index.html`), calls the Anthropic Claude API to generate quiz questions, and manages Stripe and RevenueCat subscriptions via a local SQLite database with Firestore synchronisation. iOS users interact through a Capacitor-wrapped native app. The app is deployed on Replit as an autoscale deployment with public visibility.

## Assets

- **Subscription records** — uid, email, Stripe customer/subscription IDs, status, promo expiry. Compromise allows granting or revoking premium access.
- **Promo codes** — discount codes that grant free premium access for a fixed duration. Exposure or brute-force enables free subscriptions.
- **Firebase ID tokens and UIDs** — user identifiers used as the primary auth mechanism server-side. Knowing a uid without a valid token is a meaningful step toward unauthorized mutation.
- **Stripe secret key** — retrieved at runtime from Replit Connectors; if leaked, enables arbitrary billing operations.
- **Firebase service account JSON** (`FIREBASE_SERVICE_ACCOUNT` env var) — grants Firestore write access. Leakage allows reading/writing subscription documents.
- **Anthropic API key** (`ANTHROPIC_API_KEY`) — used to generate quiz questions; abuse leads to cost exhaustion.
- **User PII** — email addresses and display names stored in SQLite and Firestore.

## Trust Boundaries

- **Browser / iOS App → Server**: All HTTP requests cross here. The server uses Firebase ID token verification (`uid_matches_token`) for mutating user-owned records on `/api/account/delete` and `/api/account/profile`, but several other endpoints accept a `uid` directly with no token check.
- **Server → SQLite**: Direct file access on the same host. No network exposure, but SQLite file is co-located in the workspace.
- **Server → Stripe API**: HTTPS with secret key from Replit Connectors. Webhook authenticity is verified via HMAC-SHA256.
- **Server → Firebase/Firestore**: Service Account JWT-based auth for Firestore writes; Firebase Identity Toolkit REST for token verification.
- **Server → Anthropic Claude**: API key auth. No user-supplied data is used as shell input.
- **Public / Authenticated boundary**: Most GET endpoints accept a raw `uid` query parameter with no token. Mutating endpoints (`/api/account/delete`, `/api/account/profile`) validate Firebase ID tokens. Admin endpoints require `X-Admin-Secret`.
- **Admin boundary**: `/api/promo/admin` and `/api/admin/db-status` are gated by `ADMIN_SECRET` header. `/api/auth/check-anonymous` is gated only if `ADMIN_SECRET` is set (bypassed if env var is absent).

## Scan Anchors

- **Production entry points**: `server.py` — `do_GET` and `do_POST` handlers (lines ~470–1175)
- **Highest-risk areas**: `/legal/img/` path traversal (line ~603), promo redemption (`/api/promo/redeem`, line ~963), checkout creation (`/api/stripe/create-checkout`, line ~795), account delete/profile (`/api/account/delete`, `/api/account/profile`)
- **Auth enforcement**: `uid_matches_token()` (line 130) — bypasses all checks if `FIREBASE_PROJECT_ID` env var is absent
- **Admin surfaces**: `/api/promo/admin`, `/api/admin/db-status`, `/admin/promo` HTML page
- **Dev-only**: `setup_stripe.py` (utility script, not served over HTTP)
- **Client-side code**: `index.html` contains the RevenueCat publishable key and all game logic

## Threat Categories

### Spoofing

The server verifies Firebase ID tokens via Identity Toolkit REST for account mutations. However, `/api/promo/redeem` and `/api/stripe/create-checkout` accept a caller-supplied `uid` without any token verification, allowing any client to act on behalf of any uid.

If `FIREBASE_PROJECT_ID` is unset, `uid_matches_token` returns `True` unconditionally, bypassing all auth on account delete and profile endpoints. In production Firebase is configured, mitigating this for deployed instances but not local/staging environments without the env var.

**Required guarantee**: Every endpoint that mutates state attributed to a specific uid MUST verify a valid Firebase ID token for that uid before executing.

### Tampering

Promo codes can be redeemed by any caller for any uid with no authentication. There is also no server-side rate limiting on `/api/promo/redeem`, enabling brute-force of short or sequential promo codes.

**Required guarantee**: `/api/promo/redeem` MUST require a Firebase ID token matching the uid. The endpoint MUST apply per-IP or per-uid rate limiting.

### Information Disclosure

The `/legal/img/` static file endpoint (lines 603–618 of `server.py`) uses unsanitized path components from the URL to build a filesystem path. An unauthenticated attacker can traverse into parent directories with `..` segments to read arbitrary files — including `subscriptions.db` (all PII and subscription data) and `server.py` (full source code).

`/api/stripe/status` and `/api/promo/status` return subscription and promo state for any uid supplied in the query string, without authentication. This leaks whether a specific user has an active paid or promo subscription.

Error responses from Stripe API calls propagate the raw exception string to the HTTP client (`str(e)`), which may include internal details.

**Required guarantee**: File-serving handlers MUST validate that the resolved path stays within the intended directory (e.g. using `os.path.realpath` and an allowlist prefix check). Status endpoints that expose per-user data SHOULD require at minimum a valid session token. Exception details MUST NOT be sent verbatim to clients.

### Denial of Service

`/api/generate` triggers an Anthropic Claude API call when the local question bank is empty, and is accessible without authentication. Repeated requests with unique topics exhaust the API key budget.

No per-IP rate limiting exists on any endpoint.

**Required guarantee**: `/api/generate` SHOULD be rate-limited per IP. Optionally, require a valid uid to call it.

### Elevation of Privilege

The promo admin panel at `/admin/promo` serves an HTML page without authentication. All sensitive operations are protected at the API layer (`/api/promo/admin`), but the admin UI itself is publicly accessible to anyone who knows the URL — informational but should be documented.

SQL queries use parameterised statements throughout; no SQL injection was identified.
