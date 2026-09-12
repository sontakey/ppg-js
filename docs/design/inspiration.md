# PPG Monitor — Mobbin design inspiration pack

Source: Mobbin (via Composio `MOBBIN_MCP_SEARCH_SCREENS`, platform=ios, mode=deep, limit=6 per lane).
Selections below are the entries actually vision-reviewed image-by-image; not every returned
result was used.

**Brand boundary — read before using this doc:** every color, icon, font, logo, and illustration
style shown below belongs to the source app (Withings, Oura, WHOOP). This pack borrows ONLY
layout structure, information hierarchy, and state coverage. The ppg-js demo app skins none of it —
dark neutral background, system font stack, no logos, no brand colors. If a reviewer can name which
app a layout came from, the borrowing went too far.

---

## Lane 1 — "Place finger on camera" measurement onboarding

### Withings Health Mate — Heart Rate start screen
https://mobbin.com/screens/75306c14-c292-46e0-b6cd-08a19c21425a
- Structure: status bar → uppercase nav title "HEART RATE" → full-bleed camera-tinted background (deep red, simulating flash-through-finger) → centered instruction text → no button, no illustration, no step indicator. Detection starts automatically once a finger is sensed.
- Copy quoted: header "HEART RATE"; body "Gently place your finger in front of your phone's camera"
- **Do not copy:** Withings' red/pink flash-tint background treatment and its uppercase nav-bar typography — ppg-js demo uses a neutral dark background and its own type scale.

### Oura — "Try on your ring" fit-check screen
https://mobbin.com/screens/54150eec-9ae3-48e9-9f9f-a2192386ec30
- Structure: status bar → large realistic illustration of correct hand/sensor placement → headline → one-line supporting body copy → single full-width pill CTA at the bottom ("Check signal"). No progress dots.
- Copy quoted: headline "Try on your ring"; body "For comfort and accuracy, wear your ring with the dimple and sensors on the palm side of your finger."; button "Check signal"
- **Do not copy:** Oura's photographic 3D hand render and pill-button styling/brand color — ppg-js demo uses an inline SVG diagram of finger-over-lens instead of photography, and its own button shape.

**Takeaway applied to app:** placement/onboarding screen = one illustration + one coaching line + one CTA, no clutter, no step counter.

---

## Lane 2 — Live measuring with progress + quality feedback

### Withings Health Mate — "Detecting pulse" in-progress screen
https://mobbin.com/screens/2c8ff01f-2f76-4bf8-b2ac-28a14f121dcb
- Structure: nav title "HEART RATE" → small info icon + one-line coaching text top-right → big centered status label ("Detecting pulse") → thin live waveform strip running across the lower third → small caption under the waveform ("Measure progression"). No numeric readout yet, no cancel button surfaced (back arrow doubles as exit).
- Copy quoted: coaching "Please try to keep your finger still during the measurement"; status "Detecting pulse"; caption "Measure progression"
- **Do not copy:** Withings' full-bleed red gradient card and the starburst loading icon — ppg-js demo uses a plain dark card and a settling countdown ring instead.

### WHOOP — live workout heart-rate screen
https://mobbin.com/screens/eb5e7fd4-5d77-427f-9b49-99fa1b30b96c
- Structure: elapsed-time bar at top → large circular hero dial with label + huge number + secondary sub-label inside the circle, overlaid on a live line-graph background → 3-column metric grid below (icon + label + value per column) → swipe/page dots at the very bottom.
- Copy quoted: hero "HEART RATE" / "106" / "50 - 59%"; grid "AVG HR 143", "STRAIN 11.9", "CALORIES 360"
- **Do not copy:** WHOOP's red/cyan brand palette, circular dial chrome, and 3-column grid dividers — ppg-js demo reuses only the "hero number over a live waveform, secondary stats below" skeleton.

**Takeaway applied to app:** measuring screen = huge live number as hero, one coaching line, thin waveform strip behind/below it, everything else secondary and clearly "--" until quality is good — matches `quality.good` gating already in the library.

---

## Lane 3 — Live vital readout with waveform

### Withings Health Mate — "73 bpm" live readout
https://mobbin.com/screens/c0b23842-412d-421d-ba1c-be00e35bdc6d
- Structure: nav title → small heart glyph → huge number + lowercase unit directly under it, centered → full-width waveform strip below the number → one caption line under the waveform. No secondary metric cards at all on this screen — single-metric focus.
- Copy quoted: hero "73" + "bpm"; caption "Measure progression"
- **Do not copy:** Withings' red gradient card chrome.

### Oura — Readiness detail, "Lowest heart rate" card with inline chart
https://mobbin.com/screens/2faeb966-3504-4f29-9b82-c7b78984e3ed
- Structure: metric card = uppercase small label → big number + unit → one-line comparison sub-text → line chart with dotted average/baseline reference line and axis labels, all inside the same card → a second stacked card below for a related metric (HRV) with chevron to drill in.
- Copy quoted: "LOWEST HEART RATE" / "63 bpm" / "Average 71 bpm"; second card "AVERAGE HRV" / "30"
- **Do not copy:** Oura's card elevation/shadow style and yellow-green brand accent on the bar chart.

**Takeaway applied to app:** measuring screen's live readout = one hero metric (HR) + waveform strip directly under it, secondary numbers (RMSSD/SDNN) rendered smaller, not as separate elevated cards — keeps the single-screen "everything at a glance" mobile layout instead of Oura's drill-down cards.

---

## Lane 4 — HRV/IBI result and session summary

### Oura — "Worry Free Day" session details (post-session summary)
https://mobbin.com/screens/46bb574a-1f9f-4111-8903-d187904380d2 (Readiness list context) and
https://mobbin.com/screens/0e0ac060-1ffd-49b9-9e3f-cdb4e23729e0 (session detail, quoted below)
- Structure: close (×) top-left → title "Session details" → session name + timestamp/duration line → hero stat "Lowest heart rate" with big number and a comparison-to-baseline sub-line → line chart with dotted baseline → second stat block "Average HRV" same pattern → no CTA button at all, dismiss via × only.
- Copy quoted: "Session details"; "Worry Free Day"; "1:59 PM | 5 min"; "Lowest heart rate" / "72 bpm" / "Your nighttime baseline is 48 bpm"; "Average HRV" / "26 ms" / "Your nighttime baseline is 50 ms"
- **Do not copy:** Oura's ocean-photo background and its baseline-comparison framing (ppg-js has no historical baseline to compare against yet — that's a future feature, not something to fake).

### WHOOP — Recovery stat rows vs. baseline
https://mobbin.com/screens/33b30723-adc2-4efa-82d5-6c320624aff3
- Structure: section header ("RECOVERY STATISTICS" / "VS. PREVIOUS 30 DAYS") → repeated row pattern: label, current value, baseline value, trend arrow — HRV, RHR, Respiratory rate, Sleep performance all use the identical row template.
- Copy quoted: "HRV" 39 vs 36; "RHR" 56 vs 58; "RESPIRATORY RATE" 12.7 vs 12.6; "SLEEP PERFORMANCE" 66% vs 75%
- **Do not copy:** WHOOP's trend-arrow color coding and tab-bar chrome (this is a summary-only screen, not a navigable dashboard).

**Takeaway applied to app:** summary screen = repeated min/median/max row template per metric (HR, RMSSD, SDNN), a "% good" line (this app's own quality-driven equivalent of "baseline"), Save debug log + Measure again as the only two actions — no fabricated historical baseline.

---

## Lane 5 — Permission / flashlight instructions

### Chase UK — camera permission pre-prompt + system dialog
https://mobbin.com/screens/83304f22-f8c1-46cc-ae2d-c271968fcd11
- Structure: background app screen explains *why* camera is needed with an illustration and "Next" CTA, then the native iOS system alert appears on top asking Allow/Don't Allow. Two-layer pattern: app-level context first, OS prompt second.
- Copy quoted: system dialog "'Chase' Would Like to Access the Camera" / "This lets you take photos of your ID, documents and receipts"; buttons "Don't Allow" / "OK"

### Lime — camera permission pre-prompt + system dialog
https://mobbin.com/screens/862ceeaf-4d00-4b89-b0fc-b37e57cd8769
- Structure: same two-layer pattern — app pre-prompt overlay with headline, one line of body copy, and a single light "Continue" button, then the OS dialog on top.
- Copy quoted: app-level "Enable camera" / "Lime will use your camera to scan the QR code to start your ride" / button "Continue"; system dialog "'Lime' Would Like to Access the Camera" / "Lime will use your camera to scan the QR code to unlock the vehicle" / buttons "Don't Allow" / "Allow"

**Takeaway applied to app:** ppg-js can't intercept or skin the OS permission dialog (no such API), so the app-level pre-prompt pattern (one headline, one line of "why", one button that triggers `start()` which itself triggers `getUserMedia`) is what's reusable. Torch specifically has no permission dialog — iOS Safari simply has no torch API — so the flashlight lane's real takeaway is: **write the torch-unsupported copy as an inline coaching line, not a permission prompt**, matching what `PPGMonitor` already reports via `torchSupported` in `onReady`.

---

## Summary of structural rules carried into `examples/app/`

1. One state = one screen. No dashboards, no drill-down cards.
2. Hero metric is always a huge number + unit, never buried in a table.
3. Coaching/quality text is a single line, always the single worst reason (mirrors `quality.reason` — already single-message in the library).
4. Waveform sits directly under/behind the hero number, not in a separate chart card.
5. Summary screen = repeated label/min/median/max row, no invented "baseline" data.
6. Permission/torch messaging is inline app copy, not a fake OS dialog.
