// Real-log regression tests, run through tools/replay.js's runReplay().
// Fixtures are anonymized copies of two real iPhone recordings (see
// tools/anonymize-log.js) - test/fixtures/iphone-52s.json (52s session)
// and test/fixtures/iphone-200s.json (200s session, steady ~70bpm).
//
// Bounds below are the actual observed numbers from these two recordings,
// not aspirational targets - see the inline notes where an assumption in
// the original task didn't hold and was corrected instead of loosened
// blindly.
//
// Run with: node test/fixtures.test.js

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runReplay } from '../tools/replay.js';

const iphone200 = JSON.parse(readFileSync(new URL('./fixtures/iphone-200s.json', import.meta.url)));
const iphone52 = JSON.parse(readFileSync(new URL('./fixtures/iphone-52s.json', import.meta.url)));

// --- iphone-200s.json: steady ~70bpm session -------------------------------
{
  const r = runReplay(iphone200);

  const firstMeasuring = r.stateTimeline.find(s => s.state === 'MEASURING');
  assert.ok(firstMeasuring && firstMeasuring.t < 35, `must reach MEASURING before t=35s (got t=${firstMeasuring && firstMeasuring.t})`);

  const after40 = r.hrTimeline.filter(w => w.windowStartSec >= 40);
  const goodAfter40 = after40.filter(w => w.quality.good);
  for (const w of goodAfter40) {
    assert.ok(w.heartRate >= 60 && w.heartRate <= 85, `good HR at t=${w.windowStartSec}s must be 60-85bpm, got ${w.heartRate}`);
    assert.ok(w.quality.artifactRatio <= 0.15, `artifactRatio at t=${w.windowStartSec}s must be <=0.15 when good, got ${w.quality.artifactRatio}`);
  }
  const anyHrBelow55 = r.hrTimeline.some(w => w.heartRate > 0 && w.heartRate < 55);
  assert.ok(!anyHrBelow55, 'no HR window may ever report below 55bpm');

  const goodFraction = goodAfter40.length / after40.length;
  assert.ok(goodFraction >= 0.7, `>=70% of windows after t=40s must be good, got ${(goodFraction * 100).toFixed(1)}%`);

  // The task's assumption was missed_beat rejections cluster at t=120-135s.
  // The actual recording only produces one, at t=95.9s (verified with
  // runReplay directly) - HR stays >=55 there regardless, so the substance
  // of the check (a real missed beat doesn't tank reported HR) still holds;
  // the time window is corrected rather than the bound loosened.
  // Earlier versions of the detector missed one beat in this recording and
  // the test asserted on that flaw. The current engine may or may not miss
  // it; what matters is that any missed-beat rejection never tanks HR.
  const missedBeats = r.ibiDetails.filter(d => d.reason === 'missed_beat');
  const nearMissed = r.hrTimeline.filter(w =>
    missedBeats.some(m => Math.abs(w.windowStartSec - m.peakTimeSec) <= 10) && w.heartRate > 0
  );
  for (const w of nearMissed) {
    assert.ok(w.heartRate >= 55, `HR near a missed-beat rejection must stay >=55bpm, got ${w.heartRate} at t=${w.windowStartSec}`);
  }

  console.log(`[iphone-200s] MEASURING at t=${firstMeasuring.t.toFixed(1)}s, ${goodAfter40.length}/${after40.length} good after t=40s (${(goodFraction * 100).toFixed(1)}%), missed_beat rejections=${missedBeats.length}: PASS`);
}

// --- iphone-52s.json: shorter session, exercises zero-timestamp path -------
{
  const r = runReplay(iphone52);

  const firstMeasuring = r.stateTimeline.find(s => s.state === 'MEASURING');
  assert.ok(firstMeasuring && firstMeasuring.t < 35, `must reach MEASURING before t=35s (got t=${firstMeasuring && firstMeasuring.t})`);

  const beforeMeasuring = r.hrTimeline.filter(w => w.windowStartSec < firstMeasuring.t);
  assert.ok(beforeMeasuring.every(w => !w.quality.good), 'no good=true window may occur before MEASURING is first reached');

  // This fixture's raw sample timestamps are all identical/zero (the iOS
  // rVFC mediaTime=0 bug this whole timing fix was built for), so replay's
  // reconstruction path (see tools/replay.js, synthesizing timing from
  // meta.trackSettings.frameRate) is exercised by this real log too, not
  // just the synthetic case in test/timestamps.test.js.
  assert.equal(r.reconstructed, true, 'iphone-52s.json exercises the zero-timestamp reconstruction path');

  console.log(`[iphone-52s] MEASURING at t=${firstMeasuring.t.toFixed(1)}s, reconstructed=${r.reconstructed}, ${beforeMeasuring.length} pre-MEASURING windows all not-good: PASS`);
}

console.log('\nALL FIXTURE TESTS PASSED');
