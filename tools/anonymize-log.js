#!/usr/bin/env node
// Strip device-identifying fields from a recorded debug log before it's
// committed as a test fixture: real deviceId/groupId hashes and per-device
// videoInputs deviceIds are unique hardware identifiers, not needed by any
// test (labels/frameRate/torch/dimensions are what the replay pipeline and
// camera picker actually consume).
//
// Usage: node tools/anonymize-log.js <in.json> <out.json>

import { readFileSync, writeFileSync } from 'node:fs';

const REDACTED = '[REDACTED]';

export function anonymizeLog(log) {
  const out = JSON.parse(JSON.stringify(log));
  const m = out.meta;
  if (!m) return out;

  if (m.trackSettings) {
    m.trackSettings.deviceId = REDACTED;
    m.trackSettings.groupId = REDACTED;
  }
  if (m.trackCapabilities) {
    m.trackCapabilities.deviceId = REDACTED;
    m.trackCapabilities.groupId = REDACTED;
  }
  if (Array.isArray(m.videoInputs)) {
    m.videoInputs = m.videoInputs.map(v => ({ ...v, deviceId: REDACTED }));
  }
  if (m.chosenDeviceId) m.chosenDeviceId = REDACTED;

  return out;
}

function main() {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error('Usage: node tools/anonymize-log.js <in.json> <out.json>');
    process.exit(1);
  }
  const log = JSON.parse(readFileSync(inPath, 'utf8'));
  writeFileSync(outPath, JSON.stringify(anonymizeLog(log)));
  console.log(`Wrote anonymized fixture: ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
