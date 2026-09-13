"""HeartPy vs ppg-js on the exported datasets (bench/out/*.json).

For each dataset the inverted red channel is resampled onto a uniform grid at
the recording's nominal rate, bandpassed with HeartPy's own filter and run
through hp.process with high-precision peak timing and RR cleaning (the
configuration HeartPy's documentation recommends for PPG). Beats HeartPy
keeps (binary_peaklist == 1) are compared with ppg-js's accepted beats from
good windows, and both against the simulator's ground truth where it exists.

  bench-venv/bin/python bench/compare_heartpy.py bench/out > bench/heartpy-results.json
"""
import json, sys, glob, os, warnings, math
import numpy as np
warnings.filterwarnings('ignore')
import heartpy as hp

MATCH_TOL = 0.15  # s

def uniform(t, x, fs):
    grid = np.arange(t[0], t[-1], 1.0 / fs)
    return grid, np.interp(grid, t, x)

def rmssd(ibi):
    ibi = np.asarray(ibi, float)
    if len(ibi) < 2: return float('nan')
    d = np.diff(ibi); return float(np.sqrt(np.mean(d * d)))

def cycle_errors(det, truth):
    """Signed error of each detection to the nearest truth beat, wrapped to
    +-half a cycle, in seconds. Constant fiducial offsets show up as a
    cluster; a detector that flips between two fiducials shows two clusters."""
    truth = np.asarray(truth, float); det = np.asarray(det, float)
    if len(truth) < 3 or not len(det): return np.array([]), 1.0
    T = float(np.median(np.diff(truth)))
    idx = np.clip(np.searchsorted(truth, det), 1, len(truth) - 1)
    nearest = np.where(np.abs(truth[idx] - det) < np.abs(truth[idx - 1] - det), truth[idx], truth[idx - 1])
    e = det - nearest
    e = (e + T / 2) % T - T / 2
    return e, T

def match(det, truth, tol=MATCH_TOL, align=True):
    """Greedy nearest matching after removing the constant fiducial offset
    (the simulator's truth marks the beat onset; a detector marks the
    systolic peak ~0.25 cycle later, and different detectors use different
    fiducials). Returns (n_matched, timing errors in ms after alignment)."""
    truth = np.asarray(truth, float); det = np.asarray(det, float)
    if not len(truth) or not len(det): return 0, []
    offset = 0.0
    if align:
        e, T = cycle_errors(det, truth)
        if len(e):
            # mode of the wrapped error histogram = the detector's fiducial offset
            hist, edges = np.histogram(e, bins=int(max(8, T / 0.02)), range=(-T / 2, T / 2))
            k = int(np.argmax(hist)); offset = float((edges[k] + edges[k + 1]) / 2)
    used = np.zeros(len(truth), bool); errs = []
    for d in det - offset:
        i = int(np.argmin(np.abs(truth - d)))
        if not used[i] and abs(truth[i] - d) <= tol:
            used[i] = True; errs.append((d - truth[i]) * 1000)
    return int(used.sum()), errs

def evaluate(name, beat_times, truth, t_start, t_end, ibis_ms=None):
    """Beat-level metrics for a detector's accepted beats within [t_start, t_end].
    `ibis_ms` are the detector's own accepted intervals (consecutive accepted
    beats only) so a rejected interval does not merge two beats into a fake one."""
    bt = np.asarray([b for b in beat_times if t_start <= b <= t_end])
    out = {'nBeats': int(len(bt))}
    if ibis_ms is not None and len(ibis_ms) >= 3:
        ibi = np.asarray(ibis_ms, float)
        out['hr'] = float(60000 / np.median(ibi)); out['rmssd'] = rmssd(ibi)
    elif len(bt) >= 3:
        ibi = np.diff(bt) * 1000
        ibi = ibi[(ibi > 300) & (ibi < 2000)]
        out['hr'] = float(60000 / np.median(ibi)) if len(ibi) else float('nan')
        out['rmssd'] = rmssd(ibi)
    if truth is not None:
        tr = np.asarray([x for x in truth['beatTimesSec'] if t_start <= x <= t_end])
        n, errs = match(bt, tr)
        out['truthBeats'] = int(len(tr)); out['matched'] = n
        out['sensitivity'] = n / len(tr) if len(tr) else float('nan')
        out['falseBeats'] = int(len(bt) - n)
        if errs:
            e = np.asarray(errs); out['timingErrStdMs'] = float(e.std()); out['timingErrMeanMs'] = float(e.mean())
        out['truthRmssd'] = truth['rmssdMs']; out['truthHr'] = truth['hr']
    return out

results = []
for path in sorted(glob.glob(os.path.join(sys.argv[1], '*.json'))):
    d = json.load(open(path))
    t = np.asarray([s['t'] for s in d['samples']], float) / 1000.0
    r = np.asarray([s['r'] for s in d['samples']], float)
    t = t - t[0]
    fs = round(1.0 / np.median(np.diff(t)))
    grid, x = uniform(t, -r, fs)  # inverted: systole = maximum
    entry = {'name': d['name'], 'kind': d['kind'], 'fs': int(fs), 'durationSec': float(t[-1])}
    truth = d.get('truth')
    if truth:  # engine and HeartPy times are relative to the first sample; shift truth the same way
        first = d['samples'][0]['t'] / 1000.0
        truth = dict(truth); truth['beatTimesSec'] = [x - first for x in truth['beatTimesSec']]
    # --- HeartPy -------------------------------------------------------
    hpy = {'ok': False}
    try:
        filtered = hp.filter_signal(x, cutoff=[0.7, 3.5], sample_rate=fs, order=3, filtertype='bandpass')
        wd, m = hp.process(filtered, sample_rate=fs, bpmmin=40, bpmmax=180, clean_rr=True, high_precision=True, high_precision_fs=1000.0)
        peaks = np.asarray(wd['peaklist'], float); keep = np.asarray(wd['binary_peaklist'], bool)
        # high_precision stores refined times in wd['peaklist'] in the upsampled domain? heartpy keeps
        # peaklist as indices at the original fs; use hp's rr_list (ms) with mask for accepted intervals.
        acc_times = grid[0] + peaks[keep] / fs
        hpy = {'ok': True, 'bpm': float(m['bpm']), 'rmssd': float(m['rmssd']), 'sdnn': float(m['sdnn']),
               'peaksDetected': int(len(peaks)), 'peaksKept': int(keep.sum()), 'acceptedTimes': acc_times.tolist(),
               'rrCorrected': [float(v) for v in wd.get('RR_list_cor', [])]}
    except Exception as e:
        hpy = {'ok': False, 'error': str(e)[:200]}
    # --- HeartPy on the span where ppg-js found a steady finger (what an SQI-based trim would give it) ----
    good_w = [w for w in d['ppgjs']['windows'] if w['good']]
    hpy_trim = {'ok': False}
    if good_w:
        ta, tb = min(w['start'] for w in good_w), max(w['t'] for w in good_w)
        sel = (grid >= ta) & (grid <= tb)
        try:
            filtered = hp.filter_signal(x[sel], cutoff=[0.7, 3.5], sample_rate=fs, order=3, filtertype='bandpass')
            wd2, m2 = hp.process(filtered, sample_rate=fs, bpmmin=40, bpmmax=180, clean_rr=True, high_precision=True, high_precision_fs=1000.0)
            peaks2 = np.asarray(wd2['peaklist'], float); keep2 = np.asarray(wd2['binary_peaklist'], bool)
            hpy_trim = {'ok': True, 'bpm': float(m2['bpm']), 'rmssd': float(m2['rmssd']), 'peaksDetected': int(len(peaks2)), 'peaksKept': int(keep2.sum()), 'acceptedTimes': (grid[sel][0] + peaks2[keep2] / fs).tolist(), 'span': [ta, tb], 'rrCorrected': [float(v) for v in wd2.get('RR_list_cor', [])]}
        except Exception as e:
            hpy_trim = {'ok': False, 'error': str(e)[:200]}
    # --- ppg-js ---------------------------------------------------------
    pj_beats = [b['t'] for b in d['ppgjs']['beats'] if b['valid'] and b['good']]
    pj_ibis = [b['ibiMs'] for b in d['ppgjs']['beats'] if b['valid'] and b['good'] and not b.get('lowSnr')]
    good_windows = [w for w in d['ppgjs']['windows'] if w['good']]
    pj = {'goodWindows': len(good_windows), 'windows': len(d['ppgjs']['windows']),
          'hrWindows': [w['hr'] for w in good_windows], 'rmssdWindows': [w['rmssd'] for w in good_windows],
          'floorWindows': [w['floor'] for w in good_windows], 'acceptedTimes': pj_beats}
    # --- comparable span: from first ppg-js good window start to the end ----
    t0 = min([w['start'] for w in good_windows], default=0.0); t1 = max([w['t'] for w in good_windows], default=float(t[-1]))
    entry['span'] = [t0, t1]
    entry['heartpy'] = {**hpy, 'eval': evaluate(d['name'], hpy.get('acceptedTimes', []), truth, t0, t1, hpy.get('rrCorrected')) if hpy['ok'] else None}
    entry['heartpyTrimmed'] = {**hpy_trim, 'eval': evaluate(d['name'], hpy_trim.get('acceptedTimes', []), truth, t0, t1, hpy_trim.get('rrCorrected')) if hpy_trim['ok'] else None}
    entry['ppgjs'] = {**{k: v for k, v in pj.items() if k != 'acceptedTimes'}, 'eval': evaluate(d['name'], pj_beats, truth, t0, t1, pj_ibis)}
    # agreement between the two detectors on real data
    if hpy['ok']:
        n, errs = match([b for b in pj_beats if t0 <= b <= t1], [b for b in hpy['acceptedTimes'] if t0 <= b <= t1], tol=0.1)
        entry['agreement'] = {'ppgjsBeats': len([b for b in pj_beats if t0 <= b <= t1]), 'heartpyBeats': len([b for b in hpy['acceptedTimes'] if t0 <= b <= t1]), 'matchedWithin100ms': n}
    results.append(entry)
    e_h = entry['heartpy']['eval'] or {}; e_p = entry['ppgjs']['eval']
    def f(v, nd=1): return '-' if v is None or (isinstance(v, float) and math.isnan(v)) else (f'{v:.{nd}f}' if isinstance(v, float) else str(v))
    e_t = entry['heartpyTrimmed']['eval'] or {}
    def cell(ok, e, m):
        if not ok: return 'FAILED'
        return f"hr={f(m.get('bpm'))} rmssd={f(m.get('rmssd'))} sens={f(e.get('sensitivity'),2)} false={e.get('falseBeats','-')} tErr={f(e.get('timingErrStdMs'))}"
    print(f"{d['name']:<26} | HP raw: {cell(hpy['ok'], e_h, hpy):<52} | HP trimmed: {cell(hpy_trim['ok'], e_t, hpy_trim):<52} | ppg-js: hr={f(e_p.get('hr'))} rmssd={f(e_p.get('rmssd'))} sens={f(e_p.get('sensitivity'),2)} false={e_p.get('falseBeats','-')} tErr={f(e_p.get('timingErrStdMs'))} | truth hr={f(truth['hr'] if truth else None)} rmssd={f(truth['rmssdMs'] if truth else None)}", file=sys.stderr)
    continue
    print(f"{d['name']:<28} fs={fs:>2} | HeartPy hr={f(hpy.get('bpm'))} rmssd={f(hpy.get('rmssd'))} kept={hpy.get('peaksKept','-')}/{hpy.get('peaksDetected','-')} sens={f(e_h.get('sensitivity'),2)} false={e_h.get('falseBeats','-')} tErr={f(e_h.get('timingErrStdMs'))} | ppg-js hr={f(e_p.get('hr'))} rmssd={f(e_p.get('rmssd'))} beats={e_p.get('nBeats')} sens={f(e_p.get('sensitivity'),2)} false={e_p.get('falseBeats','-')} tErr={f(e_p.get('timingErrStdMs'))} | truth hr={f(truth['hr'] if truth else None)} rmssd={f(truth['rmssdMs'] if truth else None)}", file=sys.stderr)
json.dump(results, sys.stdout, indent=1)
