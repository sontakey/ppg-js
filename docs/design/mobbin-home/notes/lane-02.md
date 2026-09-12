# Lane 2 — "wellness app home hero single CTA dark"

Vision-reviewed sheet: docs/design/mobbin-home/sheets/lane2.png (all 6 screens viewed)

1. **pliability** — dark theme, card carousel hero, headline "Daily Sessions" / "1 of 7 complete", single neon "▶ Start" CTA, secondary interest tiles below, tab bar. Single CTA present but screen is a dashboard, not a pre-session gate.
2. **CalmSleep** — dark theme, two stacked action cards, no single CTA (two competing actions). Lower fit — this app is a multi-task home, not a single-action gate.
3. **Opal** — dark theme, 3D hero illustration + metric ("Score 81") + single CTA "► Meditate and Sleep" in a bottom overlay card. Good single-CTA structure but metric-first, not action-first.
4. **Breathwrk** — dark theme, giant centered glowing circular "Start" button as the entire hero, one motivational headline above it, duration selector below. Cleanest "one hero action, nothing else competing" structure of the six.
5. **TIDE** — dark theme, quote-first hero, multiple chip CTAs, no single action. Lower fit.
6. **Ultrahuman** — dark theme, photo hero, content-discovery hub, no single CTA. Lower fit.

## Selections (2, control case noted)

### Breathwrk — single glowing "Start" hero button
- Structure: day-of-week strip + streak/logo row at top → one short motivational headline → one enormous centered circular CTA as the visual hero itself (button doubles as illustration) → duration selector pill below → content feed further down (not part of the pre-action gate).
- Copy quoted: "New day! A calm mind and strong body start with deep breaths. Keep it up!"; CTA "Start"
- **Do not copy:** Breathwrk's glow/halo button chrome and its day-streak gamification row — ppg-js demo has no streaks and its own flat `.btn-primary` pill, not a circular glowing button.

### Opal — metric-led hero with single bottom CTA
- Structure: hero illustration/metric block up top → short coaching headline ("Trouble winding down?") → one supporting sentence → single full-width CTA anchored in a bottom card.
- Copy quoted: "Trouble winding down?"; "Try a guided meditation to ease into sleep"; CTA "► Meditate and Sleep"
- **Do not copy:** Opal's gemstone 3D illustration and score-pill row — this is a control case proving the "hero block + one coaching line + bottom CTA" skeleton is metric-agnostic; ppg-js demo has no historical score to show on the home screen.

**Takeaway applied to home screen:** among six "wellness home" screens, only Breathwrk and Opal keep to a true single-CTA-no-clutter gate; the existing ppg-js ready screen already matches this closer than any dashboard-style competitor (pliability, CalmSleep, TIDE, Ultrahuman) — confirms the current one-CTA structure should be KEPT, just re-copywritten and given a 3-step instruction block borrowed from Lane 1/3.
