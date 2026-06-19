# Task Brief — Arabic copy review & brand voice guideline

> Supervisor sprint #2. Owner: **Hermes**.
> Deliver on branch `hermes/arabic-copy-brand`.

## Release-checklist links

- `3.1` — Arabic copy review for every user-visible string
- `5.31` — Brand voice guideline doc (for future copy consistency)

## Goal

The landing page and CRM currently have good Arabic, but:
1. Landing.tsx has some English-looking placeholders (WA_NUMBER, CALL_NUMBER are TODOs).
2. Brand voice isn't documented — every agent writes copy in a slightly different style.
3. The landing page has `تابعة للمجموعة الذهبية المتحدة` which is correct but the brand is BreeXe Pro — need to verify consistency.
4. Error toasts, form labels, and UX copy need a native Arabic audit.

Polish all user-visible Arabic text and produce a brand voice guideline so future copy stays consistent.

## Files of interest

- `src/pages/Landing.tsx` — all user-visible strings (hero text, services, trust strip, about section, form labels, errors, footer)
- `public/quotation-template.html` — PDF quote template (title, headers, labels, fine print)
- `docs/brand-identity.md` — existing brand doc (read for reference)
- All CRM pages in `src/pages/` and `src/components/` for string audit

## Inputs you can rely on

- Brand: BreeXe Pro (بريكس برو) — Royal Blue + Champagne Gold, Tajawal font
- Target audience: Saudi homeowners, property managers, small business owners
- Channel: WhatsApp-first, phone calls, lead forms
- Formality level: professional but warm — not overly formal, not slang

## What to build

### Step 1 — Audit existing Arabic copy

Read these files and flag every user-visible string that needs attention:

**Landing.tsx:**
- [ ] `WA_NUMBER = "966500000000"` — needs a real number (or at least a more realistic placeholder)
- [ ] `CALL_NUMBER = "+966****0000"` — same
- [ ] Hero: `تابعة للمجموعة الذهبية المتحدة` — is this wording correct? (The user previously confirmed BreeXe Pro IS owned by United Golden Group — if so, keep it)
- [ ] Hero subtitle: `حلول متكاملة في فلاتر المياه والمضخات والتبريد` — clear and compelling? Suggest improvements.
- [ ] Trust strip: `+"1,200" عميل سعيد` — the `+` and comma format look awkward in Arabic. Suggest `أكثر من ١٢٠٠ عميل سعيد`.
- [ ] About section: full paragraph review — does it match brand voice?
- [ ] Form placeholder: `مثلاً: المنزل دور أرضي، فيه ٤ أفراد، أبي فلتر تحت المغسلة` — good example but verify the word `أبي` is correct Saudi dialect?
- [ ] Error toast: `تعذر إرسال طلبك الآن. جرب واتساب أو الاتصال المباشر.` — does it match UX tone?
- [ ] Success message: `شكراً لتواصلك` + `سنرد عليك قريباً.` — warm enough?
- [ ] Privacy & Terms links in form — file these actually exist (`/legal/privacy`, `/legal/terms`). If not, the links are 404.

**quotation-template.html:**
- [ ] `نظام عروض الأسعار - جولدن برو` — the brand says BreeXe Pro now; title should reflect that
- [ ] All form labels, headers, and fine print

**CRM pages (src/pages/ and src/components/):**
- [ ] `src/pages/Quotes.tsx` — Arabic strings
- [ ] `src/pages/WhatsAppConsole.tsx` — Arabic strings
- [ ] `src/pages/AdminUsers.tsx` — Arabic strings
- [ ] `src/components/ReminderDashboard.tsx` — Arabic strings
- [ ] `src/components/UserRoleBadge.tsx` — Arabic strings
- [ ] `src/App.tsx` — global UI text (sidebar, nav, header)

### Step 2 — Apply fixes

For each flagged item, produce the exact corrected string (or mark it as OK). If the string is in a `.tsx`/`.ts` file, create a patch that replaces the old string with the corrected one.

### Step 3 — Brand voice guideline

Create `docs/brand-voice.md` with:
- Brand personality (3 adjectives)
- Formality level
- Saudi Arabic conventions (use of numbers vs Arabic numerals, إعراب level, dialect choices)
- "Do say" / "Don't say" examples for: service descriptions, error messages, success confirmations, CTAs, email/WhatsApp messages
- Tone matrix (web copy vs. support message vs. internal UI)
- Reference to brand colors, logo, fonts (link to `docs/brand-identity.md`)

### Step 4 — If /legal/privacy and /legal/terms routes don't exist

Flag this to the Supervisor. If they're 404, they need to be created (blocker for Meta/TikTok ad compliance — checklist 4.3).

## Success criteria (mechanical)

- [ ] All Landing.tsx strings reviewed (audit list in branch)
- [ ] All CRM page strings reviewed
- [ ] Brand voice guideline written to `docs/brand-voice.md`
- [ ] Any string changes are committed with clear `git diff` showing before/after
- [ ] `npm run lint && npm run build` still pass after any edits to .tsx/.ts files

## Out of scope

- Legal page content (4.3) — just flag if routes are missing
- Payment gateway (4.1)
- Landing visual design changes

## Time-box

2 hours. The audit + guideline doc can be done in one session; string fixes can be applied in a second pass.

## PR template

```bash
git add -A
git commit -m "ux: polish Arabic copy, add brand voice guideline"
git push -u origin hermes/arabic-copy-brand
gh pr create --base main \\
  --title "ux: Arabic copy audit + brand voice guide" \\
  --body "Closes 3.1, 5.31. See docs/templates/task-brief-hermes-sprint2.md"
```
