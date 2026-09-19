import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import math
from o2ring_analytics import analyze, find_desaturations, find_pulse_rises


def night(spo2, pr=None, motion=None):
    pr = pr or [60] * len(spo2)
    motion = motion or [0] * len(spo2)
    return list(zip(spo2, pr, motion))


class Desaturations(unittest.TestCase):
    def test_flat_trace_has_no_events(self):
        self.assertEqual(find_desaturations([96] * 500), [])

    def test_single_clear_drop(self):
        trace = [97] * 50 + [96, 95, 94, 93, 93, 94, 96, 97] + [97] * 50
        (e,) = find_desaturations(trace)
        self.assertEqual((e["peak"], e["nadir"], e["depth"]), (97, 93, 4))
        self.assertEqual(e["start"], 49)            # last sample of the plateau, not its first
        self.assertEqual(trace[e["end"]], 96)       # recovered to peak-1

    def test_two_percent_wobble_is_ignored(self):
        self.assertEqual(find_desaturations(([97, 96, 95, 96] * 100)), [])

    def test_instant_step_is_too_fast(self):       # 1 sample = 4 s < 8 s minimum fall
        self.assertEqual(find_desaturations([97] * 20 + [93] * 5 + [97] * 20), [])

    def test_up_tick_does_not_split_event(self):
        trace = [97] * 20 + [96, 95, 96, 94, 93, 97] + [97] * 20
        (e,) = find_desaturations(trace)
        self.assertEqual(e["depth"], 4)

    def test_gap_breaks_event(self):
        self.assertEqual(find_desaturations([97] * 20 + [96, None, 94, 93] + [97] * 20), [])


class Analyze(unittest.TestCase):
    def setUp(self):
        drop = [96, 95, 94, 93, 92, 93, 95, 97]
        spo2, pr, motion = [], [], []
        for k in range(30):                          # 30 events, every ~5 min
            spo2 += [97] * 67 + drop
            surge = k % 2 == 0                       # every other event has a pulse surge, every 4th also moves
            pr += [60] * 70 + ([70, 72, 66] if surge else [60, 60, 60]) + [60, 60]
            motion += [0] * 71 + ([40] if k % 4 == 0 else [0]) + [0] * 3
        self.result = analyze(night(spo2, pr, motion))

    def test_counts_and_rates(self):
        d = self.result["desaturations"]
        self.assertEqual((d["count3"], d["count4"]), (30, 30))
        self.assertAlmostEqual(d["odi3"], 30 / self.result["valid_hours"], delta=0.2)
        self.assertEqual(d["classes"], {"A": 8, "B": 7, "C": 15})
        self.assertEqual(d["arousal_linked_pct"], 50)
        self.assertGreater(d["hypoxic_burden"], 0)
        self.assertEqual(sum(d["per_hour"]), 30)
        self.assertEqual(d["depth_by_duration"][1][0] + d["depth_by_duration"][1][1], 30)   # 5 % deep

    def test_app_style_odi_rows(self):
        d = self.result["desaturations"]
        rows = d["odi_rows"]["4"]
        self.assertEqual(rows["drops"], 30)
        self.assertEqual(rows["time_in_drops_s"], 30 * rows["avg_duration_s"])
        self.assertAlmostEqual(rows["pct_time_in_drops"], 100 * rows["time_in_drops_s"] / (self.result["valid_hours"] * 3600), delta=0.2)
        self.assertEqual(d["drops4_by_range"], [0, 30, 0, 0, 0, 30])        # every nadir is 92 %

    def test_time_below_and_baseline(self):
        s = self.result["spo2"]
        self.assertEqual(s["baseline"], 97)
        self.assertEqual(s["time_below"]["95"]["seconds"], 30 * 4 * 4)   # 94,93,92,93 per event
        self.assertEqual(s["time_below"]["90"]["seconds"], 0)

    def test_pulse(self):
        p = self.result["pulse"]
        self.assertAlmostEqual(p["lowest_30min"], 60.0, delta=0.3)   # surges lift the mean slightly
        self.assertAlmostEqual(p["rises6_per_h"], 15 / self.result["valid_hours"], delta=0.3)
        self.assertEqual(p["tachycardia"], [])

    def test_movement(self):
        m = self.result["movement"]
        self.assertEqual(m["bouts"], 8)
        self.assertEqual(m["major_movements"], 0)

    def test_invalid_samples_are_not_counted(self):
        r = analyze(night([255, None, 0] + [96] * 100))
        self.assertEqual(r["spo2"]["min"], 96)
        self.assertEqual(r["valid_pct"], round(100 * 100 / 103, 1))

    def test_artefact_jump_is_dropped(self):
        r = analyze(night([97] * 50 + [80] + [97] * 50))
        self.assertEqual(r["spo2"]["min"], 97)
        self.assertEqual(r["desaturations"]["count3"], 0)

    def test_too_short(self):
        self.assertTrue(analyze(night([97] * 5)).get("too_short"))


class PulseRises(unittest.TestCase):
    def test_single_sample_spike_is_ignored(self):
        self.assertEqual(find_pulse_rises([60] * 30 + [75] + [60] * 30, 6), [])

    def test_sustained_rise_counts_once(self):
        self.assertEqual(len(find_pulse_rises([60] * 30 + [70, 71, 69, 68] + [60] * 30, 6)), 1)


class SleepEstimate(unittest.TestCase):
    def night(self, minutes):                        # one motion value per minute, expanded to 15 samples
        motion = [v for m in minutes for v in [m] + [0] * 14]
        return analyze(night([96] * len(motion), motion=motion))["sleep_estimate"]

    def test_window_trims_restless_start_and_end(self):
        est = self.night([80] * 12 + [0] * 120 + [90] * 8 + [0] * 100 + [70] * 20)
        self.assertTrue(est["found"])
        self.assertEqual(est["onset_min"], 15)                    # 12 restless min + 3 more that Webster keeps as wake
        self.assertAlmostEqual(est["offset_min"], 240, delta=1)
        self.assertEqual(est["long_wake_periods"], 1)
        self.assertAlmostEqual(est["wake_like_min"], 9, delta=2)
        self.assertEqual(len(est["timeline"]), 260)

    def test_isolated_twitches_do_not_count_as_wake(self):
        est = self.night(([0] * 9 + [5]) * 30)
        self.assertEqual(est["wake_like_min"], 0)

    def test_all_restless_finds_no_window(self):
        self.assertEqual(self.night([90] * 60), {"found": False})

    def test_gap_without_readings_counts_as_wake(self):
        samples = night([96] * 900) + [(None, None, None)] * 150 + night([96] * 900)     # 60 + 10 + 60 minutes
        est = analyze(samples)["sleep_estimate"]
        self.assertEqual(est["timeline"][60:70], "w" * 10)
        self.assertGreaterEqual(est["wake_like_min"], 10)

    def test_too_short_to_estimate(self):
        self.assertIsNone(self.night([0] * 20))


class Periodicity(unittest.TestCase):
    def test_cyclic_desaturations_are_detected(self):
        spo2 = [round(95 + 2.5 * math.sin(2 * math.pi * i * 4 / 40)) for i in range(1800)]      # 40-second cycles, 2 h
        pr = [round(62 + 4 * math.sin(2 * math.pi * i * 4 / 40 + 1)) for i in range(1800)]
        p = analyze(night(spo2, pr))["periodicity"]
        self.assertGreater(p["cyclic_pct"], 90)
        self.assertAlmostEqual(p["typical_cycle_s"], 40, delta=4)
        self.assertGreater(p["cyclic_with_pulse_pct"], 90)

    def test_flat_and_random_traces_are_not_cyclic(self):
        import random
        rng = random.Random(1)
        self.assertEqual(analyze(night([96] * 1800))["periodicity"]["cyclic_pct"], 0)
        noisy = [96 + rng.choice([-1, 0, 0, 0, 1]) for _ in range(1800)]
        self.assertEqual(analyze(night(noisy))["periodicity"]["cyclic_pct"], 0)

    def test_isolated_long_dips_are_not_cyclic(self):
        spo2 = ([97] * 140 + [96, 95, 94, 93, 92, 92, 93, 95, 96, 97]) * 12                     # one dip every 10 min
        self.assertLess(analyze(night(spo2))["periodicity"]["cyclic_pct"], 10)


if __name__ == "__main__":
    unittest.main()
