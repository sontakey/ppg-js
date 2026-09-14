# Benchmarks

Side-by-side of ppg-js against HeartPy (beat detection, HR, RMSSD) and
vital_sqi (segment signal-quality indices) on the real recordings in
`test/fixtures/` and on simulator scenarios with ground truth. Results and
method are written up in `docs/audit/BENCHMARK-2026-09.md`.

```bash
# 1. datasets: real fixtures + simulator scenarios, each with ppg-js's own result
node --import tsx bench/export-datasets.mjs bench/out

# 2. Python side (HeartPy 1.2.6, vital_sqi 0.1.x; vital_sqi needs numpy<2, astropy<6, nolds 0.5.2)
python3 -m venv .venv && .venv/bin/pip install "numpy==1.26.4" "scipy<1.14" heartpy vital-sqi "nolds==0.5.2" "astropy<6" "pandas<2.2"
.venv/bin/python bench/compare_heartpy.py bench/out > bench/heartpy-results.json
.venv/bin/python bench/compare_vitalsqi.py bench/out > bench/vitalsqi-results.json
```

Both Python scripts print a one-line summary per dataset on stderr and the
full per-dataset detail as JSON on stdout. `bench/out/` and the result files
are git-ignored.
