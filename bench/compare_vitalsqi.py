"""vital_sqi signal-quality indices vs ppg-js's quality gate.

vital_sqi scores fixed-length segments with scalar SQIs (skewness, kurtosis,
entropy, perfusion, zero-crossing rate, SNR, and MSQ: agreement between two
peak detectors) and a user-supplied rule set decides which segments to keep.
No rule set ships with the package, so this comparison is threshold-free:
for each SQI we report the rank separability (AUC) between segments ppg-js
marks good and segments it rejects, and, on the simulator, between segments
that are truly clean and segments that contain a motion burst, a finger
lift, a weak beat, or the pre-placement start. AUC 0.5 = no information,
1.0 = perfect separation (0.0 = perfect but inverted).

  bench-venv/bin/python bench/compare_vitalsqi.py bench/out > bench/vitalsqi-results.json
"""
import json, sys, glob, os, warnings, math
import numpy as np
warnings.filterwarnings('ignore')
from vital_sqi.sqi import standard_sqi as ssq
from vital_sqi.sqi import rpeaks_sqi as rsq
from vital_sqi.common.rpeak_detection import PeakDetector
import heartpy as hp

SEG = 5.0

def auc(pos, neg):
    pos = [p for p in pos if np.isfinite(p)]; neg = [n for n in neg if np.isfinite(n)]
    if len(pos) < 2 or len(neg) < 2: return float('nan')
    allv = np.asarray(pos + neg); ranks = allv.argsort().argsort() + 1
    rp = ranks[:len(pos)].sum()
    return float((rp - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))

def segment_sqis(x, fs):
    out = {}
    try: out['skewness'] = float(ssq.skewness_sqi(x))
    except Exception: out['skewness'] = float('nan')
    try: out['kurtosis'] = float(ssq.kurtosis_sqi(x))
    except Exception: out['kurtosis'] = float('nan')
    try: out['entropy'] = float(ssq.entropy_sqi(x))
    except Exception: out['entropy'] = float('nan')
    try: out['perfusion'] = float(ssq.perfusion_sqi(y=x, x=x))
    except Exception: out['perfusion'] = float('nan')
    try: out['zeroCrossing'] = float(ssq.zero_crossings_rate_sqi(x))
    except Exception: out['zeroCrossing'] = float('nan')
    try: out['snr'] = float(np.atleast_1d(ssq.signal_to_noise_sqi(x))[0])
    except Exception: out['snr'] = float('nan')
    try:
        # MSQ: agreement between two of vital_sqi's own peak detectors (ids 7 and 6 are its defaults).
        out['msq'] = float(rsq.msq_sqi(x, peak_detector_1=7, peak_detector_2=6, wave_type='ppg'))
    except Exception:
        out['msq'] = float('nan')
    return out

def truly_clean(d, a, b):
    """Simulator ground truth for a segment [a, b): finger present, no motion burst, no weak beat, past the first 10 s."""
    if d['kind'] != 'sim': return None
    o = d.get('options', {})
    if a < 10: return False
    for m in o.get('motionBursts', []):
        if a < m['startSec'] + m['durationSec'] + 4 and b > m['startSec'] - 1: return False
    for l in o.get('fingerLifts', []):
        if a < l['startSec'] + l['durationSec'] + 8 and b > l['startSec'] - 1: return False
    if o.get('everyNthMissed'): return False
    return True

results = []
for path in sorted(glob.glob(os.path.join(sys.argv[1], '*.json'))):
    d = json.load(open(path))
    t = np.asarray([s['t'] for s in d['samples']], float) / 1000.0; t -= t[0]
    r = np.asarray([s['r'] for s in d['samples']], float)
    fs = int(round(1.0 / np.median(np.diff(t))))
    grid = np.arange(0, t[-1], 1.0 / fs); x = np.interp(grid, t, -r)
    xf = hp.filter_signal(x, cutoff=[0.5, 5.0], sample_rate=fs, order=3, filtertype='bandpass')
    win = {w['t']: w for w in d['ppgjs']['windows']}
    segs = []
    for w in d['ppgjs']['windows']:
        a, b = w['start'], w['t']
        sel = (grid >= a) & (grid < b)
        if sel.sum() < fs * 2: continue
        s = segment_sqis(xf[sel], fs)
        segs.append({'a': a, 'b': b, 'ppgjsGood': bool(w['good']), 'state': w['state'], 'clean': truly_clean(d, a, b), **s})
    keys = ['skewness', 'kurtosis', 'entropy', 'perfusion', 'zeroCrossing', 'snr', 'msq']
    vsGate = {k: auc([s[k] for s in segs if s['ppgjsGood']], [s[k] for s in segs if not s['ppgjsGood']]) for k in keys}
    vsTruth = {k: auc([s[k] for s in segs if s['clean'] is True], [s[k] for s in segs if s['clean'] is False]) for k in keys} if d['kind'] == 'sim' else None
    gateVsTruth = None
    if d['kind'] == 'sim':
        tp = sum(1 for s in segs if s['clean'] and s['ppgjsGood']); fn = sum(1 for s in segs if s['clean'] and not s['ppgjsGood'])
        fp = sum(1 for s in segs if s['clean'] is False and s['ppgjsGood']); tn = sum(1 for s in segs if s['clean'] is False and not s['ppgjsGood'])
        gateVsTruth = {'tp': tp, 'fn': fn, 'fp': fp, 'tn': tn}
    results.append({'name': d['name'], 'kind': d['kind'], 'segments': len(segs), 'good': sum(1 for s in segs if s['ppgjsGood']), 'aucVsPpgjsGate': vsGate, 'aucVsTruth': vsTruth, 'ppgjsGateVsTruth': gateVsTruth, 'segmentSqis': segs})
    f = lambda v: '  -  ' if v is None or (isinstance(v, float) and math.isnan(v)) else f'{v:5.2f}'
    print(f"{d['name']:<26} segs={len(segs):>2} good={sum(1 for s in segs if s['ppgjsGood']):>2} | AUC vs ppg-js gate: " + ' '.join(f'{k[:5]}={f(vsGate[k])}' for k in keys) + (f" | AUC vs truth: " + ' '.join(f'{k[:5]}={f(vsTruth[k])}' for k in keys) + f" | gate tp/fn/fp/tn={gateVsTruth['tp']}/{gateVsTruth['fn']}/{gateVsTruth['fp']}/{gateVsTruth['tn']}" if vsTruth else ''), file=sys.stderr)
json.dump(results, sys.stdout)
