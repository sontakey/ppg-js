/**
 * Pick the main (wide) rear camera from a list of enumerateDevices() results.
 *
 * iPhones expose separate labeled devices per lens ('Back Camera',
 * 'Back Ultra Wide Camera', 'Back Telephoto Camera', 'Back Dual Wide
 * Camera', 'Back Triple Camera' for the virtual multi-cam). We want the
 * single physical wide lens, not a virtual/ultra-wide/telephoto one that
 * iOS may switch to under macro conditions (finger close to lens).
 *
 * Android labels don't follow this convention ('camera2 0, facing back'),
 * so a match there is coincidental; callers should keep the
 * `facingMode: 'environment'` constraint as a fallback regardless of what
 * this returns.
 */

export interface DeviceLike { deviceId: string; label: string; kind: string; }

export function pickBackCamera(devices: ArrayLike<DeviceLike> | DeviceLike[]): DeviceLike | null {
  const videoInputs = Array.from(devices as ArrayLike<DeviceLike>).filter(d => d.kind === 'videoinput' && d.label);
  const EXCLUDE = /ultra|wide|tele|dual|triple|virtual/i;

  // 1. Exact iPhone main-lens label.
  let match = videoInputs.find(d => /^back camera$/i.test(d.label.trim()));
  if (match) return match;

  // 2. Contains "back" but not one of the other-lens words.
  match = videoInputs.find(d => /back/i.test(d.label) && !EXCLUDE.test(d.label));
  if (match) return match;

  // 3. No "back"-labeled device, but a sibling "front" one exists (i.e. this
  // is a known front/back pair just missing the word "back") - take the
  // other one. Guarded on a front sibling existing so a single unlabeled
  // desktop webcam still falls through to facingMode below.
  const front = videoInputs.filter(d => /front/i.test(d.label));
  if (front.length > 0 && front.length < videoInputs.length) {
    match = videoInputs.find(d => !/front/i.test(d.label));
    if (match) return match;
  }

  // No confident label match (e.g. a single desktop webcam) - let the
  // caller fall back to facingMode.
  return null;
}
