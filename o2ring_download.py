#!/usr/bin/env python3
"""Download recorded sessions from a Lookee / Viatom O2Ring over BLE.

Protocol reverse-engineered from com.lookee.android (Lepu "blepro" SDK,
OxyBleInterface / OxyBleCmd / OxyBleManager).

    pip install bleak
    ./o2ring_download.py                 # scan, connect, download every file
    ./o2ring_download.py --address AA:BB:CC:DD:EE:FF --out ./data
    ./o2ring_download.py --list          # only show device info + file list
    ./o2ring_download.py --db            # also store sessions in MySQL (see o2ring_db.py)
"""
import argparse
import asyncio
import csv
import json
import re
import struct
import sys
from datetime import datetime, timedelta
from pathlib import Path

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "14839ac4-7d7e-415c-9a42-167340cf2339"
WRITE_UUID = "8b00ace7-eb0b-49b0-bbe9-9aee0a26e1a3"
NOTIFY_UUID = "0734594a-a8e7-4b1a-a6b1-cd5243059a57"

NAME_HINTS = ("O2Ring", "OxyRing", "O2M", "Oxylink", "OxyU", "Oxyfit")

CMD_READ_START = 0x03
CMD_READ_CONTENT = 0x04
CMD_READ_END = 0x05
CMD_INFO = 0x14
CMD_PING = 0x15
CMD_PARA_SYNC = 0x16
CMD_RT_PARAM = 0x17

CMD_TIMEOUT = 6.0  # same as the SDK's cmdTimer
RECORD_INTERVAL_S = 4  # one 5-byte sample every 4 seconds


def crc8(data: bytes) -> int:
    """CRC-8, poly 0x07, init 0 (matches the SDK lookup table)."""
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def build_cmd(cmd: int, payload: bytes = b"", block: int = 0) -> bytes:
    """AA | cmd | ~cmd | block(u16le) | len(u16le) | payload | crc8"""
    head = struct.pack("<BBBHH", 0xAA, cmd, ~cmd & 0xFF, block, len(payload))
    body = head + payload
    return body + bytes([crc8(body)])


class Response:
    def __init__(self, frame: bytes):
        self.ok = frame[1] == 0x00
        self.block = struct.unpack_from("<H", frame, 3)[0]
        self.payload = frame[7:-1]


class O2Ring:
    def __init__(self, client: BleakClient):
        self.client = client
        self._buf = bytearray()
        self._frames: asyncio.Queue = asyncio.Queue()
        self._write_with_response = False

    async def start(self):
        char = self.client.services.get_characteristic(WRITE_UUID)
        # SDK prefers WRITE_NO_RESPONSE when the characteristic offers it
        self._write_with_response = "write-without-response" not in char.properties
        await self.client.start_notify(NOTIFY_UUID, self._on_notify)

    def _on_notify(self, _char, data: bytearray):
        self._buf += data
        self._parse()

    def _parse(self):
        """55 | status | ~status | block(u16) | len(u16) | payload | crc8"""
        buf = self._buf
        while True:
            i = 0
            while i + 8 <= len(buf) and not (
                buf[i] == 0x55 and buf[i + 1] == (~buf[i + 2] & 0xFF)
            ):
                i += 1
            del buf[:i]  # drop garbage before the sync byte
            if len(buf) < 8:
                return
            total = 8 + struct.unpack_from("<H", buf, 5)[0]
            if len(buf) < total:
                return  # wait for more notifications
            frame = bytes(buf[:total])
            if crc8(frame[:-1]) == frame[-1]:
                self._frames.put_nowait(Response(frame))
                del buf[:total]
            else:
                del buf[:1]  # false sync, keep searching

    async def request(self, cmd: int, payload: bytes = b"", block: int = 0) -> Response:
        while not self._frames.empty():
            self._frames.get_nowait()
        pkt = build_cmd(cmd, payload, block)
        for off in range(0, len(pkt), 20):  # safe for the default 23-byte MTU
            await self.client.write_gatt_char(
                WRITE_UUID, pkt[off : off + 20], response=self._write_with_response
            )
        return await asyncio.wait_for(self._frames.get(), CMD_TIMEOUT)

    async def sync_time(self):
        now = datetime.now().strftime("%Y-%m-%d,%H:%M:%S")
        body = json.dumps({"SetTIME": now}, separators=(",", ":")).encode()
        return (await self.request(CMD_PARA_SYNC, body)).ok

    async def get_info(self) -> dict:
        rsp = await self.request(CMD_INFO)
        text = rsp.payload.decode("utf-8", "ignore")
        return json.loads(text[text.index("{") : text.rindex("}") + 1])

    async def read_file(self, name: str, progress=None) -> bytes:
        rsp = await self.request(CMD_READ_START, name.encode() + b"\x00")
        if not rsp.ok:
            raise IOError(f"READ_START failed for {name}: {rsp.payload.hex()}")
        size = struct.unpack_from("<I", rsp.payload)[0]
        data = bytearray()
        try:
            if not 0 < size <= 2_000_000:
                raise IOError(f"implausible size {size} for {name}")
            block = 0
            while len(data) < size:
                rsp = await self.request(CMD_READ_CONTENT, block=block)
                if not rsp.ok or not rsp.payload:
                    raise IOError(f"READ_CONTENT failed at block {block}")
                data += rsp.payload
                block += 1
                if progress:
                    progress(len(data), size)
        finally:
            await self.request(CMD_READ_END)
        return bytes(data[:size])


def safe_name(name: str) -> bool:
    """File names come from the ring and end up in paths - accept only plain identifiers."""
    return re.fullmatch(r"[0-9A-Za-z_+-]{1,32}", name) is not None


def name_matches(name: str, raw: bytes) -> bool:
    """Files are named after their start time (YYYYMMDDHHMMSS). The ring answers READ_START for a file it
    cannot open with "OK" and then serves whichever file was opened last, so check what actually came back."""
    if len(raw) < 40 or not (len(name) == 14 and name.isdigit()):
        return len(raw) >= 40
    year, mon, day, hh, mm, ss = struct.unpack_from("<HBBBBB", raw, 2)
    return name == f"{year:04d}{mon:02d}{day:02d}{hh:02d}{mm:02d}{ss:02d}"


def parse_file(raw: bytes) -> dict:
    """40-byte header followed by 5-byte samples (one per 4 s)."""
    (ver, mode, year, mon, day, hh, mm, ss, size, rec_time, asleep_time,
     avg_spo2, min_spo2, drops3, drops4, asleep_pct, dur_lt90, drops_lt90,
     o2_score, steps) = struct.unpack_from("<BBHBBBBBIHHBBBBBHBBI", raw, 0)
    start = datetime(year, mon, day, hh, mm, ss)
    samples = []
    for n in range((min(size, len(raw)) - 40) // 5):
        spo2, pr, motion, flags = struct.unpack_from("<BHBB", raw, 40 + n * 5)
        samples.append({
            "time": (start + timedelta(seconds=n * RECORD_INTERVAL_S)).isoformat(sep=" "),
            "spo2": None if spo2 == 0xFF else spo2,       # 0xFF = invalid / off-finger
            "pr": None if pr == 0xFFFF else pr,
            "motion": motion,
            "flags": flags,
        })
    return {
        "version": ver, "mode": mode, "start": start.isoformat(sep=" "),
        "recording_s": rec_time, "asleep_s": asleep_time,
        "avg_spo2": avg_spo2, "min_spo2": min_spo2,
        "drops_3pct": drops3, "drops_4pct": drops4,
        "asleep_time_pct": asleep_pct,
        "seconds_below_90": dur_lt90, "drops_below_90": drops_lt90,
        "o2_score": None if o2_score == 0xFF else o2_score / 10,  # 0xFF = no score (seen on a 108 s session)
        "steps": steps, "samples": samples,
    }


async def find_device(timeout: float):
    print(f"Scanning {timeout:.0f}s for an O2Ring (wear it so it powers on)...")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    for dev, adv in found.values():
        name = adv.local_name or dev.name or ""
        if SERVICE_UUID in [u.lower() for u in adv.service_uuids] or any(
            h in name for h in NAME_HINTS
        ):
            print(f"Found {name!r} at {dev.address} (RSSI {adv.rssi})")
            return dev
    return None


async def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--address", help="BLE MAC address (skips scanning)")
    ap.add_argument("--out", default="o2ring_data", type=Path)
    ap.add_argument("--scan-timeout", default=15.0, type=float)
    ap.add_argument("--list", action="store_true", help="show info/file list only")
    ap.add_argument("--no-sync-time", action="store_true",
                    help="don't set the ring's clock (the app always does)")
    ap.add_argument("--force", action="store_true", help="re-download existing files")
    ap.add_argument("--db", action="store_true",
                    help="also store sessions in MySQL (settings from .env)")
    args = ap.parse_args()

    db = None
    if args.db:  # connect first so a bad login fails before we touch the ring
        import o2ring_db
        db = o2ring_db.connect()

    target = args.address or await find_device(args.scan_timeout)
    if not target:
        sys.exit("No O2Ring found. Is it on your finger and not connected to the phone?")

    async with BleakClient(target, timeout=20.0) as client:
        ring = O2Ring(client)
        await ring.start()
        if not args.no_sync_time:
            print("Clock sync:", "ok" if await ring.sync_time() else "failed")

        info = await ring.get_info()
        files = [f for f in info.get("FileList", "").split(",") if f]
        print(f"Model {info.get('Model')}  SN {info.get('SN')}  "
              f"FW {info.get('SoftwareVer')}  battery {info.get('CurBAT')}")
        print(f"{len(files)} file(s) on device: {', '.join(files) or '-'}")
        if args.list:
            print(json.dumps(info, indent=2))
            return

        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "device_info.json").write_text(json.dumps(info, indent=2))
        if db:
            o2ring_db.store_device(db, info)
        for name in files:
            if not safe_name(name):
                print(f"skipped: unexpected file name from the ring: {name!r}")
                continue
            dat = args.out / f"{name}.dat"
            if dat.exists() and not args.force:
                print(f"{name}: already downloaded, skipping")
                raw = dat.read_bytes()
                if not name_matches(name, raw):
                    print(f"  ignored: {dat.name} does not contain the recording it is named after - delete it")
                    continue
            else:
                def show(done, total, name=name):
                    print(f"\r{name}: {done}/{total} bytes ({done * 100 // total}%)",
                          end="", flush=True)
                raw = await ring.read_file(name, show)
                print()
                if not name_matches(name, raw):
                    print(f"  skipped: the ring listed {name} but returned a different recording "
                          f"(file no longer readable on the ring)")
                    continue
                dat.write_bytes(raw)
            rec = parse_file(raw)
            with open(args.out / f"{name}.csv", "w", newline="") as fh:
                w = csv.DictWriter(fh, ["time", "spo2", "pr", "motion", "flags"])
                w.writeheader()
                w.writerows(rec["samples"])
            summary = {k: v for k, v in rec.items() if k != "samples"}
            (args.out / f"{name}.json").write_text(json.dumps(summary, indent=2))
            if db:
                new = o2ring_db.store_session(db, info.get("SN"), name, rec, raw)
                print(f"  database: {'stored' if new else 'already present'}")
            print(f"  start {rec['start']}  {rec['recording_s']}s  "
                  f"avg SpO2 {rec['avg_spo2']}  min {rec['min_spo2']}  "
                  f"{len(rec['samples'])} samples")


if __name__ == "__main__":
    asyncio.run(main())
