// FingerStateMachine settle-countdown continuity tests (src/core/fingerState.ts).
// No framework - assert-based. Run with: node --import tsx test/finger-state.test.js

import assert from 'node:assert/strict';
import { FingerStateMachine, STATE } from '../src/core/fingerState.js';

const present = { redMean: 200, greenMean: 20, blueMean: 20 };
const absent = { redMean: 10, greenMean: 10, blueMean: 10 };

{
  // Finger placed (present must hold debounceSec=0.3s before it commits),
  // then briefly bounces to NO_FINGER for 0.2s (< bounceGraceSec default
  // 0.5s), then returns. The settle episode must be treated as continuous:
  // timeInState later should read time-since-first-placement, not
  // time-since-the-post-bounce-return.
  const fsm = new FingerStateMachine();
  fsm.update({ tSec: 0, ...present, acDcRatio: 0.02 });
  let r = fsm.update({ tSec: 0.35, ...present, acDcRatio: 0.02 }); // debounce settles
  assert.equal(r.state, STATE.SETTLING, 'placement enters SETTLING once debounced');

  r = fsm.update({ tSec: 2, ...absent, acDcRatio: 0 });
  // absence flips immediately in this harness only once debounced too;
  // drive one more absent sample past the debounce window.
  r = fsm.update({ tSec: 2.35, ...absent, acDcRatio: 0 });
  assert.equal(r.state, STATE.NO_FINGER, 'brief bounce reads NO_FINGER momentarily');

  r = fsm.update({ tSec: 2.4, ...present, acDcRatio: 0.02 }); // gap since leaving SETTLING: 0.05s < 0.5s grace
  r = fsm.update({ tSec: 2.75, ...present, acDcRatio: 0.02 }); // debounce settles back to present
  assert.equal(r.state, STATE.SETTLING, 'returns to SETTLING after short bounce');

  const remaining = fsm.settleSec - fsm.timeInState(3);
  assert.ok(remaining < fsm.settleSec - 2.5, `countdown must not have reset after a <500ms bounce (remaining=${remaining})`);
  console.log('[finger-state] short bounce (<500ms) keeps settle countdown monotonic: PASS');
}

{
  // A real, longer lift (>= bounceGraceSec) DOES start a fresh countdown.
  const fsm = new FingerStateMachine();
  fsm.update({ tSec: 0, ...present, acDcRatio: 0.02 });
  fsm.update({ tSec: 0.35, ...present, acDcRatio: 0.02 }); // SETTLING
  fsm.update({ tSec: 1, ...absent, acDcRatio: 0 });
  fsm.update({ tSec: 1.35, ...absent, acDcRatio: 0 }); // NO_FINGER (debounced)
  fsm.update({ tSec: 2.5, ...present, acDcRatio: 0.02 }); // gap since leaving SETTLING: ~1.15s > 0.5s grace
  const r = fsm.update({ tSec: 2.85, ...present, acDcRatio: 0.02 }); // debounce settles
  assert.equal(r.state, STATE.SETTLING);
  const remaining = fsm.settleSec - fsm.timeInState(2.85);
  assert.ok(remaining >= fsm.settleSec - 0.1, `a real lift must restart the countdown (remaining=${remaining})`);
  console.log('[finger-state] real lift (>=500ms) restarts settle countdown: PASS');
}

console.log('\nALL FINGER-STATE TESTS PASSED');
