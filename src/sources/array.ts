import { PpgEngine, type EngineOptions, type EngineSample, type EngineWindow } from '../core/engine.js';

/**
 * Run recorded samples ({t in ms, r, g, b}) through the engine - the same
 * thing tools/replay.js does, packaged for browsers and tests.
 */
export class ArraySource {
  readonly engine: PpgEngine;
  constructor(options: Partial<EngineOptions> = {}) {
    this.engine = new PpgEngine(options);
  }
  /** Push all samples; returns every completed window in order. */
  run(samples: Array<{ t: number; r: number; g: number; b: number; clipped?: number; motion?: number }>): EngineWindow[] {
    const windows: EngineWindow[] = [];
    if (!samples.length) return windows;
    const t0 = samples[0].t;
    for (const s of samples) {
      const sample: EngineSample = { t: (s.t - t0) / 1000, r: s.r, g: s.g, b: s.b, clipped: s.clipped, motion: s.motion };
      const r = this.engine.push(sample);
      if (r.window) windows.push(r.window);
    }
    return windows;
  }
}
