# Lane 1 — "measurement onboarding hold still instructions"

Vision-reviewed sheet: docs/design/mobbin-home/sheets/lane1.png (all 6 screens viewed)

1. **Noom** — Tip step counter ("Tip 4/4") + coaching paragraph "Remain as still as possible for the duration of the scan—just 30 seconds!" over full-bleed hero photo, single CTA "Start my Face Scan" pinned at the bottom in a white sheet. Timebound coaching line is the reusable idea.
2. **DoorDash Dasher** — single word instruction "Hold still" above a circular live camera viewport, thin progress line at top, no CTA (auto-captures). Minimal-copy pattern for an in-progress/active capture state, not onboarding — noted but lower fit for a static home screen.
3. **Wise** — floating pill bubble "Hold steady" over a glowing-ring oval camera frame. Same "auto-capture, one short imperative line" pattern as DoorDash.
4. **Instacart** — title "Keep still while scanning" + one-line why ("Try to keep the phone and card still while scanning...") + illustration, 4-dot progress indicator, "Done" as text action not a button.
5. **Grab Driver** — "Hold your phone upright." primary instruction, secondary disabled CTA text "Get ready!", alert banner below explaining consequence. Multi-layer messaging, busier than needed.
6. **Woolworths** — 3D hero illustration + title "Calibrate your device" + one sub-line "Wave your device in a figure 8 motion." + plain text "Dismiss" CTA. Clean hero-illustration-then-instruction skeleton.

## Selections (3)

### Noom — "Tip 4/4" face-scan intro
- Structure: full-bleed hero photo → white bottom sheet → step counter → one coaching sentence naming the duration → single full-width CTA pinned at bottom.
- Copy quoted: "Tip 4/4"; "Remain as still as possible for the duration of the scan—just 30 seconds!"; button "Start my Face Scan"
- **Do not copy:** Noom's lifestyle photography and white-card-over-photo treatment — ppg-js demo stays dark, no photography, no step counter (single screen, no multi-tip flow).

### Instacart — "Keep still while scanning" card scan error/coaching
- Structure: illustration (schematic, not photographic) → bold instruction title → one supporting sentence explaining WHY stillness matters → dot progress indicator below.
- Copy quoted: "Keep still while scanning"; "Try to keep the phone and card still while scanning. Moving either can blur the image and make data on the card unreadable."
- **Do not copy:** Instacart's red error-state color coding and blue text-link CTA style — ppg-js demo uses its existing teal `.btn-primary` and neutral illustration tone, and this is a calm coaching state, not an error state.

### Woolworths — "Calibrate your device" figure-8 instruction
- Structure: single hero illustration → bold instruction title → one short physical-action sub-line → plain CTA. No progress chrome at all — cleanest structural match for a single, non-multi-step instruction screen.
- Copy quoted: "Calibrate your device"; "Wave your device in a figure 8 motion."; button "Dismiss"
- **Do not copy:** Woolworths' 3D rendered hand/phone illustration and green brand accent — ppg-js demo uses its own inline SVG/illustration style and teal accent only.

**Takeaway applied to home screen:** one hero illustration/icon (not photography), one bold instruction line stating the physical action, one short "why/how long" supporting sentence, single CTA pinned at the bottom. No multi-tip carousel, no step counter — this is a single static screen, not a flow.
