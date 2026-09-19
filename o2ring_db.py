#!/usr/bin/env python3
"""Store O2Ring sessions in MySQL.

Connection settings come from the environment or a git-ignored `.env` file
next to this script (see `.env.example`):

    O2RING_DB_HOST, O2RING_DB_PORT, O2RING_DB_NAME, O2RING_DB_USER, O2RING_DB_PASSWORD

Import files that were already downloaded:

    ./o2ring_db.py o2ring_data/
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pymysql

import o2ring_analytics

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS devices (
        sn           VARCHAR(32) PRIMARY KEY,
        model        VARCHAR(16),
        hardware_ver VARCHAR(16),
        software_ver VARCHAR(16),
        branch_code  VARCHAR(16),
        last_battery VARCHAR(8),
        last_info    JSON,
        last_seen    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        device_sn        VARCHAR(32) NOT NULL,
        file_name        VARCHAR(32) NOT NULL,
        start_time       DATETIME NOT NULL,
        end_time         DATETIME NOT NULL,
        recording_s      INT UNSIGNED NOT NULL,
        asleep_s         INT UNSIGNED,
        avg_spo2         TINYINT UNSIGNED,
        min_spo2         TINYINT UNSIGNED,
        drops_3pct       SMALLINT UNSIGNED,
        drops_4pct       SMALLINT UNSIGNED,
        asleep_time_pct  TINYINT UNSIGNED,
        seconds_below_90 INT UNSIGNED,
        drops_below_90   SMALLINT UNSIGNED,
        o2_score         DECIMAL(3,1),
        steps            INT UNSIGNED,
        file_version     TINYINT UNSIGNED,
        operation_mode   TINYINT UNSIGNED,
        sample_count     INT UNSIGNED NOT NULL,
        raw_file         MEDIUMBLOB,
        notes            VARCHAR(200),
        notes_updated_at DATETIME,
        hidden           BOOLEAN NOT NULL DEFAULT 0,   -- kept, but left out of lists and trends
        is_combined      BOOLEAN NOT NULL DEFAULT 0,   -- built by the report server from several recordings
        merged_into      INT NULL,                     -- the combined session this recording is part of
        gap_s            INT UNSIGNED NOT NULL DEFAULT 0,  -- combined sessions: seconds without data between parts
        imported_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_device_file (device_sn, file_name),
        KEY idx_start (start_time)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS samples (
        session_id  INT NOT NULL,
        seq         INT UNSIGNED NOT NULL,
        sample_time DATETIME NOT NULL,
        spo2        TINYINT UNSIGNED,
        pr          SMALLINT UNSIGNED,
        motion      TINYINT UNSIGNED,
        flags       TINYINT UNSIGNED,
        PRIMARY KEY (session_id, seq),
        KEY idx_time (sample_time),
        CONSTRAINT fk_samples_session FOREIGN KEY (session_id)
            REFERENCES sessions (id) ON DELETE CASCADE
    )
    """,
    # one row per night: headline numbers as columns (easy to query / trend), everything else in `detail`
    """
    CREATE TABLE IF NOT EXISTS session_metrics (
        session_id          INT PRIMARY KEY,
        algo_version        INT NOT NULL,
        computed_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        valid_hours         DECIMAL(5,2) NOT NULL,
        valid_pct           DECIMAL(5,1),
        mean_spo2           DECIMAL(4,1),
        baseline_spo2       TINYINT UNSIGNED,
        t90_s               INT UNSIGNED,
        t90_pct             DECIMAL(6,2),
        t88_s               INT UNSIGNED,
        odi3                DECIMAL(5,1),
        odi4                DECIMAL(5,1),
        hypoxic_burden      DECIMAL(6,1),
        arousal_linked_h    DECIMAL(5,1),
        delta_index         DECIMAL(4,2),
        mean_pr             DECIMAL(4,1),
        lowest_pr_30min     DECIMAL(4,1),
        pr_rises6_h         DECIMAL(5,1),
        movement_bouts_h    DECIMAL(5,1),
        fragmentation_index DECIMAL(5,1),
        cyclic_pct          DECIMAL(5,1),
        est_sleep_window_h  DECIMAL(4,2),
        est_wake_like_pct   DECIMAL(5,1),
        detail              JSON NOT NULL,
        CONSTRAINT fk_metrics_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS desat_events (
        session_id     INT NOT NULL,
        seq            INT UNSIGNED NOT NULL,
        start_time     DATETIME NOT NULL,
        nadir_time     DATETIME NOT NULL,
        end_time       DATETIME NOT NULL,
        duration_s     SMALLINT UNSIGNED NOT NULL,
        peak_spo2      TINYINT UNSIGNED NOT NULL,
        nadir_spo2     TINYINT UNSIGNED NOT NULL,
        depth          TINYINT UNSIGNED NOT NULL,
        area_pct_min   DECIMAL(6,2) NOT NULL,
        pr_rise_bpm    SMALLINT,
        has_motion     BOOLEAN NOT NULL,
        motion_suspect BOOLEAN NOT NULL,
        class          CHAR(1) NOT NULL,
        PRIMARY KEY (session_id, seq),
        KEY idx_nadir_time (nadir_time),
        CONSTRAINT fk_events_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS tags (
        id   INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(40) NOT NULL UNIQUE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS session_tags (
        session_id INT NOT NULL,
        tag_id     INT NOT NULL,
        PRIMARY KEY (session_id, tag_id),
        CONSTRAINT fk_st_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
        CONSTRAINT fk_st_tag FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
    )
    """,
]

DEFAULT_TAGS = ["alcohol", "late meal", "caffeine late", "exercise", "stress", "illness / congestion",
                "back sleeping", "side sleeping", "nasal strip", "CPAP / MAD", "different finger"]


def load_env(path: Path = Path(__file__).with_name(".env")):
    """Minimal KEY=VALUE reader; real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, val = line.split("=", 1)
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
                val = val[1:-1]
            os.environ.setdefault(key.strip(), val)


def connect():
    load_env()
    try:
        password = os.environ["O2RING_DB_PASSWORD"]
    except KeyError:
        sys.exit("O2RING_DB_PASSWORD is not set - copy .env.example to .env and fill it in")
    user = os.environ.get("O2RING_DB_USER", "lookee")
    name = os.environ.get("O2RING_DB_NAME", "lookee_data")
    try:
        conn = pymysql.connect(
            host=os.environ.get("O2RING_DB_HOST", "127.0.0.1"),
            port=int(os.environ.get("O2RING_DB_PORT", "3306")),
            user=user,
            password=password,
            database=name,
            charset="utf8mb4",
            autocommit=False,
        )
    except pymysql.err.OperationalError as exc:
        if exc.args[0] == 1044:  # login ok, but no privileges on the schema
            sys.exit(f"{exc.args[1]}\nFix (as MySQL root): "
                     f"GRANT ALL PRIVILEGES ON `{name}`.* TO '{user}'@'%';")
        raise
    with conn.cursor() as cur:
        for ddl in SCHEMA:
            cur.execute(ddl)
        cur.executemany("INSERT IGNORE INTO tags (name) VALUES (%s)", [(t,) for t in DEFAULT_TAGS])
        # columns added after the first release
        cur.execute("""SELECT COLUMN_NAME FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions'""")
        have = {row[0] for row in cur.fetchall()}
        for column, ddl in (("notes", "VARCHAR(200) NULL"), ("notes_updated_at", "DATETIME NULL"),
                            ("hidden", "BOOLEAN NOT NULL DEFAULT 0"), ("is_combined", "BOOLEAN NOT NULL DEFAULT 0"),
                            ("merged_into", "INT NULL"), ("gap_s", "INT UNSIGNED NOT NULL DEFAULT 0")):
            if column not in have:
                cur.execute(f"ALTER TABLE sessions ADD COLUMN {column} {ddl}")
        cur.execute("""SELECT COLUMN_NAME FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session_metrics'""")
        have = {row[0] for row in cur.fetchall()}
        for column, ddl in (("cyclic_pct", "DECIMAL(5,1)"), ("est_sleep_window_h", "DECIMAL(4,2)"),
                            ("est_wake_like_pct", "DECIMAL(5,1)")):
            if column not in have:
                cur.execute(f"ALTER TABLE session_metrics ADD COLUMN {column} {ddl} NULL AFTER fragmentation_index")
    conn.commit()
    return conn


def store_device(conn, info: dict):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO devices (sn, model, hardware_ver, software_ver, branch_code,
                                    last_battery, last_info)
               VALUES (%s, %s, %s, %s, %s, %s, %s) AS new
               ON DUPLICATE KEY UPDATE model = new.model, hardware_ver = new.hardware_ver,
                   software_ver = new.software_ver, branch_code = new.branch_code,
                   last_battery = new.last_battery, last_info = new.last_info""",
            (info.get("SN"), info.get("Model"), info.get("HardwareVer"),
             info.get("SoftwareVer"), info.get("BranchCode"), info.get("CurBAT"),
             json.dumps(info)),
        )
    conn.commit()


def session_exists(conn, sn: str, name: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM sessions WHERE device_sn = %s AND file_name = %s", (sn, name))
        return cur.fetchone() is not None


def store_session(conn, sn: str, name: str, rec: dict, raw: bytes) -> bool:
    """Insert one parsed session + samples atomically. Returns False if already stored."""
    if session_exists(conn, sn, name):
        return False
    samples = rec["samples"]
    end_time = samples[-1]["time"] if samples else rec["start"]
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO sessions (device_sn, file_name, start_time, end_time,
                       recording_s, asleep_s, avg_spo2, min_spo2, drops_3pct, drops_4pct,
                       asleep_time_pct, seconds_below_90, drops_below_90, o2_score, steps,
                       file_version, operation_mode, sample_count, raw_file)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (sn, name, rec["start"], end_time, rec["recording_s"], rec["asleep_s"],
                 rec["avg_spo2"], rec["min_spo2"], rec["drops_3pct"], rec["drops_4pct"],
                 rec["asleep_time_pct"], rec["seconds_below_90"], rec["drops_below_90"],
                 rec["o2_score"], rec["steps"], rec["version"], rec["mode"],
                 len(samples), raw),
            )
            sid = cur.lastrowid
            rows = [(sid, n, s["time"], s["spo2"], s["pr"], s["motion"], s["flags"])
                    for n, s in enumerate(samples)]
            for off in range(0, len(rows), 2000):
                cur.executemany(
                    """INSERT INTO samples (session_id, seq, sample_time, spo2, pr, motion, flags)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    rows[off : off + 2000],
                )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    store_analytics(conn, sid, datetime.fromisoformat(rec["start"]),
                    [(s["spo2"], s["pr"], s["motion"]) for s in samples])
    return True


def store_analytics(conn, session_id: int, start: datetime, samples) -> dict:
    """(Re)compute o2ring_analytics for one session and replace its stored metrics + events."""
    insights = o2ring_analytics.analyze(samples)
    rows = insights.pop("event_rows", [])
    at = lambda idx: start + timedelta(seconds=idx * o2ring_analytics.DT)
    spo2, desat, pulse, move = (insights.get(k, {}) for k in ("spo2", "desaturations", "pulse", "movement"))
    below = spo2.get("time_below", {})
    sleep = insights.get("sleep_estimate") or {}
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM desat_events WHERE session_id = %s", (session_id,))
            cur.execute(
                """REPLACE INTO session_metrics (session_id, algo_version, valid_hours, valid_pct, mean_spo2,
                       baseline_spo2, t90_s, t90_pct, t88_s, odi3, odi4, hypoxic_burden, arousal_linked_h,
                       delta_index, mean_pr, lowest_pr_30min, pr_rises6_h, movement_bouts_h, fragmentation_index,
                       cyclic_pct, est_sleep_window_h, est_wake_like_pct, detail)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (session_id, insights["algo_version"], insights["valid_hours"], insights["valid_pct"],
                 spo2.get("mean"), spo2.get("baseline"), below.get("90", {}).get("seconds"),
                 below.get("90", {}).get("pct"), below.get("88", {}).get("seconds"), desat.get("odi3"),
                 desat.get("odi4"), desat.get("hypoxic_burden"), desat.get("arousal_linked_per_h"),
                 spo2.get("delta_index"), pulse.get("mean"), pulse.get("lowest_30min"), pulse.get("rises6_per_h"),
                 move.get("bouts_per_h"), move.get("fragmentation_index"), (insights.get("periodicity") or {}).get("cyclic_pct"),
                 sleep.get("window_h"), sleep.get("wake_like_pct"), json.dumps(insights)))
            cur.executemany(
                """INSERT INTO desat_events (session_id, seq, start_time, nadir_time, end_time, duration_s, peak_spo2,
                       nadir_spo2, depth, area_pct_min, pr_rise_bpm, has_motion, motion_suspect, class)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                [(session_id, k, at(e["start"]), at(e["nadir_at"]), at(e["end"]), e["duration_s"], e["peak"], e["nadir"],
                  e["depth"], e["area"], e["pr_rise"], e["motion"], e["motion_suspect"], e["class"])
                 for k, e in enumerate(rows)])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return insights


def reanalyze(conn, force=False) -> int:
    """Compute analytics for sessions that have none, or an older ALGO_VERSION (all of them with force)."""
    with conn.cursor() as cur:
        cur.execute("""SELECT s.id, s.file_name, s.start_time FROM sessions s
                       LEFT JOIN session_metrics m ON m.session_id = s.id
                       WHERE %s OR m.session_id IS NULL OR m.algo_version <> %s ORDER BY s.start_time""",
                    (bool(force), o2ring_analytics.ALGO_VERSION))
        todo = cur.fetchall()
    for sid, name, start in todo:
        with conn.cursor() as cur:
            cur.execute("SELECT spo2, pr, motion FROM samples WHERE session_id = %s ORDER BY seq", (sid,))
            samples = cur.fetchall()
        r = store_analytics(conn, sid, start, samples)
        d = r.get("desaturations", {})
        print(f"{name}: analysed  {r['valid_hours']} h valid  ODI3 {d.get('odi3')}  ODI4 {d.get('odi4')}  "
              f"T90 {r.get('spo2', {}).get('time_below', {}).get('90', {}).get('seconds')} s")
    return len(todo)


def main():
    from o2ring_download import name_matches, parse_file

    ap = argparse.ArgumentParser(description="Import downloaded O2Ring .dat files into MySQL")
    ap.add_argument("directory", type=Path, nargs="?", default=Path("o2ring_data"))
    ap.add_argument("--sn", help="device serial (default: from device_info.json)")
    ap.add_argument("--reanalyze", action="store_true",
                    help="only (re)compute analytics for nights already in the database, then exit")
    ap.add_argument("--force", action="store_true", help="with --reanalyze: recompute every night")
    args = ap.parse_args()

    if args.reanalyze:
        conn = connect()
        print(f"{reanalyze(conn, args.force)} session(s) analysed")
        conn.close()
        return

    info_file = args.directory / "device_info.json"
    info = json.loads(info_file.read_text()) if info_file.exists() else {}
    sn = args.sn or info.get("SN")
    if not sn:
        sys.exit(f"No serial number: pass --sn or run the downloader once to create {info_file}")

    conn = connect()
    if info:
        store_device(conn, info)
    for dat in sorted(args.directory.glob("*.dat")):
        raw = dat.read_bytes()
        if not name_matches(dat.stem, raw):
            print(f"{dat.stem}: skipped - the file holds a different recording than its name says")
            continue
        new = store_session(conn, sn, dat.stem, parse_file(raw), raw)
        print(f"{dat.stem}: {'imported' if new else 'already in database'}")
    reanalyze(conn)  # nights stored before analytics existed, or with an older algorithm version
    conn.close()


if __name__ == "__main__":
    main()
