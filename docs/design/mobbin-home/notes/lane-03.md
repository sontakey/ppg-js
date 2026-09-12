# Lane 3 — "step instructions minimal illustration"

Vision-reviewed sheet: docs/design/mobbin-home/sheets/lane3.png (all 6 screens viewed)

1. **Quicken** — checklist with checkmarks, not numbered steps, single hero illustration above headline. Fit: low (checklist implies async background tasks, not user actions).
2. **Superpower** — numbered 1/2/3 rows, each with title + one sentence + a small right-aligned thumbnail, divider lines between rows, single CTA at bottom. Strong fit — clean numbered-row skeleton.
3. **UNIQLO** — 2x3 icon grid of prohibitions, step counter "1/6" in header, two CTAs (Continue/Back). Fit: low (grid of restrictions, not sequential steps).
4. **Tabby** — "STEP 1"/"STEP 2" tags with UI-preview illustration per step, single CTA at bottom. Good fit but relies on screenshot-style illustrations we don't need.
5. **Whatnot** — numbered rows without numerals visible (icon-led), step counter "1 of 4" near CTA, single CTA "Next". Reasonable secondary reference.
6. **Airbnb** — numbered 1/2/3 rows, each with bold title + one description sentence + right-aligned 3D icon, divider lines, single CTA "Get started" at bottom pinned. Cleanest, most premium numbered-step skeleton of the six.

## Selections (3)

### Airbnb — "It's easy to get started" 3-step numbered list
- Structure: left-aligned headline → 3 divided rows, each: bold number, bold short title, one supporting sentence, small icon at the row's far right → single full-width CTA pinned at the bottom.
- Copy quoted: "It's easy to get started on Airbnb"; "1 Tell us about your place — Share some basic info, like where it is and how many guests can stay."; CTA "Get started"
- **Do not copy:** Airbnb's 3D isometric icon illustrations and pink CTA color — ppg-js demo uses no per-row illustration (or a tiny inline glyph at most) and its own teal `.btn-primary`.

### Superpower — numbered steps with thumbnail + divider rows
- Structure: header with title + one-line subhead → 3 divided rows (number, title, body sentence, small thumbnail) → single CTA at the bottom.
- Copy quoted: "How Superpower works"; "Three steps. No referrals needed."; "1 Test 100+ biomarkers — Visit any of 2,000+ lab locations. Get results in 5-10 business days."; CTA "See what's tested"
- **Do not copy:** Superpower's orange step-number color and lab-photo thumbnails — ppg-js demo uses teal numerals/markers only, no photography.

### Whatnot — icon-led step rows with progress footer
- Structure: hero illustration → bold headline → 3 icon-led rows (title + one sentence, no numerals) → footer progress line + CTA.
- Copy quoted: "How to list on Whatnot"; "List everything to gain visibility — Listing each product individually helps buyers discover your shows."; footer "1 of 4"; CTA "Next"
- **Do not copy:** Whatnot's yellow accent and multi-screen step-counter footer — ppg-js demo home is a single static screen (no "1 of N" since there's only one screen, not a flow).

**Takeaway applied to home screen:** 3-item instruction list = numbered marker + short bold title + one plain sentence per row, divided by thin hairlines, no per-row illustration needed (keeps it calm/premium rather than busy), single CTA pinned at the very bottom of the screen.
