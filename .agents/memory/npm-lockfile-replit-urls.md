---
name: npm lockfile Replit firewall URLs
description: package-lock.json may bake http://package-firewall.replit.local/npm/ URLs that break npm install on the user's Mac
---
Rule: before pushing package-lock.json to GitHub, check for `package-firewall.replit.local` and replace with `https://registry.npmjs.org/` (sed; integrity hashes stay valid).
**Why:** the user builds the iOS app on his own Mac via git pull + npm install; Replit's internal registry URLs are unresolvable there (ENOTFOUND).
**How to apply:** any time npm/package changes happen in this repl, sanitize the lockfile before gitPush.
