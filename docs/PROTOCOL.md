# O2Ring BLE protocol and file format

Worked out by reading the decompiled `com.lookee.android` app, which embeds the
Lepu `blepro` SDK (`OxyBleInterface`, `OxyBleCmd`, `OxyBleManager`), and verified
against a real ring (model 1652, firmware 1.13.0). The same protocol is used by
the Viatom / Wellue O2Ring family. `o2ring_download.py` is a ~250-line reference
implementation.

## 1. Connecting

| Role | UUID |
|---|---|
| Service | `14839ac4-7d7e-415c-9a42-167340cf2339` |
| Write (host → ring) | `8b00ace7-eb0b-49b0-bbe9-9aee0a26e1a3` |
| Notify (ring → host) | `0734594a-a8e7-4b1a-a6b1-cd5243059a57` |

1. Scan for a device whose name contains `O2Ring` (e.g. `O2Ring 1234` – the
   last 4 digits of the serial number).
2. Connect. No pairing/bonding, no PIN. The app asks for MTU 247 and high
   connection priority; neither is required.
3. Enable notifications on the notify characteristic.
4. The app immediately sends a clock sync (`SetTIME`), then `getInfo`.

The SDK has an optional AES "encrypt connect" handshake (command `0xFF`). The
Lookee app never enables it, so everything is plaintext.

## 2. Packet format

Request:

```
AA | cmd | ~cmd | block (u16 LE) | len (u16 LE) | payload[len] | crc8
```

Response (may be split across several notifications – reassemble by length):

```
55 | status | ~status | block (u16 LE) | len (u16 LE) | payload[len] | crc8
```

`status == 0x00` means success. CRC is CRC‑8, polynomial `0x07`, init `0`,
over every byte before it. One command at a time; the app uses a 6 s timeout.

| cmd | Name | Payload | Response payload |
|---|---|---|---|
| `0x03` | READ_START | file name + `\0` | file size (u32 LE) |
| `0x04` | READ_CONTENT | – (`block` = 0,1,2…) | next chunk of the file |
| `0x05` | READ_END | – | – |
| `0x14` | INFO | – | JSON (see below) |
| `0x15` | PING | any | echo |
| `0x16` | PARA_SYNC | JSON, e.g. `{"SetTIME":"2026-09-18,12:17:15"}` | – |
| `0x17` | RT_PARAM | – | live SpO2 / PR / battery / motion |
| `0x18` | FACTORY_RESET | – | **wipes the ring – not used here** |
| `0x1B` | RT_WAVE | `00` | live pleth waveform |
| `0x1C` | PPG_RT | `00` | raw IR/red PPG |

`getInfo` is literally `aa 14 eb 00 00 00 00 c6`.

Other `PARA_SYNC` keys the app uses: `SetOxiThr`, `SetOxiSwitch`, `SetMotor`,
`SetHRSwitch`, `SetHRLowThr`, `SetHRHighThr`, `SetLightingMode`, `SetLightStr`
(values sent as strings).

## 3. Downloading

1. `INFO` → JSON. `FileList` is a comma-separated list of session names
   (`"20260917141352,20260917231109,"`).
2. For each file: `READ_START(name)` → size; repeat `READ_CONTENT` with an
   incrementing block number until `size` bytes have arrived; `READ_END`.
   Downloading does not delete anything; the protocol used here has no delete
   command (the ring manages its own storage).

## 4. File format (FileVer 3)

40-byte little-endian header:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | file version |
| 1 | 1 | operation mode |
| 2 | 2 | year |
| 4–8 | 1 each | month, day, hour, minute, second (start time, ring local clock) |
| 9 | 4 | total file size |
| 13 | 2 | recording time (s) |
| 15 | 2 | asleep time (s) |
| 17 | 1 | average SpO2 |
| 18 | 1 | minimum SpO2 |
| 19 | 1 | drops ≥3 % |
| 20 | 1 | drops ≥4 % |
| 21 | 1 | asleep-time percent |
| 22 | 2 | seconds below 90 % |
| 24 | 1 | drops below 90 % |
| 25 | 1 | O2 score ×10 (`0xFF` = none) |
| 26 | 4 | steps |
| 30 | 10 | reserved |

Then `(size − 40) / 5` samples, one every **4 seconds**:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | SpO2 % (`0xFF` = invalid / off finger) |
| 1 | 2 | pulse rate bpm (`0xFFFF` = invalid) |
| 3 | 1 | motion |
| 4 | 1 | warning flags (`0x80` SpO2, `0x40` PR, `0x20` motion, `0x10` invalid) |

## Firmware quirks worth knowing

- **A missing file is answered with "OK".** If `READ_START` names a file the ring
  can no longer open, it still replies with status 0 and then serves *whichever
  file was opened last*. Files are named after their start time
  (`YYYYMMDDHHMMSS`), and the same timestamp is in the header, so compare the two
  before trusting a download (`name_matches()` in `o2ring_download.py`).
- **One night can arrive as several files.** Taking the ring off for a few minutes
  ends the recording and starts a new one. The report server can combine them.
- The ring keeps only its last few recordings and drops the oldest itself; there
  is no delete command in the protocol used here.
- The ring only advertises while worn, and accepts one BLE connection at a time.


## Where this lives in the decompiled app

| What | jadx path |
|---|---|
| Protocol state machine | `doab/doem.java` (`OxyBleInterface`) |
| Command builders / opcodes | `doac/ifgm.java` (`OxyBleCmd`) |
| GATT UUIDs | `doab/doen.java` (`OxyBleManager`) |
| CRC‑8 table | `doac/dobm.java` |
| Info JSON parser | `doac/Cfor.java` |
| File parser | `doad/dofd.java` |
| App-level flow | `com/lookee/android/Activity/DashboardActivityKt.java` (`HISTORY_FLOW` logs) |
