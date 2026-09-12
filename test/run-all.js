#!/usr/bin/env node
// Runs every test/*.test.js sequentially, stopping (exit 1) on the first
// failure. Each test file is a standalone assert-based script (see
// sim.test.js doc comment) - this is just a runner, no framework.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

for (const file of files) {
  const full = path.join(testDir, file);
  console.log(`\n--- ${file} ---`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', full], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nFAILED: ${file}`);
    process.exit(1);
  }
}
console.log(`\nAll ${files.length} test suites passed.`);
