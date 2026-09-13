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

// --- iphone-195s-slow-breathing.json: 3 min spot check, v0.3.0 app ----------
// Clean torch-lit iPhone recording at 60 fps with periodic 30 fps dips (the
// camera pipeline drops every other frame for ~20 s about once a minute, 846
// dropped frames in total) and slow breathing (~6.7 breaths/min), which puts
// respiratory sinus arrhythmia into the LF band. The numbers below are the
// observed values; live and replay peaks matched 212/212 on this log.
{
  const { analyzeHRV } = await import('../src/hrv/index.ts');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/iphone-195s-slow-breathing.json', import.meta.url)));
  const r = runReplay(fixture);

  assert.equal(r.comparisonToLive.missed, 0, 'replay must reproduce every live peak');
  assert.equal(r.comparisonToLive.extra, 0, 'replay must not add peaks the device did not see');
  assert.ok(r.summary.goodFraction >= 0.9, `>=90% good windows, got ${(r.summary.goodFraction * 100).toFixed(1)}%`);
  assert.ok(r.summary.hr.median >= 65 && r.summary.hr.median <= 71, `median HR 65-71 bpm, got ${r.summary.hr.median}`);

  // Frame-rate dips raise the timing floor but must not break HR or the gate.
  const dipWindows = r.hrTimeline.filter(w => w.quality.good && w.sampleRate < 50);
  assert.ok(dipWindows.length >= 4, `expect several good windows at <50 fps (got ${dipWindows.length})`);
  for (const w of dipWindows) assert.ok(w.heartRate >= 60 && w.heartRate <= 82, `HR during a frame-rate dip stays plausible (t=${w.windowStartSec}s: ${w.heartRate})`);
  assert.ok(Math.max(...r.hrTimeline.filter(w => w.quality.good).map(w => w.rmssdFloorMs)) < 20, 'RMSSD floor stays under 20 ms even through the dips');

  // Slow breathing: the fusion estimate must be steady near 6.7 br/min at
  // the end and the HRV module must flag that RSA sits in the LF band.
  const firstResp = r.respirationTimeline[0];
  assert.ok(firstResp && firstResp.t <= 55, `first breathing estimate within 45 s of MEASURING (got t=${firstResp && firstResp.t})`);
  const measuringWindows = r.hrTimeline.filter(w => w.state === 'MEASURING' && w.windowEndSec >= firstResp.t);
  // Observed: one window (t=145 s, mid frame-rate dip) where no source was
  // clear and none tracked the last firm rate. Provisional and held
  // estimates cover the rest.
  assert.ok(measuringWindows.length - r.respirationTimeline.length <= 2, `at most 2 windows without a breathing rate after the first estimate (missing ${measuringWindows.length - r.respirationTimeline.length})`);
  const firm = r.respirationTimeline.filter(x => x.confidence >= 0.5);
  assert.ok(firm.length >= 0.5 * r.respirationTimeline.length, `observed 17/29: at least half the estimates rest on agreeing sources (${firm.length}/${r.respirationTimeline.length})`);
  const lastResp = r.respirationTimeline[r.respirationTimeline.length - 1];
  assert.ok(lastResp && lastResp.rateBpm > 5.5 && lastResp.rateBpm < 8 && lastResp.confidence >= 0.5, `final respiration ~6.7 br/min, got ${JSON.stringify(lastResp)}`);
  const beats = r.tachogram.filter(p => p.valid && p.good && !p.lowSnr);
  const hrv = analyzeHRV(beats, { respirationRateBpm: lastResp.rateBpm });
  assert.ok(hrv.frequencyDomain.ok, hrv.frequencyDomain.reason);
  assert.equal(hrv.frequencyDomain.respirationInLf, true, 'slow breathing must be flagged');
  assert.ok(Math.abs(hrv.frequencyDomain.lf.peakFrequency - lastResp.rateBpm / 60) < 0.02, `LF peak (${hrv.frequencyDomain.lf.peakFrequency} Hz) must coincide with the breathing rate`);
  assert.ok(hrv.timeDomain.rmssd > 55 && hrv.timeDomain.rmssd < 85, `RMSSD ~69 ms, got ${hrv.timeDomain.rmssd}`);

  console.log(`[iphone-195s-slow-breathing] ${r.comparisonToLive.matched}/${r.comparisonToLive.liveEventCount} live peaks reproduced, good=${(r.summary.goodFraction * 100).toFixed(0)}%, ${dipWindows.length} good windows under 50 fps, resp first at t=${firstResp.t.toFixed(0)}s, final ${lastResp.rateBpm.toFixed(1)}/min, LF peak=${hrv.frequencyDomain.lf.peakFrequency.toFixed(3)} Hz, RMSSD=${hrv.timeDomain.rmssd.toFixed(1)} ms: PASS`);
}


// --- iphone-63s-noisy-onset.json: reference seeded by a noisy onset ---------
// The first three accepted intervals (1479, 1592, 649 ms) came from the
// moments after finger placement. Before the re-seed rule every later beat
// at ~780 ms was rejected as a jump against that reference and the session
// never showed a heart rate. Observed after the fix: the reference re-seeds
// at 17.9 s, onset intervals leave the artifact tally, the first good
// window is 20.3-25.3 s, HR 72-82 bpm.
{
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/iphone-63s-noisy-onset.json', import.meta.url)));
  const r = runReplay(fixture);
  const good = r.hrTimeline.filter(w => w.quality.good);
  assert.ok(good.length >= 3 && good[0].windowEndSec <= 26, `heart rate must appear by t=26 s (observed: window 20.3-25.3 s) (first good window ends at ${good[0] && good[0].windowEndSec})`);
  for (const w of good) assert.ok(w.heartRate >= 68 && w.heartRate <= 84, `good HR 68-84 bpm at t=${w.windowEndSec}s, got ${w.heartRate}`);
  const late = r.tachogram.filter(p => p.t >= 30);
  const accepted = late.filter(p => p.valid).length / late.length;
  assert.ok(accepted >= 0.9, `>= 90% of beats after t=30 s accepted (got ${(accepted * 100).toFixed(0)}%)`);
  console.log(`[iphone-63s-noisy-onset] first good window at t=${good[0].windowEndSec.toFixed(0)}s, HR ${Math.min(...good.map(w => w.heartRate))}-${Math.max(...good.map(w => w.heartRate))} bpm, ${(accepted * 100).toFixed(0)}% beats accepted after 30 s: PASS`);
}
