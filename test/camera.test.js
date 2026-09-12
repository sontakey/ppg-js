// Unit tests for the rear-lens picker (src/utils/camera.js).
// Run with: node test/camera.test.js

import assert from 'node:assert/strict';
import { pickBackCamera } from '../src/utils/camera.js';

function devices(labels) {
  return labels.map((label, i) => ({ deviceId: `id${i}`, label, kind: 'videoinput' }));
}

// --- iPhone: exact 'Back Camera' beats ultra-wide/tele/dual/triple --------
{
  const iphone = devices([
    'Front Camera',
    'Back Camera',
    'Back Ultra Wide Camera',
    'Back Telephoto Camera',
    'Back Dual Wide Camera',
    'Back Triple Camera'
  ]);
  const picked = pickBackCamera(iphone);
  assert.ok(picked, 'iPhone: must pick a device');
  assert.equal(picked.label, 'Back Camera');
  console.log('[iPhone] picked "Back Camera" among 6 lenses - OK');
}

// --- Android: no exact match, falls back to generic "back" label ---------
{
  const android = devices(['camera2 1, facing front', 'camera2 0, facing back']);
  const picked = pickBackCamera(android);
  assert.ok(picked, 'Android: must pick a device');
  assert.equal(picked.label, 'camera2 0, facing back');
  console.log('[Android] picked the "facing back" device - OK');
}

// --- Desktop: single unlabeled-pattern webcam -> null (caller uses facingMode) --
{
  const desktop = devices(['FaceTime HD Camera']);
  const picked = pickBackCamera(desktop);
  assert.equal(picked, null, 'Desktop: single webcam with no front/back label must return null');
  console.log('[Desktop] no confident match, returned null - OK');
}

console.log('\nALL CAMERA PICKER TESTS PASSED');
