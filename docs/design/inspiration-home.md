# HRV Spot Check — home screen Mobbin inspiration pack (extension)

Extends `docs/design/inspiration.md` (Withings/Oura/WHOOP/Chase/Lime, 5 lanes) with 3 new
lanes scoped to the redesigned home screen only. Source: Mobbin, via Composio
`MOBBIN_MCP_SEARCH_SCREENS` (platform=ios, mode=deep, limit=6 per lane, sync_response_to_workbench=true).
Selections below are the entries actually vision-reviewed image-by-image (all 3 contact sheets,
all 18 screens); not every returned result was used.

**Brand boundary — read before using this doc:** every color, icon, font, illustration style,
and photography shown below belongs to the source app. This pack borrows ONLY layout structure,
information hierarchy, and copy patterns. The `HRV Spot Check` home screen skins none of it — dark
tokens already in `examples/app/app.css` (`#0b0d12` background, `#4fd1c5` teal accent, `#f2f4f7`
text, `#8a90a0`/`#c3c9d4` muted text), system font stack, no logos, no photography, no gamification.
If a reviewer can name which app a layout came from, the borrowing went too far.

---

## Lane 1 — "measurement onboarding hold still instructions" (6 screens: Noom, DoorDash Dasher, Wise, Instacart, Grab Driver, Woolworths)

### Noom — "Tip 4/4" face-scan intro
https://mobbin.com/screens/2ab004fb-e3df-4916-868c-1753daf84daf
- Structure: full-bleed hero photo → white bottom sheet → step counter → one coaching sentence naming the duration → single full-width CTA pinned at bottom.
- Copy quoted: "Tip 4/4"; "Remain as still as possible for the duration of the scan—just 30 seconds!"; button "Start my Face Scan"
- **Do not copy:** Noom's lifestyle photography and white-card-over-photo treatment.

### Instacart — "Keep still while scanning" card scan coaching
https://mobbin.com/screens/c2e3413e-6575-40a5-bc4a-3b181d9b0b00
- Structure: illustration → bold instruction title → one supporting sentence explaining WHY stillness matters → dot progress indicator below.
- Copy quoted: "Keep still while scanning"; "Try to keep the phone and card still while scanning. Moving either can blur the image and make data on the card unreadable."
- **Do not copy:** Instacart's red error-state color coding and blue text-link CTA.

### Woolworths — "Calibrate your device" figure-8 instruction
https://mobbin.com/screens/ba8b9f32-ae5b-4204-98da-53451defc8dd
- Structure: single hero illustration → bold instruction title → one short physical-action sub-line → plain CTA. No progress chrome.
- Copy quoted: "Calibrate your device"; "Wave your device in a figure 8 motion."; button "Dismiss"
- **Do not copy:** Woolworths' 3D rendered hand/phone illustration and green brand accent.

**Takeaway:** one hero illustration/icon (not photography), one bold instruction line naming the physical action, one short "why/how long" sentence, single CTA pinned at the bottom. No multi-tip carousel, no step counter — a single static screen, not a flow.

---

## Lane 2 — "wellness app home hero single CTA dark" (6 screens: pliability, CalmSleep, Opal, Breathwrk, TIDE, Ultrahuman)

### Breathwrk — single glowing "Start" hero button
https://mobbin.com/screens/c7702c95-1376-4097-a321-0c0460a5aa03
- Structure: day-of-week/streak row → one short motivational headline → one enormous centered circular CTA as the visual hero itself → duration selector below (content feed further down, not part of the pre-action gate).
- Copy quoted: "New day! A calm mind and strong body start with deep breaths. Keep it up!"; CTA "Start"
- **Do not copy:** Breathwrk's glow/halo button chrome and day-streak gamification row.

### Opal — metric-led hero with single bottom CTA (control case)
https://mobbin.com/screens/1b3deee1-a193-4e36-93b0-7e89740f9c5c
- Structure: hero illustration/metric block → short coaching headline → one supporting sentence → single full-width CTA anchored in a bottom card.
- Copy quoted: "Trouble winding down?"; "Try a guided meditation to ease into sleep"; CTA "► Meditate and Sleep"
- **Do not copy:** Opal's gemstone 3D illustration and score-pill row. Control case: proves the "hero block + one coaching line + bottom CTA" skeleton is metric-agnostic — ppg-js has no historical score to show here.

**Takeaway:** of six "wellness home" screens reviewed, only Breathwrk and Opal keep a true single-CTA, no-clutter gate; the rest (pliability, CalmSleep, TIDE, Ultrahuman) are dashboards with competing actions. Confirms the existing ppg-js ready screen's one-CTA structure should be KEPT — recopywritten and given a 3-step instruction block, not rebuilt as a dashboard.

---

## Lane 3 — "step instructions minimal illustration" (6 screens: Quicken, Superpower, UNIQLO, Tabby, Whatnot, Airbnb)

### Airbnb — "It's easy to get started" 3-step numbered list
https://mobbin.com/screens/a9d0b169-e1ea-4611-b273-35401129a917
- Structure: left-aligned headline → 3 divided rows (bold number, bold short title, one supporting sentence, small icon at row's far right) → single full-width CTA pinned at the bottom.
- Copy quoted: "It's easy to get started on Airbnb"; "1 Tell us about your place — Share some basic info, like where it is and how many guests can stay."; CTA "Get started"
- **Do not copy:** Airbnb's 3D isometric icons and pink CTA color.

### Superpower — numbered steps with divider rows
https://mobbin.com/screens/7df088f8-dea2-4a33-88df-d476e926b113
- Structure: header + one-line subhead → 3 divided rows (number, title, body sentence, small thumbnail) → single CTA at the bottom.
- Copy quoted: "How Superpower works"; "Three steps. No referrals needed."; "1 Test 100+ biomarkers — Visit any of 2,000+ lab locations. Get results in 5-10 business days."; CTA "See what's tested"
- **Do not copy:** Superpower's orange step-number color and lab-photo thumbnails.

### Whatnot — icon-led step rows with progress footer
https://mobbin.com/screens/3e4017ad-bca8-4f6c-b412-e6669499a8f1
- Structure: hero illustration → bold headline → 3 icon-led rows (title + one sentence, no numerals) → footer progress line + CTA.
- Copy quoted: "How to list on Whatnot"; "List everything to gain visibility — Listing each product individually helps buyers discover your shows."; footer "1 of 4"; CTA "Next"
- **Do not copy:** Whatnot's yellow accent and multi-screen "1 of N" step-counter footer — ppg-js home is a single static screen, not a flow.

**Takeaway:** 3-item instruction list = numbered marker + short bold title + one plain sentence per row, divided by thin hairlines, no per-row illustration needed, single CTA pinned at the very bottom of the screen.

---

## Summary of structural rules carried into the new home screen

1. Single static screen (no multi-tip carousel, no "1 of N" step counter) — the app already gates flow via its existing state machine, the home screen itself is one gate.
2. Hero illustration (inline SVG, no photography, no 3D render) is optional and secondary to copy — the existing finger-illustration is sufficient, no photographic hero needed.
3. 3-step instruction block = numbered marker + short bold title + one plain sentence, thin dividers, no per-row illustration (Lane 3: Airbnb/Superpower skeleton).
4. Coaching copy always states the physical action AND duration/why in one short sentence (Lane 1: Noom/Instacart/Woolworths).
5. Single full-width CTA pinned at the bottom of the screen, nothing competing with it (Lane 2: Breathwrk/Opal control case) — confirms keeping the current `.btn-primary` + `#btn-start` pattern, just recopywritten.
6. Desktop/phone-only gate copy stays a plain disclaimer line, not a modal or illustration — no lane offered a stronger pattern than the existing `#desktop-note` inline text.

<!-- machine-index: lane1=[2ab004fb,c2e3413e,ba8b9f32] lane2=[c7702c95,1b3deee1] lane3=[a9d0b169,7df088f8,3e4017ad] -->
