# HRV Spot Check — home screen spec

Renamed from "Pulse" ready screen. Structure borrowed from the inspiration pack
(`docs/design/inspiration-home.md`): single hero + numbered 3-step instruction block +
single CTA pinned at the bottom, safe-area aware. No dashboard, no step counter (this is
one static screen, not a multi-screen flow).

## Final copy (verbatim)

**Title:** HRV Spot Check

**One-line promise:** A fingertip scan of your heart rate and heart-rate variability, right from your phone's camera.

**Headline promise (badge/eyebrow above title or under it):** 3-minute analysis

**3-step instruction block:**
1. **Cover the camera and flash.** Place your fingertip gently over the rear camera and flash.
2. **Hold still for 3 minutes.** Breathe normally and rest your hand on a table if you can.
3. **Wait for the ring to complete.** Keep your finger in place until the countdown ring finishes.

**CTA button:** Start

**Disclaimer (unchanged, kept verbatim):** Not a medical device. For personal curiosity only, not diagnosis or treatment.

**Phone-only gate copy (desktop):**
- Headline: Open on your phone
- Body: HRV Spot Check needs a rear camera and flash. Open this page on your phone to begin.

## Layout structure (borrowed from pack)

- Hero block: eyebrow "3-minute analysis" (small, teal, uppercase-tracked) → `<h1>HRV Spot Check</h1>` → one-line promise as `.lead`.
- Steps block: 3 numbered rows, each a teal numeral + bold short title + one plain sentence, separated by thin hairline dividers (Lane 3: Airbnb/Superpower skeleton) — no per-row illustration, keeps it calm.
- Disclaimer line stays as existing `.disclaimer` text, unchanged, below the steps.
- CTA (`#btn-start`) pinned full-width at the bottom via the existing `.screen` flex `justify-content: space-between`, matching the current ready screen and the Breathwrk/Opal single-CTA takeaway from Lane 2.
- `#desktop-note` stays a plain inline disclaimer paragraph under the CTA (hidden by default, shown by `app.js` on desktop) — no lane found a stronger phone-gate pattern than plain text, so it is kept, just recopywritten.
- Safe-area aware: reuses the existing `.screen` padding (`calc(env(safe-area-inset-top) + 24px) 24px calc(env(safe-area-inset-bottom) + 24px)`), no new padding rules needed.

## Copy rules followed

No emojis, no em dashes, no exclamation marks, no medical claims. "Not a medical device" disclaimer kept verbatim per existing app.css/index.html copy.
