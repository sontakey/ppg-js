// Quality gate tests (src/utils/quality.js evaluateQuality). No framework -
// assert-based. Run with: node test/quality.test.js

import assert from 'node:assert/strict';
import { evaluateQuality } from '../src/core/quality.js';

const CLEAN = { state: 'MEASURING', acdc: 0.02, artifactRatio: 0.05, ibiCount: 20, fftAgree: true };

{
  const q = evaluateQuality(CLEAN);
  assert.equal(q.good, true, 'clean synthetic 70bpm-equivalent window must be good');
  console.log('[quality] clean window -> good=true: PASS');
}

{
  const q = evaluateQuality({ ...CLEAN, artifactRatio: 0.25 });
  assert.equal(q.good, false, 'artifactRatio > 0.2 must fail quality');
  console.log('[quality] artifactRatio=0.25 -> good=false: PASS');
}

{
  const q = evaluateQuality({ ...CLEAN, ibiCount: 5 });
  assert.equal(q.good, false, 'ibiCount < 8 must fail quality');
  console.log('[quality] ibiCount=5 -> good=false: PASS');
}

{
  const q = evaluateQuality({ ...CLEAN, state: 'SETTLING' });
  assert.equal(q.good, false, 'non-MEASURING state must fail quality');
  console.log('[quality] state=SETTLING -> good=false: PASS');
}

console.log('\nALL QUALITY TESTS PASSED');
