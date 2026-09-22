# Analytics worth computing from O2Ring data

Research notes (September 2026) on which metrics are genuinely useful given what
the ring records: **one sample every 4 s** of SpO2 (integer %), pulse rate
(integer bpm, averaged over several beats) and a motion byte (0–255). No raw
PPG, no beat-to-beat intervals, no airflow, no body position.

This is for a personal wellness dashboard. Nothing here diagnoses anything.

## Ground rules that came out of the research

1. **Event counts depend on the definition more than on the night.** On one real
   8.5 h recording, "drops ≥3 %" ranged from 13 to 222 depending only on how the
   baseline is defined, whether the drop must be held, and whether the trace is
   smoothed. The ring's own count matched "median of the prior 120 s, held ≥8 s".
   Published tools disagree in the same way (JCSM 2017: ODI differs significantly
   between software packages). So: pick one documented definition, print it on
   the report, never change it silently, and show the ring's own count alongside.
2. **Area- and time-based metrics are robust; count-based ones are fragile** at
   4 s / integer resolution. A 3 % event is three quantisation steps deep; device
   averaging removes short events (Farré 1998: up to 60 % underestimation with
   12–21 s averaging; Vagedes 2014: ~6× change in counts between 3 s and 16 s).
3. **One night means little.** Within-person SD of AHI/ODI is ~4.4 events/h
   (Punjabi 2020); single-night severity misclassification is 20–50 %, and
   accuracy plateaus at about 14 nights (Lechat 2022). Headline numbers should be
   multi-night medians.
4. **Compare to your own baseline, not to population cut-offs**, for anything
   pulse- or movement-related. Published thresholds come from research oximeters
   sampled at ≥1 Hz and do not transfer to a 4 s averaged device.
5. **Clean first.** Drop invalid samples (SpO2 <50 or >100, PR out of range), do
   not interpolate gaps >20 s, treat an adjacent-sample SpO2 fall ≥8 % or rise
   ≥12 % as artefact, flag events that coincide with heavy motion, and report
   "% of night valid". Use valid hours as the denominator and say so
   (recording-time denominators read ~20 % lower than sleep-time ones).

## Tier 1 — build these

| Metric | Recipe (4 s samples) | Why |
|---|---|---|
| **T90 / T88 / T85** and longest run <90 % | count of valid samples below threshold × 4 s; minutes and % of valid time | Most robust oximetry metric. CMS: ≤88 % for ≥5 min cumulative. T90 >12 min (Baumert 2020) and >22 min (Oldenburg 2016) predicted outcomes in cohorts. Sensitive to device bias when SpO2 sits near 90. |
| **ODI 3 % and 4 %**, fixed definition | Peak-to-nadir: fall ≥3/4 % from the preceding local max, fall time 8–120 s, one 1 % up-tick tolerated, event ends on recovery to peak−1 or ⅔ of the drop (cap 180 s). Store start, nadir, end, depth, duration, area per event. Show the ring's header count too. | The classical screening surrogate (Chung 2012: ODI >10 → 93 % sens / 75 % spec for AHI >15). O2Ring vs PSG: AUC 0.91 for AHI ≥15 in a high-prevalence clinic cohort (Tisyakorn 2024). Treat as a trend, not an absolute. |
| **Hypoxic burden (approx.)** %·min/h | Σ over events of (baseline − SpO2) × 4 s ÷ 60 ÷ valid hours; baseline = max SpO2 in the 100 s before the nadir (HBOxi / Kulkas style) | Combines depth, duration and frequency; less definition-sensitive than counts. Azarbarzin 2019 quintile cut-points 20/34/53/88 %·min/h (MrOS). Oximetry-only versions correlate 0.81 with the scored-event original but are weaker predictors — compare loosely. |
| **Mean / median / baseline SpO2** | baseline = 90th–95th percentile of the night | Context for everything else. Differences of 1–2 % between nights are within oximeter noise (Arms ~2–3 %). |
| **Sleeping heart rate vs personal baseline** | mean and median PR; lowest rolling **30-min** and 5-min mean (≥80 % valid); never the single lowest sample. Flag when > baseline + max(3 bpm, 2×MAD) over a trailing 14–28-night median | Best-evidenced pulse metric. Alcohol: ~+2.5 bpm per drink above personal average (Grosicki 2026, 5.1 M person-days); dose-dependent in an RCT (de Zambotti 2021). Illness: resting-HR elevation preceded symptoms in 63 % of COVID cases (Mishra 2020). Wearable nocturnal HR is accurate to ~1–2 bpm. |
| **Desaturation event classes** | for each ≥3 % event look −10…+30 s around the nadir for a pulse rise ≥6 bpm (vs median of prior 40 s) and/or a movement burst → A: desat+pulse+motion, B: desat+pulse, C: desat only. Report "arousal-linked desaturations /h" = (A+B)/h | Best use of all three channels. A ≥6 bpm rise as an arousal surrogate improved home-test agreement with PSG (Lachapelle 2019; ICC 0.77→0.84). Separates physiological events from quantisation noise. |
| **Movement bouts & fragmentation** | bouts = runs of non-zero motion merged across ≤8 s gaps → bouts/h, bouts ≥30 s ("major movements"), longest still period. Fragmentation index = % mobile 30-s epochs + % immobile bouts ≤1 min (Actiware definition) | Needs no calibration of the unknown motion byte. SFI tracks sleep architecture better than actigraphic efficiency/WASO. |
| **Movements in sleep** (sleep-lab definition) | the same bouts, but only inside the estimated sleep window, outside wake-like stretches ≥5 min, and ≤45 s long; per hour of that sleep time. Bouts ≥30 s there = "major movements in sleep" (≈ position changes). Shown against the bands in *Movement reference values* below, chosen by the optional sex / birth year in `.env` | Mirrors the AASM-style large-muscle-group-movement (LMM) rule (≥3 s, ≤45 s, after ≥10 s of sleep) closely enough to compare with published counts; the whole-recording bouts/h above runs 2–3× higher because it also counts wake and long restless runs. |
| **Multi-night view** | rolling 7/14/30-night median + IQR of the above (14 headline), % of nights with ODI ≥5/15/30, best/worst, n shown, nights <4 h valid excluded | The single most important presentation change (ground rule 3). |
| **Data quality** | valid hours, % rejected (invalid / motion-suspect), definition strings | Every other number depends on it. |

## Tier 2 — worth adding after Tier 1

- **Delta index** (Levy 1996): mean |difference| of successive 12 s SpO2 means
  (3 samples). Suits 4 s storage; cut-off 0.6 is high-sensitivity (98 %) /
  low-specificity (46 %).
- **Events by hour of night**, depth × duration table (3–4, 5–9, 10–14, ≥15 % ×
  10–30, 30–60, >60 s), SpO2 histogram / cumulative-time table — the standard
  sections of clinical overnight-oximetry reports (Nonin nVision, ApneaLink).
- **Pulse-rate rise index** (rises ≥6 and ≥10 bpm per hour; median of prior 40 s
  as baseline, held ≥2 samples, 30 s refractory). Adachi 2003: r = 0.68 with EEG
  arousal index. Personal trend only — the 40/h cut-off does not transfer.
- **Pulse response to desaturations (ΔHRoxi)**, Blanchard 2025 method: ensemble-
  average PR ±100 s around nadirs, mean of per-event (max − preceding min).
  Strong outcome evidence (Azarbarzin 2021; U-shaped risk) but only meaningful
  with ≥10–20 clean events, and published bpm thresholds must not be applied.
- **Night-curve shape**: time of the 30-min pulse nadir as a fraction of the
  night (0.35–0.65 "hammock"; >0.8 late nadir, associated with alcohol / late
  meals — vendor heuristic, not outcome data) and first-half slope.
- **Sustained tachy/bradycardia episodes**: >90 bpm or <40 bpm for >30 s (AASM
  adult rules), motion-gated; informational tier <50 bpm ≥5 min. Reject ×2 / ×0.5
  steps as artefact.
- **Periodicity indicator**: share of SpO2 (and PR) spectral power in
  0.014–0.033 Hz (30–70 s cycles; Zamarrón 2003). Within Nyquist (0.125 Hz).
  Pattern only — oximetry cannot tell central from obstructive.
- **Personal-baseline anomaly flags**: robust z = (x − median)/(1.4826·MAD) over
  the trailing 30 nights, needs ≥14 nights, flag |z| ≥2 (stronger when
  consecutive). Use log(ODI+1) for skewed metrics.
- **Tags instead of free-text-only notes** (alcohol, position, congestion, late
  meal, CPAP/MAD, finger used) with with/without comparisons: median difference,
  bootstrap interval, n per arm. With night-to-night SD ≈4.4/h, 7 nights per arm
  only detects ≥5/h differences; aim for 10–14 per arm and alternate (ABAB).
- **Estimated sleep window / TST / WASO** from an Oakley-style kernel + Webster
  rescoring, self-calibrated, labelled "estimate — overestimates sleep"
  (actigraphy wake specificity ~33 %, Marino 2013).

## Implementation status

Tier 1 is implemented in `o2ring_analytics.py` (ALGO_VERSION 2) together with these Tier 2 items: delta index,
events by hour, depth × duration table, time-below table, pulse-rate rise index, ΔHRoxi, night-curve shape,
tachy/bradycardia episodes, the periodicity indicator, the movement-based sleep-window estimate, baseline flags
and tags. ALGO_VERSION 4 added the sleep-lab style movement count and the reference bands. The periodicity and sleep-estimate thresholds (≥50 % in-band power with a ≥50 % narrow peak and a ≥3 %
swing; Oakley score >40 on the raw motion byte) are this project's own choices, not validated cut-offs.

## Movement reference values

Published counts of body movements in healthy sleepers, and how this project's numbers relate to them. All of them come
from EMG, video or bed sensors in a lab; the ring's finger accelerometer at one sample per 4 s sees the same kind of
movement but not with the same sensitivity, so treat the bands as a neighbourhood, not a pass/fail line.

| Study | What was counted | Healthy values | Used here for |
|---|---|---|---|
| Ibrahim 2023 (SLEEP), 100 healthy adults 19–77, video-PSG | large muscle group movements: EMG/artefact on ≥2 channels, 3–45 s, after ≥10 s of sleep; per hour of sleep | median 6.8/h, IQR 4.5–10.8, 90th pct 15.0, 95th pct 17.6; NREM 6.2, REM 8.4; higher in men (p = 0.018); total index not age-dependent, movements ending in an awakening rise with age; 83 % coincide with an arousal or awakening | the "movements in sleep" verdict: ≤10.8 typical, ≤17.6 high, above that very high |
| Montini 2024 (SLEEP), 50 healthy adults 20–70, video-PSG | every movement ≥100 ms (leg movements, oro-alimentary automatisms, position changes, …) | median 11/h, IQR 8–15; men 12.5/h vs women 7/h; falls N1 → N3, rises again in REM; no age effect | the sex-specific "counting every twitch" line in the report |
| Mogavero 2025 (J Sleep Res), 141 people from school age to older adults | LMM by the same rule, across the lifespan | LMM, and LMM with arousals/awakenings, rise with age; in adults they concentrate in REM | wording only: older adults sit naturally higher |
| De Koninck 1992 (SLEEP), 50 people in five age groups, filmed 4 nights | whole-body position changes | 4.4 (3–5 y), 4.7 (8–12), 3.6 (18–24), 2.7 (35–45), 2.1 (65–80) per hour | the age band shown next to "major movements in sleep per hour" |
| Bliwise 2023 (SLEEP, editorial) | 1930s bed-sensor and film studies | 2.5–10 gross movements per hour; consistent with the LMM figures 90 years later | context |
| Kováčová & Stebelová 2021 (IJERPH), 74 healthy adults, wrist actigraphy | Actiware fragmentation index, moving time, immobile bouts | women and younger people less fragmented; values in boxplots only | confirms the sex effect for the actigraphic fragmentation index |

Why sex and age but not weight: the movement normative work reports sex and age effects and nothing on body mass. BMI is
stored with each night (if height and weight are given) only as context for the oximetry side, whose clinic-cohort
cut-offs come from populations with a known BMI mix.

## Do not build

| Idea | Why not |
|---|---|
| HRV (RMSSD, SDNN, LF/HF), "stress" or "recovery" scores | Need beat-to-beat intervals; 4 s averaged PR is a low-pass filter; HF band is above Nyquist |
| AF / irregular-rhythm detection | Averaging destroys exactly the irregularity it relies on |
| Sleep stages (REM / deep / light) | Published staging relies on HRV; motion + averaged PR gives ~decoration |
| An "AHI estimate" | No validated algorithm for this data; report ODI and event classes instead |
| "Non-dipper" label | Needs daytime heart rate the ring never records |
| PLM index | Finger sensor, 4 s epochs: cannot see 0.5–10 s leg movements |
| Single lowest SpO2 / lowest PR sample as a headline | Dominated by artefact (SHHS median "minimum SpO2" is 79 % even without OSA); use 1st percentile or a value held ≥2 samples |
| De/resaturation slopes, ApEn/CTM reference ranges | 2–5 integer points per limb; reference values assume 1 Hz |

## Presentation guard-rails

- Print the event definition and denominator on every report; state that a
  normal-looking night does not rule anything out (oximetry misses hypopnoeas and
  arousal-only events).
- "Consider talking to a doctor" prompts only from multi-night data: e.g.
  14-night median ODI4 ≥15, or ≥5 with symptoms; ODI ≥15 on a third or more of
  nights; persistently elevated T90 or CMS-style ≥5 min ≤88 %; repeated held
  nadirs <80 %.
- Accuracy caveats: consumer oximeters are ~±2–3 %, worse with poor perfusion,
  motion, nail polish, and darker skin pigmentation (Sjoding 2020; FDA 2025 draft
  guidance). AASM 2018: consumer sleep tech can inform a conversation with a
  clinician, not replace testing.

## Key sources

Azarbarzin 2019 (Eur Heart J, hypoxic burden) · Esmaeili 2023 (HBOxi) · Levy &
Behar 2021 (oximetry biomarker toolbox, npj Digit Med) · Chung 2012 (ODI vs AHI)
· Tisyakorn 2024 (O2Ring vs PSG, Sleep Breath) · Farré 1998, Vagedes 2014
(averaging time) · Levy 1996 (delta index) · Oldenburg 2016, Baumert 2020 (T90)
· Azarbarzin 2021 (AJRCCM, ΔHR) · Blanchard 2025 (ERJ, ΔHRoxi) · Ibrahim 2023, Montini 2024, Mogavero 2025, De Koninck 1992, Bliwise 2023 (movements in sleep) · Adachi 2003,
Lachapelle 2019 (pulse-rate rises) · Zamarrón 2003 (periodicity) · de Zambotti
2021, Grosicki 2026 (alcohol and nocturnal HR) · Mishra 2020, Radin 2020
(illness) · Marino 2013 (actigraphy validity) · Punjabi 2020, Roeder 2020,
Lechat 2022 (night-to-night variability) · Kolla 2018 (alcohol and AHI) · AASM
scoring manual / cardiac rules · FDA pulse-oximeter communications.

Unverified at primary source when this was written: Adachi's exact rise rule,
OSCAR's default thresholds, the ring's internal averaging time, the Wellue
"O2 Score" formula (unpublished), and any peer-reviewed validation of the ring's
pulse-rate channel (none found).
