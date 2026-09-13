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

const ID_KEYS = new Set(['deviceId', 'groupId', 'chosenDeviceId']);

// Device and group ids also appear inside recorded events (track settings
// snapshots and change events), so redact them wherever they occur.
function redactIds(node) {
  if (Array.isArray(node)) { node.forEach(redactIds); return; }
  if (!node || typeof node !== 'object') return;
  for (const k of Object.keys(node)) {
    if (ID_KEYS.has(k) && typeof node[k] === 'string' && node[k] !== '') node[k] = REDACTED;
    else redactIds(node[k]);
  }
}

export function anonymizeLog(log) {
  const out = JSON.parse(JSON.stringify(log));
  redactIds(out);
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
