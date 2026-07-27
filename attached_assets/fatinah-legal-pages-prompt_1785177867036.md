# Replit Prompt — Legal Pages for "فَطِنة" (Fatinah)

> انسخ كل ما هو تحت الخط والصقه في Replit Agent.
> عدّل القيم داخل `[[ ]]` قبل اللصق.

---

## PROJECT BRIEF

Build a small, production-quality static website that hosts the legal documents for my iOS game. It must be deployable on Replit and reachable at stable public URLs, because Apple App Store Connect requires a live Privacy Policy URL and a Terms of Use (EULA) URL.

### Fill these variables first (use them everywhere in the content)

```
APP_NAME_AR      = فَطِنة
APP_NAME_EN      = Fatinah
APP_TYPE         = Arabic-language party & trivia game for iOS
LEGAL_ENTITY     = [[ الاسم القانوني للشركة أو الاسم الشخصي ]]
COUNTRY          = Kuwait
SUPPORT_EMAIL    = [[ support@yourdomain.com ]]
PRIVACY_EMAIL    = [[ privacy@yourdomain.com ]]
WEBSITE          = [[ https://yourdomain.com ]]
EFFECTIVE_DATE   = [[ 2026-08-01 ]]
```

### Tech requirements

- Plain HTML + CSS. No frameworks, no build step, no database, no JS libraries.
- Files: `index.html`, `privacy.html`, `terms.html`, `styles.css`.
- Each legal page is **bilingual**: Arabic first (`dir="rtl"`, `lang="ar"`), then a full English version in the same page under `dir="ltr"`, with a sticky language toggle (AR / EN) that shows one and hides the other. No page reload.
- Fonts: system Arabic stack (`-apple-system, "SF Arabic", "Noto Sans Arabic", Tahoma, sans-serif`).
- Design: clean legal-document look — white background, dark text (#1a1a1a), max-width 760px, generous line-height (1.9), numbered sections with anchor links, a small table of contents at the top of each page, "Last updated" line under the title.
- Fully responsive, accessible (semantic `<h1>`–`<h3>`, proper heading order, contrast AA).
- `index.html` = simple landing page: app name, one-line description, and two large buttons linking to Privacy Policy and Terms of Use, plus the support email.
- Every page footer: © YEAR LEGAL_ENTITY · Support email · links to the other two pages.
- Add `robots.txt` allowing indexing, and a `<meta name="description">` on each page.
- Make sure the deployed URLs are clean: `/privacy` and `/terms` should work (add redirects or name files accordingly).

---

## CONTENT REQUIREMENTS — PRIVACY POLICY

Write it in the tone and structure used by major app publishers (formal, sectioned, plain-language summaries above dense clauses). Cover, at minimum:

1. **Introduction & scope** — who the data controller is (LEGAL_ENTITY, COUNTRY), what the app is, what the policy covers.
2. **Information we collect**, split into three clear buckets:
   - *Data you provide*: nickname/display name, team names, in-game content, support correspondence.
   - *Data collected automatically*: device model, OS version, app version, language, region, crash logs, session duration, feature usage, IP address (transient).
   - *Data we do NOT collect*: state explicitly that the game does not collect contacts, photos, precise location, health data, or microphone/camera input unless a feature is added later with in-app consent.
3. **Purchases and subscriptions** — all payments are processed by Apple; we never receive or store card numbers; we receive only an anonymized transaction/receipt identifier and subscription status.
4. **Third-party services** — include a table with columns: Service | Purpose | Data shared | Privacy policy link. Pre-fill rows for Apple (App Store / StoreKit / iCloud), and add clearly-marked `[[ADD IF USED]]` placeholder rows for analytics, crash reporting, and ads so I can delete or complete them.
5. **Legal bases for processing** (consent, contract performance, legitimate interests, legal obligation).
6. **Data sharing and disclosure** — no sale of personal data; disclosure only to service providers, for legal requirements, or in a business transfer.
7. **Data retention** — retention periods per category, and deletion on request.
8. **Security** — encryption in transit (TLS), access controls, honest statement that no method is 100% secure.
9. **Children's privacy** — the app is not directed at children under 13 (and under 16 in jurisdictions requiring it); no knowing collection from children; parental contact route for deletion. Include a note that this section must match the app's App Store age rating.
10. **Your rights** — access, correction, deletion, portability, objection, withdrawal of consent, complaint to a supervisory authority. Add explicit GDPR (EEA/UK) and CCPA/CPRA (California) subsections.
11. **Account and data deletion** — a dedicated, easy-to-find section explaining exactly how a user deletes their account and data both in-app and by emailing PRIVACY_EMAIL, with a stated response window (e.g. 30 days). This is required by App Store Guideline 5.1.1(v).
12. **International data transfers** — including transfers outside COUNTRY and safeguards used.
13. **Changes to this policy** — how users are notified, effective date handling.
14. **Contact** — LEGAL_ENTITY, COUNTRY, PRIVACY_EMAIL.

Add a short callout box at the top of the page: a 4-line plain-language summary of what the app collects and why.

---

## CONTENT REQUIREMENTS — TERMS OF USE (EULA)

Structure it as a custom EULA that satisfies Apple's requirements. Cover, at minimum:

1. **Acceptance of terms** — installing or using the app constitutes acceptance.
2. **License grant** — limited, non-exclusive, non-transferable, revocable license to use the app on Apple-branded devices owned or controlled by the user, per the App Store Terms of Service.
3. **Restrictions** — no reverse engineering, decompiling, modifying, reselling, renting, automating, scraping, or circumventing paid features.
4. **Eligibility and accounts** — minimum age, accuracy of information, responsibility for account activity.
5. **Subscriptions and auto-renewal** — this section must be explicit and complete:
   - Subscription title, duration options (monthly and annual with discount), and that pricing is shown in-app in local currency.
   - Payment is charged to the Apple ID account at confirmation of purchase.
   - Subscription auto-renews unless auto-renew is turned off at least 24 hours before the end of the current period.
   - The account is charged for renewal within 24 hours prior to the end of the current period.
   - The user can manage or cancel the subscription in their Apple ID Account Settings after purchase.
   - Unused portions of a free trial (if offered) are forfeited on purchase of a subscription.
   - Refunds are handled by Apple, not by us; include a link reference to Apple's refund request page.
6. **In-app purchases and virtual items** — no real-world value, non-transferable, no cash redemption.
7. **User-generated content** — users are responsible for names/answers/content they enter; prohibited content list; license we need to display it within the game; our right to remove it.
8. **Acceptable use / prohibited conduct** — cheating, exploiting bugs, harassment, illegal use, infringing IP.
9. **Intellectual property** — all game content, name, logo, questions, and design remain owned by LEGAL_ENTITY.
10. **Third-party terms** — use of the app is also subject to Apple's Licensed Application End User License Agreement and App Store terms.
11. **Availability and changes** — we may modify, suspend, or discontinue features or the app itself, and may update question content.
12. **Disclaimer of warranties** — provided "as is" and "as available," in capitalized or clearly-styled form.
13. **Limitation of liability** — capped, with the standard carve-outs for liability that cannot be excluded by law.
14. **Indemnification.**
15. **Termination** — by user (delete the app / cancel subscription) and by us (breach), and what survives termination.
16. **Apple-specific acknowledgments** — a dedicated numbered section stating that:
    - The agreement is between the user and LEGAL_ENTITY only, not Apple.
    - LEGAL_ENTITY, not Apple, is solely responsible for the app and its content.
    - Apple has no obligation to provide maintenance or support.
    - In case of failure to conform to warranty, the user may notify Apple for a refund of the purchase price; Apple has no other warranty obligation.
    - LEGAL_ENTITY is responsible for product liability, legal compliance, and third-party IP claims.
    - Apple and its subsidiaries are third-party beneficiaries of these terms and may enforce them.
    - The user represents they are not located in an embargoed country and are not on a prohibited-parties list.
17. **Governing law and disputes** — laws of COUNTRY, competent courts of COUNTRY.
18. **Changes to these terms** and **Contact information.**

---

## STYLE AND OUTPUT RULES

- The Arabic version must be fluent, formal legal Arabic — not a literal machine translation of the English. Both versions must carry the same legal meaning.
- Do not invent facts about data collection. Where a detail depends on my actual implementation, insert a clearly visible placeholder in the format `[[ADJUST: ...]]` instead of guessing.
- Do not copy text from any existing company's policy; write original text.
- Number every section and give each an `id` so I can deep-link to it.
- When you finish, print a short checklist of every `[[ ]]` placeholder that still needs my input, grouped by file.
