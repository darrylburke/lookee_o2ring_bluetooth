#!/usr/bin/env python3
"""Per-night analytics for O2Ring recordings (see docs/analytics-research.md).

Pure functions over the 4-second samples - no database, no third-party imports -
so the same code feeds MySQL (o2ring_db.py), the static reports and the tests.

Every definition used is spelled out in DEFINITIONS and travels with the results,
because desaturation counts in particular depend heavily on the definition.
Bump ALGO_VERSION whenever a definition changes; `o2ring_db.py --reanalyze`
recomputes stored nights.
"""
import math
import statistics as st

ALGO_VERSION = 4
DT = 4  # seconds per sample
MIN_TREND_HOURS = 4  # nights shorter than this stay out of trends and baselines

DEFINITIONS = {
    "valid": "SpO2 50-100 % and pulse 25-250 bpm; a fall >=8 % or rise >=12 % between adjacent samples is "
             "treated as artefact. Rates use valid recording hours (not sleep time), which reads lower than a sleep lab.",
    "desaturation": "Peak-to-nadir: SpO2 falls >=3 % from the preceding local peak within 8-120 s (one 1 % up-tick "
                    "tolerated); the event ends on recovery to peak-1 or two thirds of the drop (max 180 s). "
                    "ODI 4 % counts the same events with depth >=4 %.",
    "hypoxic_burden": "Sum over desaturations of (baseline - SpO2) x time, baseline = highest SpO2 in the 100 s before "
                      "the nadir, per valid hour (%min/h). Oximetry-only approximation of Azarbarzin 2019.",
    "arousal_linked": "A desaturation with a pulse rise >=6 bpm (vs the median of the prior 40 s) between 10 s before "
                      "and 30 s after its nadir. Class A also has movement in that window, B has not, C is desaturation only.",
    "motion_suspect": "Desaturation whose fall coincides with heavy movement (top decile of the night's non-zero motion, "
                      "at least 20) - possibly a motion artefact.",
    "pulse_rise": "Pulse >=6 (or >=10) bpm above the median of the preceding 40 s (excluding the last 8 s), held for "
                  ">=2 samples; rises within 30 s are merged.",
    "sleeping_hr": "Lowest rolling 30-minute and 5-minute mean pulse (windows >=80 % valid). Never a single sample.",
    "movement": "Bout = run of non-zero motion samples, gaps <=8 s merged; major movement = bout >=30 s. "
                "Fragmentation index = % of 30-s epochs with movement + % of still periods lasting <=1 min.",
    "sleep_movements": "Bouts counted the way sleep-lab 'large muscle group movement' studies do: only inside the estimated "
                       "sleep window, outside wake-like stretches of >=5 min, and no longer than 45 s (a 4-s sample already meets "
                       "the 3-s minimum); per hour of that sleep time. Major = bouts >=30 s there, a rough stand-in for position "
                       "changes. Reference values come from EMG/video sleep-lab studies of healthy adults (Ibrahim 2023 median "
                       "6.8/h, upper quartile 10.8, 95th percentile 17.6; Montini 2024 men 12.5/h, women 7/h; De Koninck 1992 "
                       "position changes by age), so a finger sensor can only be 'in the neighbourhood' of them.",
    "delta_index": "Mean absolute difference between successive 12-second SpO2 means (Levy 1996).",
    "pulse_response": "Mean over desaturations of (peak pulse - preceding minimum) inside a window taken from the "
                      "night's ensemble-averaged pulse around the nadirs (Blanchard 2025); needs >=10 events.",
    "odi_rows": "The app's ODI rows, computed here from the desaturation events above. Time in drops = summed event "
                "length (fall + recovery); % time is relative to valid recording time; drops per oxygen range are "
                "ODI 4 % events grouped by their lowest SpO2.",
    "sleep_estimate": "From movement only. Per minute, activity = sum of the motion values; Oakley weighting "
                      "(A-2/25 + A-1/5 + A0 + A+1/5 + A+2/25) above 40 scores the minute wake-like; Webster rules then extend "
                      "long wake periods and absorb short sleep islands; minutes with no readings (ring off) count as wake. The sleep window runs from the first stretch of >=10 "
                      "quiet minutes to the end of the last stretch of >=5. The motion byte is uncalibrated and actigraphy cannot see quiet "
                      "wakefulness, so this overestimates sleep - use it for trends, not as a sleep measurement.",
    "periodicity": "SpO2 and pulse are cut into 512-second segments (50 % overlap), detrended and Fourier-analysed. A segment "
                   "is 'cyclic' when >=50 % of its SpO2 variation (0.004-0.125 Hz) lies in 30-70 second cycles, one narrow peak "
                   "holds >=50 % of that band, and SpO2 swings >=3 %. Repeating cycles suggest periodic breathing events; "
                   "oximetry cannot tell obstructive from central ones. Thresholds are this project's own, for trending only.",
    "episodes": "Pulse >90 bpm or <40 bpm sustained >30 s with no movement in or 30 s before the run (AASM adult rules).",
}


def resolve_profile(env, when):
    """Optional sex / birth year / height / weight from an environment-style dict -> {sex, age, bmi} (None = unknown).
    `when` is the date of the night, so the stored age is the age that night."""
    sex = str(env.get("O2RING_SEX", "")).strip().lower()
    sex = "m" if sex in ("m", "male", "man") else "f" if sex in ("f", "female", "woman") else None
    num = lambda key: float(env[key]) if str(env.get(key, "")).replace(".", "", 1).isdigit() else None
    year, height, weight = num("O2RING_BIRTH_YEAR"), num("O2RING_HEIGHT_CM"), num("O2RING_WEIGHT_KG")
    age = int(when.year - year) if year and 1900 <= year <= when.year else None
    bmi = round(weight / (height / 100) ** 2, 1) if height and weight else None
    return {"sex": sex, "age": age, "bmi": bmi}


# Published movement counts in healthy adults (see docs/analytics-research.md, "Movement reference values").
_LMM_REFERENCE = {"median": 6.8, "iqr": [4.5, 10.8], "p95": 17.6,
                  "source": "Ibrahim 2023: large muscle group movements, 100 healthy adults 19-77, video-PSG"}
_ALL_MOVEMENTS = {"m": 12.5, "f": 7, None: 11}      # Montini 2024: every movement >=100 ms, 50 healthy adults 20-70
_POSITION_SHIFTS = [(18, 24, 3.6), (35, 45, 2.7), (65, 80, 2.1)]   # De Koninck 1992: position changes/h by age group


def movement_reference(profile, per_h=None):
    """Which published bands apply to this person, and where a per-hour value falls against the healthy distribution."""
    sex, age = profile.get("sex"), profile.get("age")
    shifts = None
    if age is not None:
        lo, hi, rate = min(_POSITION_SHIFTS, key=lambda g: min(abs(age - g[0]), abs(age - g[1])) if not g[0] <= age <= g[1] else 0)
        shifts = {"per_h": rate, "group": f"{lo}-{hi}", "source": "De Koninck 1992: position changes, filmed, 4 nights per person"}
    verdict = None if per_h is None else "typical" if per_h <= _LMM_REFERENCE["iqr"][1] else \
        "high" if per_h <= _LMM_REFERENCE["p95"] else "very_high"
    return {
        "lmm": {**_LMM_REFERENCE, "verdict": verdict},
        "all_movements": {"median": _ALL_MOVEMENTS[sex], "group": {"m": "men", "f": "women"}.get(sex, "all"),
                          "source": "Montini 2024: every movement >=100 ms, video-PSG; men move about 1.8x as often as women"},
        "position_shifts": shifts,
    }


def _clean(samples):
    spo2, pr, motion = [], [], []
    for s, p, m in samples:
        spo2.append(s if s is not None and 50 <= s <= 100 else None)
        pr.append(p if p is not None and 25 <= p <= 250 else None)
        motion.append(m or 0)
    for i in range(1, len(spo2)):  # delta filter
        a, b = spo2[i - 1], spo2[i]
        if a is not None and b is not None and (a - b >= 8 or b - a >= 12):
            spo2[i] = None
    return spo2, pr, motion


def _median(values):
    return st.median(values) if values else None


def _percentile(sorted_values, q):
    if not sorted_values:
        return None
    return sorted_values[min(len(sorted_values) - 1, max(0, int(q * len(sorted_values))))]


def find_desaturations(spo2, min_drop=3, min_fall_s=8, max_fall_s=120, max_recovery_s=180):
    """Peak-to-nadir desaturation events (see DEFINITIONS['desaturation'])."""
    n, events, i = len(spo2), [], 0
    while i < n - 1:
        if spo2[i] is None:
            i += 1
            continue
        peak, pi, nadir, ni, j, ticked = spo2[i], i, spo2[i], i, i, False
        while j + 1 < n and spo2[j + 1] is not None:
            nxt, cur = spo2[j + 1], spo2[j]
            if nxt <= cur:
                ticked = False
            elif nxt - cur <= 1 and not ticked and nxt < peak:
                ticked = True
            else:
                break
            j += 1
            if nxt == peak and nadir == peak:
                pi = j  # still on the plateau: the fall starts at its last sample
            if nxt < nadir:
                nadir, ni = nxt, j
            if (j - pi) * DT > max_fall_s:
                break
        fall_s = (ni - pi) * DT
        if peak - nadir >= min_drop and min_fall_s <= fall_s <= max_fall_s:
            target = max(peak - 1, nadir + math.ceil(2 * (peak - nadir) / 3))
            k = ni
            while k + 1 < n and spo2[k + 1] is not None and spo2[k] < target and (k - ni) * DT < max_recovery_s:
                k += 1
            events.append({"start": pi, "nadir_at": ni, "end": k, "peak": peak, "nadir": nadir,
                           "depth": peak - nadir, "duration_s": (k - pi) * DT})
            i = max(k, i + 1)
        else:
            i = max(j, i + 1)
    return events


def find_pulse_rises(pr, threshold):
    """Indices where a pulse rise starts (see DEFINITIONS['pulse_rise'])."""
    rises, i, n, last = [], 12, len(pr), -10 ** 9
    while i < n - 1:
        base = _median([v for v in pr[i - 12:i - 2] if v is not None])
        if base is not None and pr[i] is not None and pr[i + 1] is not None \
                and pr[i] - base >= threshold and pr[i + 1] - base >= threshold:
            if (i - last) * DT > 30:
                rises.append(i)
            last = i
            while i < n and pr[i] is not None and pr[i] - base >= threshold / 2:
                last = i
                i += 1
        i += 1
    return rises


def _rolling_min_mean(values, window):
    """(lowest mean, start index) over windows that are >=80 % valid."""
    best, total, count = None, 0, 0
    for i, v in enumerate(values):
        if v is not None:
            total, count = total + v, count + 1
        if i >= window:
            old = values[i - window]
            if old is not None:
                total, count = total - old, count - 1
        if i >= window - 1 and count >= 0.8 * window:
            mean = total / count
            if best is None or mean < best[0]:
                best = (mean, i - window + 1)
    return best


def _bouts(motion):
    """(first, last) sample index of every movement bout: non-zero runs, gaps of <=2 samples (8 s) merged."""
    n, bouts, i = len(motion), [], 0
    while i < n:
        if motion[i] > 0:
            last = j = i
            while j + 1 < n and (motion[j + 1] > 0 or j + 1 - last <= 2):
                j += 1
                if motion[j] > 0:
                    last = j
            bouts.append((i, last))
            i = last + 1
        else:
            i += 1
    return bouts


def _sleep_movements(bouts, sleep):
    """Bouts inside the estimated sleep window, away from long wake-like stretches, <=45 s (DEFINITIONS['sleep_movements'])."""
    if not sleep or not sleep.get("found"):
        return None
    per_min, timeline = 60 // DT, sleep["timeline"]
    asleep = [False] * len(timeline)
    for a, b in sleep["long_wake_runs"]:            # minute ranges, end exclusive
        for k in range(a, b):
            asleep[k] = None                        # marks a long wake stretch
    for k in range(sleep["onset_min"], sleep["offset_min"]):
        if asleep[k] is False:
            asleep[k] = True
    hours = sum(1 for v in asleep if v) / 60
    inside = [(a, b) for a, b in bouts if a // per_min < len(asleep) and asleep[a // per_min]]
    short = [(a, b) for a, b in inside if (b - a + 1) * DT <= 45]
    major = sum(1 for a, b in inside if (b - a + 1) * DT >= 30)
    return {
        "count": len(short), "per_h": round(len(short) / hours, 1) if hours else None, "hours": round(hours, 2),
        "major": major, "major_per_h": round(major / hours, 2) if hours else None,
        "excluded_long": len(inside) - len(short), "excluded_awake": len(bouts) - len(inside),
    }


def _movement(motion, hours):
    n, bouts = len(motion), _bouts(motion)
    epochs = [sum(motion[k:k + 8]) > 0 for k in range(0, n, 8)]  # ~30 s
    still_runs, run = [], 0
    for mobile in epochs:
        if mobile:
            if run:
                still_runs.append(run)
            run = 0
        else:
            run += 1
    if run:
        still_runs.append(run)
    mobile_pct = 100 * sum(epochs) / len(epochs) if epochs else 0
    short_pct = 100 * sum(1 for r in still_runs if r <= 2) / len(still_runs) if still_runs else 0
    return {
        "bouts": len(bouts),
        "bouts_per_h": round(len(bouts) / hours, 1) if hours else None,
        "major_movements": sum(1 for a, b in bouts if (b - a + 1) * DT >= 30),
        "movement_index_pct": round(mobile_pct, 1),
        "fragmentation_index": round(mobile_pct + short_pct, 1),
        "longest_still_min": round(max(still_runs) * 8 * DT / 60) if still_runs else 0,
        "per_hour": [sum(1 for a, _ in bouts if a * DT // 3600 == h) for h in range(int(n * DT // 3600) + 1)],
    }


def _episodes(pr, motion, test, min_samples):
    found, i, n = [], 0, len(pr)
    while i < n:
        if pr[i] is not None and test(pr[i]):
            j = i
            while j + 1 < n and pr[j + 1] is not None and test(pr[j + 1]):
                j += 1
            if j - i + 1 >= min_samples and not any(motion[max(0, i - 8):j + 1]):
                run = pr[i:j + 1]
                found.append({"start": i, "duration_s": (j - i + 1) * DT, "mean": round(st.mean(run))})
            i = j + 1
        else:
            i += 1
    return found


def _pulse_response(pr, events):
    """Blanchard-style dHRoxi; None when there are too few clean events."""
    half = 25  # +-100 s
    usable = [e for e in events if not e["motion_suspect"] and e["nadir_at"] >= half and e["nadir_at"] + half < len(pr)]
    if len(usable) < 10:
        return None
    ensemble = []
    for k in range(-half, half + 1):
        column = [pr[e["nadir_at"] + k] for e in usable if pr[e["nadir_at"] + k] is not None]
        ensemble.append(st.mean(column) if column else None)
    filled = [v for v in ensemble if v is not None]
    if len(filled) < len(ensemble):
        return None
    peak = max(range(half - 8, half + 13), key=lambda k: ensemble[k])          # peak between -32 s and +48 s
    lo = min(range(0, peak + 1), key=lambda k: ensemble[k])
    hi = min(range(peak, len(ensemble)), key=lambda k: ensemble[k])
    deltas = []
    for e in usable:
        window = [(k, pr[e["nadir_at"] - half + k]) for k in range(lo, hi + 1)]
        window = [(k, v) for k, v in window if v is not None]
        if len(window) < 4:
            continue
        top_k, top = max(window, key=lambda kv: kv[1])
        deltas.append(top - min(v for k, v in window if k <= top_k))
    return {"bpm": round(st.mean(deltas), 1), "events": len(deltas)} if len(deltas) >= 10 else None


def _odi_rows(events, hours):
    total_s = sum(e["duration_s"] for e in events)
    return {"index": round(len(events) / hours, 1) if hours else None, "drops": len(events), "time_in_drops_s": total_s,
            "pct_time_in_drops": round(100 * total_s / (hours * 3600), 1) if hours else None,
            "avg_duration_s": round(total_s / len(events)) if events else 0}


def _sleep_estimate(motion, events, has_data=None):
    """Movement-only sleep window and wake-like minutes (see DEFINITIONS['sleep_estimate'])."""
    per_min = 60 // DT
    activity = [sum(motion[k:k + per_min]) for k in range(0, len(motion) - per_min + 1, per_min)]
    m = len(activity)
    if m < 30:
        return None
    at = lambda i: activity[i] if 0 <= i < m else 0
    wake = [at(i - 2) / 25 + at(i - 1) / 5 + at(i) + at(i + 1) / 5 + at(i + 2) / 25 > 40 for i in range(m)]
    if has_data:  # a minute with no readings at all (ring off, gap between combined recordings) is not sleep
        wake = [w or not any(has_data[i * per_min:(i + 1) * per_min]) for i, w in enumerate(wake)]

    def runs(flags):
        out, i = [], 0
        while i < len(flags):
            j = i
            while j + 1 < len(flags) and flags[j + 1] == flags[i]:
                j += 1
            out.append((flags[i], i, j))
            i = j + 1
        return out

    # Webster rescoring: after >=4/10/15 min of wake the next 1/3/4 min are wake; short sleep islands inside wake are wake
    rescored = wake[:]
    for is_wake, a, b in runs(wake):
        if is_wake:
            extra = 4 if b - a + 1 >= 15 else 3 if b - a + 1 >= 10 else 1 if b - a + 1 >= 4 else 0
            for k in range(b + 1, min(m, b + 1 + extra)):
                rescored[k] = True
    segs = runs(rescored)
    for idx, (is_wake, a, b) in enumerate(segs):
        if is_wake or idx == 0 or idx == len(segs) - 1:
            continue
        before, after, length = segs[idx - 1], segs[idx + 1], b - a + 1
        blen, alen = before[2] - before[1] + 1, after[2] - after[1] + 1
        if (length <= 6 and blen >= 15 and alen >= 15) or (length <= 10 and blen >= 20 and alen >= 20):
            for k in range(a, b + 1):
                rescored[k] = True

    # falling asleep needs 10 quiet minutes; the end of the night is lighter, more broken sleep, so 5 are enough there
    quiet = [(a, b) for is_wake, a, b in runs(rescored) if not is_wake]
    starts, ends = [a for a, b in quiet if b - a + 1 >= 10], [b for a, b in quiet if b - a + 1 >= 5]
    if not starts:
        return {"found": False}
    onset, offset = starts[0], max(ends[-1], starts[0])
    inside = rescored[onset:offset + 1]
    wake_runs = [(a, b) for is_wake, a, b in runs(inside) if is_wake]
    window_h = (offset - onset + 1) / 60
    lo, hi = onset * per_min, (offset + 1) * per_min
    in_window = [e for e in events if lo <= e["nadir_at"] < hi]
    return {
        "found": True, "onset_min": onset, "offset_min": offset + 1, "window_h": round(window_h, 2),
        "quiet_h": round((len(inside) - sum(inside)) / 60, 2),
        "wake_like_min": sum(inside), "wake_like_pct": round(100 * sum(inside) / len(inside), 1),
        "long_wake_periods": sum(1 for a, b in wake_runs if b - a + 1 >= 5),
        "long_wake_runs": [[onset + a, onset + b + 1] for a, b in wake_runs if b - a + 1 >= 5],   # minute ranges, end exclusive
        "longest_wake_min": max((b - a + 1 for a, b in wake_runs), default=0),
        "before_sleep_min": onset, "after_sleep_min": m - offset - 1,
        "odi3_in_window": round(len(in_window) / window_h, 1) if window_h else None,
        "timeline": "".join("w" if w else "s" for w in rescored),   # one character per minute of recording
    }


_SEG = 128  # samples per spectral segment = 512 s; bin k is a cycle of 512/k seconds
_WINDOW = [0.54 - 0.46 * math.cos(2 * math.pi * i / (_SEG - 1)) for i in range(_SEG)]
_COS = [[math.cos(2 * math.pi * k * i / _SEG) for i in range(_SEG)] for k in range(_SEG // 2 + 1)]
_SIN = [[math.sin(2 * math.pi * k * i / _SEG) for i in range(_SEG)] for k in range(_SEG // 2 + 1)]
_BAND = range(7, 18)             # 73 s .. 30 s cycles (0.0137-0.0332 Hz)
_TOTAL = range(2, _SEG // 2 + 1)  # 0.004-0.125 Hz


def _power(x):
    mean, mid = st.mean(x), (_SEG - 1) / 2
    slope = sum((i - mid) * (v - mean) for i, v in enumerate(x)) / sum((i - mid) ** 2 for i in range(_SEG))
    y = [(v - mean - slope * (i - mid)) * w for i, (v, w) in enumerate(zip(x, _WINDOW))]
    return [sum(a * b for a, b in zip(y, _COS[k])) ** 2 + sum(a * b for a, b in zip(y, _SIN[k])) ** 2
            for k in range(_SEG // 2 + 1)]


def _periodicity(spo2, pr):
    """30-70 s cycling in SpO2 (and pulse) per 512-s segment (see DEFINITIONS['periodicity'])."""
    def bridge(values):  # carry the last value across gaps of up to 5 samples; longer gaps spoil the segment
        out, last, gap = [], None, 0
        for v in values:
            gap = 0 if v is not None else gap + 1
            last = v if v is not None else (last if gap <= 5 else None)
            out.append(last)
        return out

    s_fill, p_fill, segments = bridge(spo2), bridge(pr), []
    for start in range(0, len(spo2) - _SEG + 1, _SEG // 2):
        xs, ps = s_fill[start:start + _SEG], p_fill[start:start + _SEG]
        if None in xs:
            continue
        power = _power(xs)
        total, band = sum(power[k] for k in _TOTAL), sum(power[k] for k in _BAND)
        if total <= 0:
            segments.append({"start": start, "ratio": 0.0, "cyclic": False, "pulse_too": False, "period_s": None})
            continue
        peak = max(_BAND, key=lambda k: power[k])
        narrow = sum(power[k] for k in (peak - 1, peak, peak + 1)) / band if band else 0
        cyclic = band / total >= 0.5 and narrow >= 0.5 and max(xs) - min(xs) >= 3
        pulse_too = False
        if cyclic and None not in ps:
            pp = _power(ps)
            ptotal = sum(pp[k] for k in _TOTAL)
            pulse_too = ptotal > 0 and sum(pp[k] for k in _BAND) / ptotal >= 0.3
        segments.append({"start": start, "ratio": band / total, "cyclic": cyclic, "pulse_too": pulse_too,
                         "period_s": round(_SEG * DT / peak)})
    if len(segments) < 4:
        return None
    cyclic = [s for s in segments if s["cyclic"]]
    hours = int(len(spo2) * DT // 3600) + 1
    return {
        "segments": len(segments),
        "band_share_pct": round(100 * st.median(s["ratio"] for s in segments)),
        "cyclic_pct": round(100 * len(cyclic) / len(segments), 1),
        "cyclic_with_pulse_pct": round(100 * sum(1 for s in cyclic if s["pulse_too"]) / len(cyclic)) if cyclic else None,
        "typical_cycle_s": _median([s["period_s"] for s in cyclic]),
        "per_hour": [sum(1 for s in cyclic if s["start"] * DT // 3600 == h) for h in range(hours)],
        "timeline": "".join("c" if s["cyclic"] else "-" for s in segments),   # one character per 256 s step
    }


def analyze(samples, profile=None):
    """samples: iterable of (spo2|None, pr|None, motion|None) at 4-s spacing -> insights dict.
    profile: optional {sex, age, bmi} from resolve_profile(); it only chooses which published reference bands are shown."""
    samples = list(samples)
    profile = {"sex": None, "age": None, "bmi": None, **(profile or {})}
    spo2, pr, motion = _clean(samples)
    n = len(samples)
    valid_spo2 = [v for v in spo2 if v is not None]
    valid_pr = [v for v in pr if v is not None]
    hours = len(valid_spo2) * DT / 3600
    out = {"algo_version": ALGO_VERSION, "definitions": DEFINITIONS, "samples": n, "profile": profile,
           "valid_hours": round(hours, 2), "valid_pct": round(100 * len(valid_spo2) / n, 1) if n else 0,
           "short": hours < MIN_TREND_HOURS}  # per-hour rates from short recordings are not meaningful
    if len(valid_spo2) < 15:
        out["too_short"] = True
        return out
    rate = lambda count: round(count / hours, 1) if hours else None

    # --- oxygen ---
    ordered = sorted(valid_spo2)
    below = lambda thr: sum(1 for v in valid_spo2 if v < thr) * DT
    longest = run = 0
    for v in spo2:
        run = run + 1 if v is not None and v < 90 else 0
        longest = max(longest, run)
    means12 = [st.mean(chunk) for chunk in ([v for v in spo2[k:k + 3] if v is not None] for k in range(0, n - 2, 3)) if chunk]
    out["spo2"] = {
        "mean": round(st.mean(valid_spo2), 1), "median": _median(valid_spo2),
        "baseline": _percentile(ordered, 0.9), "nadir_p1": _percentile(ordered, 0.01), "min": ordered[0],
        "sd": round(st.pstdev(valid_spo2), 2),
        "delta_index": round(st.mean(abs(a - b) for a, b in zip(means12, means12[1:])), 2) if len(means12) > 1 else None,
        "time_below": {str(thr): {"seconds": below(thr), "pct": round(100 * below(thr) / (len(valid_spo2) * DT), 2)}
                       for thr in (95, 92, 90, 88, 85, 80)},
        "longest_below_90_s": longest * DT,
    }

    # --- desaturation events ---
    nonzero = sorted(m for m in motion if m > 0)
    heavy = max(20, _percentile(nonzero, 0.9) or 0)
    events = find_desaturations(spo2)
    for e in events:
        lo, hi = max(0, e["nadir_at"] - 3), min(n, e["nadir_at"] + 9)          # -10 s .. +30 s
        before = [v for v in pr[max(0, lo - 10):lo] if v is not None]
        inside = [v for v in pr[lo:hi] if v is not None]
        e["pr_rise"] = round(max(inside) - st.median(before)) if before and inside else None
        e["motion"] = any(motion[lo:hi])
        e["motion_suspect"] = any(m >= heavy for m in motion[e["start"]:e["nadir_at"] + 1])
        surge = e["pr_rise"] is not None and e["pr_rise"] >= 6
        e["class"] = "A" if surge and e["motion"] else "B" if surge else "C"
        base_window = [v for v in spo2[max(0, e["nadir_at"] - 25):e["nadir_at"] + 1] if v is not None]
        e["baseline"] = max(base_window)
        e["area"] = round(sum(max(0, e["baseline"] - v) for v in spo2[e["start"]:e["end"] + 1] if v is not None) * DT / 60, 2)
    ev4 = [e for e in events if e["depth"] >= 4]
    clean = [e for e in events if not e["motion_suspect"]]
    classes = {c: sum(1 for e in events if e["class"] == c) for c in "ABC"}
    depth_bins, dur_bins = [(3, 4), (5, 9), (10, 14), (15, 100)], [(0, 30), (30, 60), (60, 10 ** 6)]
    out["desaturations"] = {
        "odi3": rate(len(events)), "odi4": rate(len(ev4)), "count3": len(events), "count4": len(ev4),
        "odi3_excl_motion_suspect": rate(len(clean)), "motion_suspect": len(events) - len(clean),
        "hypoxic_burden": round(sum(e["area"] for e in events) / hours, 1) if hours else None,
        "pct_time_in_events": round(100 * sum(e["duration_s"] for e in events) / (len(valid_spo2) * DT), 1),
        "median_duration_s": _median([e["duration_s"] for e in events]),
        "longest_s": max((e["duration_s"] for e in events), default=0),
        "deepest": max((e["depth"] for e in events), default=0),
        "classes": classes,
        "arousal_linked_per_h": rate(classes["A"] + classes["B"]),
        "arousal_linked_pct": round(100 * (classes["A"] + classes["B"]) / len(events)) if events else None,
        "per_hour": [sum(1 for e in events if e["start"] * DT // 3600 == h) for h in range(int(n * DT // 3600) + 1)],
        "depth_by_duration": [[sum(1 for e in events if d0 <= e["depth"] <= d1 and t0 <= e["duration_s"] < t1)
                               for t0, t1 in dur_bins] for d0, d1 in depth_bins],
        "pulse_response": _pulse_response(pr, events),
        "odi_rows": {str(drop): _odi_rows([e for e in events if e["depth"] >= drop], hours) for drop in (3, 4)},
        # same ranges as the app's Oxygen Level Distribution table, plus the total
        "drops4_by_range": [sum(1 for e in ev4 if lo <= e["nadir"] <= hi)
                            for lo, hi in ((95, 100), (91, 94), (86, 90), (70, 85), (0, 69))] + [len(ev4)],
    }
    out["events"] = [[e["start"], e["nadir_at"], e["end"], e["depth"], e["class"], int(e["motion_suspect"])] for e in events]
    out["event_rows"] = events  # full detail, for the desat_events table (stripped before JSON storage)

    # --- pulse ---
    if len(valid_pr) >= 15:
        low30, low5 = _rolling_min_mean(pr, 450), _rolling_min_mean(pr, 75)
        blocks = [(k * 300 / 3600, st.mean(chunk)) for k, chunk in
                  enumerate([v for v in pr[b:b + 75] if v is not None] for b in range(0, n // 2, 75)) if chunk]
        slope = None
        if len(blocks) >= 4:
            mx, my = st.mean(x for x, _ in blocks), st.mean(y for _, y in blocks)
            slope = round(sum((x - mx) * (y - my) for x, y in blocks) / sum((x - mx) ** 2 for x, _ in blocks), 1)
        nadir_frac = round((low30[1] + 225) / n, 2) if low30 else None
        shape = None
        if nadir_frac is not None:
            shape = "late nadir" if nadir_frac > 0.8 else "early nadir" if nadir_frac < 0.2 else \
                "hammock" if 0.35 <= nadir_frac <= 0.65 else "off-centre"
        rises6, rises10 = find_pulse_rises(pr, 6), find_pulse_rises(pr, 10)
        out["pulse"] = {
            "mean": round(st.mean(valid_pr), 1), "median": _median(valid_pr), "sd": round(st.pstdev(valid_pr), 1),
            "lowest_30min": round(low30[0], 1) if low30 else None,
            "lowest_30min_at_h": round((low30[1] + 225) * DT / 3600, 2) if low30 else None,
            "lowest_5min": round(low5[0], 1) if low5 else None,
            "nadir_fraction": nadir_frac, "curve_shape": shape, "first_half_slope_bpm_h": slope,
            "rises6_per_h": rate(len(rises6)), "rises10_per_h": rate(len(rises10)),
            "tachycardia": _episodes(pr, motion, lambda v: v > 90, 8),
            "bradycardia": _episodes(pr, motion, lambda v: v < 40, 8),
        }

    out["movement"] = _movement(motion, n * DT / 3600)
    out["sleep_estimate"] = _sleep_estimate(motion, events, [s is not None or p is not None for s, p in zip(spo2, pr)])
    out["movement"]["in_sleep"] = _sleep_movements(_bouts(motion), out["sleep_estimate"])
    out["movement"]["reference"] = movement_reference(profile, (out["movement"]["in_sleep"] or {}).get("per_h"))
    out["periodicity"] = _periodicity(spo2, pr)
    return out
