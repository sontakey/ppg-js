// A one-shot portrait of accepted pulse strokes. Capture rendering never calls
// this module; the preview and downloaded PNG are the very same canvas pixels.
(() => {
  'use strict';

  const WIDTH = 1080, HEIGHT = 1350, ROW_SECONDS = 5;
  const PAPER = '#fdfbf7', INK = '#15213a', BLUE = '#244882';
  const PALETTE = [[40, 85, 255], [118, 84, 184], [28, 138, 142]];
  const instances = new Map();
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

  function seeded(seed) {
    let value = seed >>> 0;
    return () => {
      value += 0x6d2b79f5;
      let t = Math.imul(value ^ value >>> 15, 1 | value);
      t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function durationLabel(duration) {
    const seconds = Math.max(0, Math.round(Number(duration) || 0));
    const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
    return minutes ? `${minutes} min${remainder ? ` ${remainder} sec` : ''}` : `${seconds} sec`;
  }

  function dateLabel(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
      : '';
  }

  function prepare(options) {
    const segments = options.segments || [];
    const start = Number(options.start ?? segments[0]?.points?.[0]?.t);
    const occupied = new Set();
    const coverage = new Map();
    const pigments = PALETTE.map(color => ({ color: color.slice(), sum: [0, 0, 0], weight: 0 }));
    let hash = 2166136261, totalWeight = 0;
    const mixHash = value => { hash = Math.imul(hash ^ (value | 0), 16777619); };
    for (const segment of segments) {
      const points = segment.points || [];
      const quality = clamp(Number(segment.score) || 0);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], dt = b.t - a.t;
        if (!(dt > 0 && dt <= .15) || !Number.isFinite(a.v) || !Number.isFinite(b.v)) continue;
        const rowA = Math.floor((a.t - start) / ROW_SECONDS);
        const rowB = Math.floor((b.t - start) / ROW_SECONDS);
        // A row needs an actual drawable edge. Isolated points and gaps do not
        // contribute pigment or create an invented line in the selected art.
        if (rowA !== rowB || rowA < 0) continue;
        occupied.add(rowA);
        coverage.set(rowA, (coverage.get(rowA) || 0) + dt);
        const color = (options.pigmentAt?.((a.t + b.t) / 2, quality) || PALETTE[0]).map(v => clamp(v, 0, 255));
        // Integrate the path length in a standard waveform row, independent of
        // refresh rate, how often it was painted, or the time spent paused.
        const weight = Math.hypot(dt / ROW_SECONDS, (b.v - a.v) * .14);
        let closest = 0, distance = Infinity;
        PALETTE.forEach((anchor, index) => {
          const candidate = anchor.reduce((sum, v, channel) => sum + (v - color[channel]) ** 2, 0);
          if (candidate < distance) { distance = candidate; closest = index; }
        });
        pigments[closest].weight += weight;
        color.forEach((value, channel) => { pigments[closest].sum[channel] += value * weight; });
        totalWeight += weight;
        mixHash(Math.round(a.t * 1000)); mixHash(Math.round(a.v * 10000)); mixHash(Math.round(quality * 1000));
      }
    }
    for (const pigment of pigments) {
      if (pigment.weight) pigment.color = pigment.sum.map(value => Math.round(value / pigment.weight));
      pigment.ratio = totalWeight ? pigment.weight / totalWeight : 0;
    }
    const available = [...occupied].sort((a, b) => a - b);
    const count = Math.min(4, available.length);
    const rows = [];
    const first = available[0], span = available.at(-1) - first + 1;
    for (let band = 0; band < count; band++) {
      const lower = first + span * band / count, upper = first + span * (band + 1) / count;
      const center = (lower + upper) / 2;
      let candidates = available.filter(row => row >= lower && row < upper && !rows.includes(row));
      if (!candidates.length) candidates = available.filter(row => !rows.includes(row));
      const wellObserved = candidates.filter(row => coverage.get(row) >= ROW_SECONDS * .7);
      if (wellObserved.length) candidates = wellObserved;
      // Prefer an actually occupied row in each time band. Missing samples and
      // pauses remain blank; selecting a fuller row never stretches or fills it.
      candidates.sort((a, b) => Math.round((coverage.get(b) - coverage.get(a)) * 20) || Math.abs(a - center) - Math.abs(b - center));
      rows.push(candidates[0]);
    }
    rows.sort((a, b) => a - b);
    return { rows, pigments: pigments.filter(p => p.weight > 0), seed: hash >>> 0, totalWeight };
  }

  function organicShape(ctx, random, x, y, radius, squash = 1) {
    const count = 48, points = [];
    const phase = random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const angle = i / count * Math.PI * 2;
      const edge = 1 + .10 * Math.sin(angle * 3 + phase) + .07 * Math.sin(angle * 7 - phase) + (random() - .5) * .10;
      points.push([x + Math.cos(angle) * radius * edge, y + Math.sin(angle) * radius * edge * squash]);
    }
    ctx.beginPath();
    const last = points.at(-1), first = points[0];
    ctx.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
    points.forEach((point, index) => {
      const next = points[(index + 1) % count];
      ctx.quadraticCurveTo(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2);
    });
    ctx.closePath();
  }

  function createPaper(composition) {
    const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const random = seeded(composition.seed);
    const diffuse = (x, y, radius, squash, color, opacity, irregular = false) => {
      ctx.save(); ctx.translate(x, y); ctx.scale(1, squash);
      if (irregular) { organicShape(ctx, random, 0, 0, radius); ctx.clip(); }
      const wash = ctx.createRadialGradient(0, 0, radius * .04, 0, 0, radius);
      wash.addColorStop(0, `rgba(${color.join(',')},${opacity})`);
      wash.addColorStop(.35, `rgba(${color.join(',')},${opacity * .76})`);
      wash.addColorStop(.72, `rgba(${color.join(',')},${opacity * .24})`);
      wash.addColorStop(1, `rgba(${color.join(',')},0)`);
      ctx.fillStyle = wash; ctx.fillRect(-radius, -radius, radius * 2, radius * 2); ctx.restore();
    };
    const pooledBloom = (x, y, radius, squash, color, opacity) => {
      ctx.save();
      organicShape(ctx, random, x, y, radius, squash);
      ctx.fillStyle = `rgba(${color.join(',')},${opacity})`; ctx.fill();
      // Pigment collects on only part of the wet boundary. A fading rim avoids
      // an outlined cell while retaining a few crisp, irregular drying edges.
      const rim = ctx.createLinearGradient(x - radius, y - radius * squash, x + radius, y + radius * squash);
      rim.addColorStop(0, `rgba(${color.join(',')},0)`);
      rim.addColorStop(.40, `rgba(${color.join(',')},0)`);
      rim.addColorStop(.66, `rgba(${color.join(',')},${opacity * 1.8})`);
      rim.addColorStop(1, `rgba(${color.join(',')},${opacity * .45})`);
      ctx.strokeStyle = rim; ctx.lineWidth = 1.1 + random() * 1.3; ctx.stroke(); ctx.restore();
    };
    const anchors = [[-95, 100, 380, 1.4], [WIDTH + 85, 25, 330, 1.25], [WIDTH + 85, HEIGHT - 140, 385, 1.35]];
    composition.pigments.forEach(pigment => {
      const paletteIndex = PALETTE.reduce((best, anchor, index) => {
        const distance = anchor.reduce((sum, value, channel) => sum + (value - pigment.color[channel]) ** 2, 0);
        return distance < best.distance ? { index, distance } : best;
      }, { index: 0, distance: Infinity }).index;
      const [x, y, radius, squash] = anchors[paletteIndex];
      const strength = Math.sqrt(pigment.ratio);
      // Soft elliptical water spreads have no large polygon boundary. Small
      // overlapping blooms supply the uneven edge at paper-grain scale.
      // Depth follows captured pigment contribution, never physiology.
      for (let layer = 0; layer < 5; layer++) {
        const offsetX = (random() - .5) * 65, offsetY = (random() - .5) * 150;
        diffuse(x + offsetX, y + offsetY, radius * (.86 + random() * .34), squash, pigment.color, (.13 + random() * .08) * strength);
      }
      // Concentrated pigment at the outside corners blooms into the lighter
      // wash. Only these outermost pools carry the strongest saturation.
      const pools = [[-12, -18, 185, 1.5], [WIDTH + 12, -20, 160, 1.25], [WIDTH + 12, HEIGHT + 18, 200, 1.4]];
      const [poolX, poolY, poolRadius, poolSquash] = pools[paletteIndex];
      for (let layer = 0; layer < 3; layer++) {
        diffuse(poolX + (random() - .5) * 28, poolY + (random() - .5) * 40, poolRadius * (.8 + random() * .25), poolSquash, pigment.color, (.32 + random() * .14) * strength);
      }
      // Connected small blooms follow irregular drying fronts, rather than
      // scattering blurred dots across the paper. Overlap supplies local pools
      // of cobalt/iris/teal with both sharp and diffuse translucent edges.
      const firstAngle = paletteIndex * Math.PI / 2, phase = random() * Math.PI * 2;
      for (let front = 0; front < 4; front++) {
        const cells = 22 + front * 5, frontRadius = poolRadius * (.65 + front * .23);
        for (let cell = 0; cell <= cells; cell++) {
          const angle = firstAngle + cell / cells * Math.PI / 2;
          const reach = frontRadius * (1 + .045 * Math.sin(cell * .78 + phase) + .025 * Math.sin(cell * 1.73 - phase));
          const cx = poolX + Math.cos(angle) * reach, cy = poolY + Math.sin(angle) * reach * poolSquash;
          const size = 12 + random() * 18, aspect = .8 + random() * .7;
          const opacity = (.045 + random() * .045) * (1 - front * .15) * strength;
          pooledBloom(cx, cy, size, aspect, pigment.color, opacity);
          if (random() > .45) diffuse(cx - size * .2, cy, size * .85, aspect, pigment.color, opacity * .7, true);
        }
      }
    });
    // A translucent paper bloom keeps the manuscript and full-width title clear.
    const bloom = ctx.createRadialGradient(WIDTH * .48, HEIGHT * .48, 140, WIDTH * .48, HEIGHT * .48, 700);
    bloom.addColorStop(0, 'rgba(253,251,247,.60)'); bloom.addColorStop(.62, 'rgba(253,251,247,.32)'); bloom.addColorStop(1, 'rgba(253,251,247,0)');
    ctx.fillStyle = bloom; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    // Seeded paper tooth is drawn once, not animated or read back per frame.
    for (let i = 0; i < 17000; i++) {
      const x = random() * WIDTH, y = random() * HEIGHT;
      ctx.fillStyle = i % 2 ? 'rgba(52,55,76,.022)' : 'rgba(255,255,255,.24)';
      ctx.fillRect(x, y, .7 + random() * 1.4, .6 + random() * .9);
    }
    return canvas;
  }

  function valueLabel(value) { return Number.isFinite(value) ? `${Math.round(value)}` : '—'; }

  async function mount(container, options = {}) {
    clear(container);
    const composition = prepare(options);
    if (!composition.rows.length || typeof options.paintRows !== 'function') { container.hidden = true; return null; }
    container.hidden = false;
    const section = document.createElement('section'); section.className = 'pulse-portrait';
    section.setAttribute('aria-label', 'Your pulse artwork');
    section.innerHTML = `<div class="portrait-heading"><h2>Your pulse, on paper.</h2><p>A keepsake made from your captured pulse.</p></div>
      <figure class="portrait-preview"><canvas width="1080" height="1350" role="img"></canvas><figcaption>Selected moments from your recording. Your full manuscript is available below.</figcaption></figure>
      <label class="portrait-options"><input type="checkbox" disabled><span>Include pulse and HRV metrics in artwork</span></label>
      <div class="portrait-actions"><button type="button" class="btn-primary portrait-share" disabled>Share artwork</button><button type="button" class="btn-secondary portrait-save" disabled>Save artwork</button></div>
      <p class="portrait-status" role="status" aria-live="polite">Preparing your artwork…</p>`;
    container.append(section);
    const canvas = section.querySelector('canvas'), checkbox = section.querySelector('input');
    const share = section.querySelector('.portrait-share'), save = section.querySelector('.portrait-save');
    const status = section.querySelector('.portrait-status');
    const duration = durationLabel(options.durationSec), date = dateLabel(options.startedAt);
    const state = { canvas, section, composition, options, includeMetrics: false, blob: null, file: null, renderVersion: 0, disposed: false, urls: new Set() };
    instances.set(container, state);
    canvas.setAttribute('aria-label', `Pulse on Paper. Selected moments from ${duration} of recorded pulse${date ? ` on ${date}` : ''}. Metrics excluded from artwork.`);

    const render = () => {
      const version = ++state.renderVersion;
      state.blob = null; state.file = null; share.disabled = true; save.disabled = true;
      const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, WIDTH, HEIGHT); ctx.drawImage(state.paper, 0, 0);
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = INK;
      ctx.font = '400 136px "Water Brush", cursive';
      // The heading owns the entire top row; no branding or controls compete.
      ctx.fillText('Pulse on Paper', WIDTH / 2, 178, WIDTH - 112);
      ctx.fillStyle = BLUE; ctx.font = '400 60px "DM Sans", sans-serif';
      ctx.fillText('Uniquely yours.', WIDTH / 2, 260);
      ctx.textAlign = 'right'; ctx.font = '400 60px "DM Sans", sans-serif';
      ctx.fillText('Selected moments', WIDTH - 70, 344);
      const rowHeight = state.includeMetrics ? 137 : 158;
      const targetHeight = rowHeight * composition.rows.length;
      const top = 380 + (4 - composition.rows.length) * rowHeight / 2;
      ctx.drawImage(state.strokes, 66, top, WIDTH - 132, targetHeight);
      if (state.includeMetrics) {
        const metrics = options.metrics || {};
        const values = [['Pulse', metrics.hr, 'bpm'], ['RMSSD', metrics.rmssd, 'ms'], ['SDNN', metrics.sdnn, 'ms']];
        ctx.strokeStyle = 'rgba(36,72,130,.18)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(80, 986); ctx.lineTo(WIDTH - 80, 986); ctx.stroke();
        values.forEach(([label, value, unit], index) => {
          const x = 200 + index * 340;
          ctx.textAlign = 'center'; ctx.fillStyle = BLUE; ctx.font = '400 60px "DM Sans", sans-serif'; ctx.fillText(label, x, 1052);
          ctx.fillStyle = INK; ctx.font = '600 60px "DM Sans", sans-serif'; ctx.fillText(`${valueLabel(value)} ${unit}`, x, 1122);
        });
      }
      ctx.textAlign = 'center'; ctx.fillStyle = BLUE; ctx.font = '400 60px "DM Sans", sans-serif';
      ctx.fillText(date ? `${date}  ·  ${duration}` : duration, WIDTH / 2, state.includeMetrics ? 1218 : 1186);
      ctx.fillText('A project by ChatPPG', WIDTH / 2, state.includeMetrics ? 1290 : 1260);
      canvas.setAttribute('aria-label', `Pulse on Paper. Selected moments from ${duration} of recorded pulse${date ? ` on ${date}` : ''}. Metrics ${state.includeMetrics ? 'included' : 'excluded'} from artwork.`);
      state.ready = new Promise(resolve => {
        canvas.toBlob(blob => {
          if (state.disposed || version !== state.renderVersion) { resolve(null); return; }
          if (!blob) { checkbox.disabled = true; status.textContent = 'The artwork could not be prepared. Your full manuscript is still available below.'; resolve(null); return; }
          state.blob = blob;
          state.file = new File([blob], 'pulse-on-paper.png', { type: 'image/png' });
          share.disabled = false; save.disabled = false; status.textContent = ''; resolve(blob);
        }, 'image/png');
      });
      return state.ready;
    };

    const download = () => {
      if (!state.blob) return;
      const url = URL.createObjectURL(state.blob); state.urls.add(url);
      const link = document.createElement('a'); link.href = url; link.download = 'pulse-on-paper.png'; link.rel = 'noopener';
      document.body.append(link); link.click(); link.remove();
      // Keep the object URL alive long enough for Safari to consume the file.
      setTimeout(() => { URL.revokeObjectURL(url); state.urls.delete(url); }, 60000);
      status.textContent = 'Artwork download started.';
    };
    save.addEventListener('click', download);
    share.addEventListener('click', () => {
      if (!state.file) return;
      const data = { files: [state.file], title: 'Pulse on Paper' };
      let supported = false;
      try { supported = typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare(data); } catch { /* Use the independent download path. */ }
      if (!supported) { download(); return; }
      share.disabled = true;
      // Invoke synchronously within the tap, using the already prepared file.
      try {
        Promise.resolve(navigator.share(data)).then(() => {
          if (!state.disposed) status.textContent = 'Artwork shared.';
        }).catch(error => {
          if (!state.disposed) status.textContent = error?.name === 'AbortError' ? '' : 'Sharing is unavailable. Use Save artwork to keep your portrait.';
        }).finally(() => { if (!state.disposed) share.disabled = false; });
      } catch (error) {
        share.disabled = false; status.textContent = error?.name === 'AbortError' ? '' : 'Sharing is unavailable. Use Save artwork to keep your portrait.';
      }
    });
    checkbox.addEventListener('change', () => {
      state.includeMetrics = checkbox.checked; status.textContent = 'Preparing your artwork…'; render();
    });
    try {
      await Promise.allSettled([document.fonts?.load('136px "Water Brush"'), document.fonts?.load('60px "DM Sans"'), document.fonts?.load('600 60px "DM Sans"')]);
      if (state.disposed) return null;
      state.paper = createPaper(composition);
      state.strokes = document.createElement('canvas'); state.strokes.width = WIDTH - 132; state.strokes.height = 158 * composition.rows.length;
      options.paintRows(state.strokes, composition.rows);
      checkbox.disabled = false;
      await render();
      return state;
    } catch {
      if (!state.disposed) { checkbox.disabled = true; status.textContent = 'The artwork could not be prepared. Your full manuscript is still available below.'; }
      return null;
    }
  }

  function clear(container) {
    for (const [target, state] of instances) {
      if (container && container !== target) continue;
      state.disposed = true; state.renderVersion++;
      state.urls.forEach(url => URL.revokeObjectURL(url)); state.urls.clear();
      target.replaceChildren(); instances.delete(target);
    }
  }

  function getState(container) {
    const state = container ? instances.get(container) : [...instances.values()].at(-1);
    if (!state) return null;
    return {
      width: state.canvas.width, height: state.canvas.height, ready: !!state.blob,
      includeMetrics: state.includeMetrics, selectedRows: state.composition.rows.slice(),
      pigmentWeights: state.composition.pigments.map(p => ({ color: p.color.slice(), weight: p.weight, ratio: p.ratio })),
      seed: state.composition.seed, durationSec: state.options.durationSec,
      bytes: state.blob?.size || 0,
    };
  }

  window.PulsePortrait = Object.freeze({ mount, clear, getState });
})();
