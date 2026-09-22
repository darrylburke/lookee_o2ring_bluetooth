#!/usr/bin/env python3
"""Generate HTML "Report Details" pages like the Lookee app's, one per session.

    ./o2ring_report.py                       # every session in MySQL -> ./reports/
    ./o2ring_report.py --session 20260917231109
    ./o2ring_report.py --from-files o2ring_data   # no database, read .dat files
    ./o2ring_report.py --demo                     # a synthetic night - try it without a ring

The numbers follow the app's own maths (DashboardActivityKt.InfoScreen):
invalid samples are dropped, each remaining sample is worth
`recording time / valid sample count` seconds, and a bucket's duration is
`int(count * seconds_per_sample)`.
"""
import argparse
import html
import json
import re
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import o2ring_analytics

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / "report_template.html"

SPO2_BUCKETS = [("95-100", 95, 100), ("91-94", 91, 94), ("86-90", 86, 90),
                ("70-85", 70, 85), ("<70", 0, 69)]
PR_BUCKETS = [(">120/Min", 121, 10_000), ("50–120/Min", 50, 120), ("<50/Min", 0, 49)]


def hms(seconds: int) -> str:
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def distribution(values, buckets, duration_s):
    n = len(values)
    sec_per = duration_s / n if n else 0.0
    rows = []
    for label, lo, hi in buckets:
        count = sum(lo <= v <= hi for v in values)
        rows.append({"range": label, "duration": hms(int(count * sec_per)),
                     "pct": f"{count * 100 / n if n else 0:.2f}%"})
    return rows


def build_report(session: dict, samples: list, device_name: str, info: dict = None) -> dict:
    """session: sessions-table style dict; samples: [(spo2|None, pr|None, motion)]"""
    start = session["start_time"]
    duration = session["recording_s"]                 # whole span, including gaps inside a combined night
    measured = duration - (session.get("gap_s") or 0)  # time actually recorded
    end = start + timedelta(seconds=duration)
    spo2 = [s for s, _, _ in samples if s is not None and 0 < s <= 100]
    pr = [p for _, p, _ in samples if p is not None and 0 < p < 300]

    spo2_rows = distribution(spo2, SPO2_BUCKETS, measured)
    spo2_rows.append({"range": "Total", "duration": hms(measured), "pct": "100.00%" if spo2 else "0.00%"})

    asleep = session.get("asleep_s") or 0
    insights = o2ring_analytics.analyze(samples, o2ring_analytics.resolve_profile(os.environ, start.date()))
    insights.pop("event_rows", None)
    # the app draws a triangle under samples beyond the ring's own reminder thresholds
    info = info or {}
    num = lambda key, default: int(info[key]) if str(info.get(key, "")).isdigit() else default
    spo2_alert = num("CurOxiThr", 86) if num("OxiSwitch", 1) else None
    pr_alert = [num("HRLowThr", 50), num("HRHighThr", 120)] if num("HRSwitch", 0) else None
    return {
        "file_name": session["file_name"],
        "device": device_name,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "duration_s": duration,
        "measured_s": measured,
        "measurement_time": hms(measured),
        "avg_spo2": int(sum(spo2) / len(spo2) + 0.5) if spo2 else None,   # app: roundToInt
        "spo2_alert": spo2_alert,
        "pr_alert": pr_alert,
        "avg_pr": int(sum(pr) / len(pr)) if pr else None,                # app: truncates
        "o2_score": None if session.get("o2_score") is None else float(session["o2_score"]),
        "asleep_s": asleep,
        "drops_3pct": session.get("drops_3pct"),
        "drops_4pct": session.get("drops_4pct"),
        "seconds_below_90": session.get("seconds_below_90"),
        "spo2_range": [min(spo2), max(spo2)] if spo2 else None,
        "pr_range": [min(pr), max(pr)] if pr else None,
        "spo2_dist": spo2_rows,
        "pr_dist": distribution(pr, PR_BUCKETS, measured),
        "interval_s": 4,
        "spo2": [s if s is not None and 0 < s <= 100 else None for s, _, _ in samples],
        "pr": [p if p is not None and 0 < p < 300 else None for _, p, _ in samples],
        "motion": [m or 0 for _, _, m in samples],
        "insights": insights,
    }


def sessions_from_db(only=None):
    import o2ring_db
    import pymysql

    conn = o2ring_db.connect()
    with conn.cursor(pymysql.cursors.DictCursor) as cur:
        # recordings that were hidden, or folded into a combined night by the report server, are left out
        sql = """SELECT id, device_sn, file_name, start_time, recording_s, gap_s, asleep_s, avg_spo2,
                        drops_3pct, drops_4pct, seconds_below_90, o2_score
                 FROM sessions WHERE hidden = 0 AND merged_into IS NULL"""
        cur.execute(sql + (" AND file_name = %s" if only else "") + " ORDER BY start_time",
                    (only,) if only else ())
        sessions = cur.fetchall()
        cur.execute("SELECT sn, last_info FROM devices")
        infos = {d["sn"]: json.loads(d["last_info"] or "{}") for d in cur.fetchall()}
    for sess in sessions:
        with conn.cursor() as cur:
            cur.execute("SELECT spo2, pr, motion FROM samples WHERE session_id = %s ORDER BY seq",
                        (sess["id"],))
            yield sess, cur.fetchall(), f"O2Ring {sess['device_sn'][-4:]}", infos.get(sess["device_sn"])
    conn.close()


def sessions_from_files(directory: Path, only=None):
    from o2ring_download import parse_file

    info_file = directory / "device_info.json"
    info = json.loads(info_file.read_text()) if info_file.exists() else {}
    sn = info.get("SN", "")
    for dat in sorted(directory.glob("*.dat")):
        if only and dat.stem != only:
            continue
        rec = parse_file(dat.read_bytes())
        sess = {"file_name": dat.stem, "start_time": datetime.fromisoformat(rec["start"]),
                "recording_s": rec["recording_s"], "asleep_s": rec["asleep_s"],
                "avg_spo2": rec["avg_spo2"], "drops_3pct": rec["drops_3pct"],
                "drops_4pct": rec["drops_4pct"], "seconds_below_90": rec["seconds_below_90"],
                "o2_score": rec["o2_score"]}
        samples = [(s["spo2"], s["pr"], s["motion"]) for s in rec["samples"]]
        yield sess, samples, f"O2Ring {sn[-4:]}".strip(), info


def demo_session(seed=7, hours=7.5):
    """A made-up night (nobody's data): clusters of cyclic oxygen drops, pulse surges after them, some movement."""
    import math
    import random
    rng = random.Random(seed)
    n = int(hours * 900)
    spo2, pr, motion = [96.6] * n, [0.0] * n, [0] * n
    for i in range(n):  # slow pulse "hammock" with a little wander
        pr[i] = 58 + 7 * (2 * i / n - 0.9) ** 2 + 1.5 * math.sin(i / 170) + rng.gauss(0, 0.8)
    t = 300
    while t < n - 400:
        t += int(rng.expovariate(1 / 500))                      # next cluster
        for _ in range(rng.randint(2, 14)):                     # back-to-back events, ~40-55 s apart
            depth, fall, rise = rng.choice([3, 3, 4, 4, 5, 6, 8]), rng.randint(4, 8), rng.randint(2, 4)
            if t + fall + rise + 12 >= n:
                break
            for k in range(fall):
                spo2[t + k] -= depth * (k + 1) / fall
            for k in range(rise):
                spo2[t + fall + k] -= depth * (1 - (k + 1) / rise)
            if rng.random() < 0.6:                              # arousal: pulse surge, sometimes movement
                for k in range(5):
                    pr[t + fall - 1 + k] += rng.uniform(7, 14) * (1 - k / 5)
                if rng.random() < 0.5:
                    for k in range(rng.randint(1, 3)):
                        motion[t + fall + k] = rng.randint(15, 120)
            t += fall + rise + rng.randint(2, 5)
    for _ in range(25):                                          # unrelated turning over
        at = rng.randrange(0, n - 12)
        for k in range(rng.randint(1, 10)):
            motion[at + k] = rng.randint(5, 150)
    samples = [(max(70, min(100, round(s + rng.gauss(0, 0.45)))), round(p), m) for s, p, m in zip(spo2, pr, motion)]
    valid = [s for s, _, _ in samples]
    sess = {"file_name": "demo", "start_time": datetime(2026, 1, 15, 23, 5, 0), "recording_s": n * 4, "asleep_s": 0,
            "avg_spo2": round(sum(valid) / n), "drops_3pct": None, "drops_4pct": None,
            "seconds_below_90": sum(1 for v in valid if v < 90) * 4, "o2_score": None}
    return sess, samples, "O2Ring demo", {"OxiSwitch": "1", "CurOxiThr": "88"}


def footer_html() -> str:
    """footer.html with the logo inlined, so every generated page stays a single self-contained file."""
    import base64
    logo = base64.b64encode((HERE / "assets" / "northtrail-logo.png").read_bytes()).decode()
    return (HERE / "footer.html").read_text().replace("{{LOGO}}", f"data:image/png;base64,{logo}")


def fmt_when(dt: datetime) -> str:
    return dt.strftime("%b %d %Y, %I:%M %p")


def write_index(out: Path, reports: list):
    items = "\n".join(
        f'<a class="row" href="{html.escape(r["file_name"])}.html">'
        f'<span class="when">{html.escape(fmt_when(datetime.fromisoformat(r["start"])))}</span>'
        f'<span class="meta">{r["measurement_time"]} · Avg {r["avg_spo2"]}% · '
        f'{r["avg_pr"]}/min · O2 Score {r["o2_score"] if r["o2_score"] is not None else "–"}</span></a>'
        for r in reversed(reports))
    (out / "index.html").write_text(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>O2Ring Reports</title>
<link href="https://fonts.googleapis.com/css2?family=Lato:wght@700;900&family=Poppins:wght@400;500;600&display=swap" rel="stylesheet">
<style>
body{{margin:0;background:#1c2431;color:#fff;font-family:Poppins,system-ui,sans-serif}}
header{{background:#343c4a;padding:18px 16px;text-align:center;font:900 26px Lato,system-ui,sans-serif}}
main{{max-width:540px;margin:0 auto;padding:20px 16px}}
.row{{display:block;background:#343c4a;border-radius:10px;padding:14px 16px;margin-bottom:12px;color:inherit;text-decoration:none}}
.row:hover{{outline:1px solid #fe5000}}
.when{{display:block;font:700 17px Lato,system-ui,sans-serif}}
.meta{{display:block;color:#d5d8e0;font-size:13px;margin-top:4px}}
</style></head><body><header>Reports</header><main>
{items}
</main>
{footer_html()}
</body></html>
""")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=HERE / "reports")
    ap.add_argument("--session", help="only this file name, e.g. 20260917231109")
    ap.add_argument("--from-files", type=Path, metavar="DIR",
                    help="read .dat files from DIR instead of MySQL")
    ap.add_argument("--demo", action="store_true", help="write reports/demo.html from a synthetic night")
    args = ap.parse_args()
    try:
        from o2ring_db import load_env
        load_env()                       # the optional profile (O2RING_SEX, O2RING_BIRTH_YEAR, ...) picks the reference bands
    except ImportError:                  # pymysql missing: static reports still work, just without a profile from .env
        pass

    source = ([demo_session()] if args.demo else sessions_from_files(args.from_files, args.session) if args.from_files
              else sessions_from_db(args.session))
    # static pages get the Ask panel too: greyed out, with a note that it needs the report server
    template = (TEMPLATE.read_text().replace("<!--FOOTER-->", footer_html())
                .replace("<!--ASK-->", (HERE / "ask_panel.html").read_text()))
    args.out.mkdir(parents=True, exist_ok=True)
    reports = []
    for sess, samples, device, info in source:
        report = build_report(sess, samples, device, info)
        if not re.fullmatch(r"[0-9A-Za-z_+-]{1,40}", report["file_name"]):   # becomes a file name
            print(f"skipped: unexpected session name {report['file_name']!r}")
            continue
        # "<" never appears literally inside the <script>, so no value can close it or open a comment
        page = template.replace("/*REPORT_DATA*/null", json.dumps(report, separators=(",", ":")).replace("<", "\\u003c"))
        (args.out / f"{report['file_name']}.html").write_text(page)
        reports.append(report)
        print(f"{report['file_name']}.html  {fmt_when(sess['start_time'])}  {report['measurement_time']}")
    if not reports:
        sys.exit("No sessions found.")
    if not args.session and not args.demo:
        write_index(args.out, reports)
    print(f"Open {args.out / (reports[0]['file_name'] + '.html' if args.demo or args.session else 'index.html')}")


if __name__ == "__main__":
    main()
