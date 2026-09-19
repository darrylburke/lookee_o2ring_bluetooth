# Installation

Tested on Ubuntu 24.04 (BlueZ 5.72, Python 3.12, Node 21, MySQL 8.0). Everything
except the Bluetooth download also works anywhere Python and Node run.

| You want… | You need |
|---|---|
| to look at the demo report | Python 3.9+ |
| to download from the ring and get static HTML reports | + a Bluetooth LE adapter, `bleak` |
| the database, analytics history, trends, notes, tags, combine/hide | + MySQL 8.0.19 or newer, `pymysql`, Node.js 18+ |

> MariaDB is **not** supported as-is: the importer uses MySQL 8's
> `INSERT … AS new ON DUPLICATE KEY UPDATE` and a `JSON` column type.

## 1. Get the code and the Python packages

```bash
git clone https://github.com/<you>/lookee_o2ring_bluetooth.git
cd lookee_o2ring_bluetooth

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt      # bleak (Bluetooth) and pymysql (database)
```

Check that it works without any hardware:

```bash
./o2ring_report.py --demo            # -> reports/demo.html, open it in a browser
python3 -m unittest discover -s tests
```

## 2. Bluetooth

Linux needs BlueZ running and an adapter that is powered on:

```bash
sudo apt install bluez               # usually already there
bluetoothctl show | grep Powered     # "Powered: yes"  (bluetoothctl power on  otherwise)
```

Then put the ring on (it only switches on and advertises while worn) and **close
the phone app or turn the phone's Bluetooth off** – the ring accepts one
connection at a time and the app reconnects eagerly.

```bash
./o2ring_download.py --list          # finds "O2Ring xxxx", prints model, battery and the file list
./o2ring_download.py                 # downloads every file to ./o2ring_data
./o2ring_report.py --from-files o2ring_data      # reports/index.html
```

`bleak` also supports macOS and Windows. They are untested here; on macOS the
`--address` value is a UUID rather than a MAC address.

Each connection sets the ring's clock to the computer's local time, exactly as
the app does (`--no-sync-time` to skip). Timestamps in the recordings are the
ring's local wall-clock time.

## 3. MySQL

Create a database and a user for it (as the MySQL root user – on Ubuntu:
`sudo mysql`):

```sql
CREATE DATABASE lookee_data CHARACTER SET utf8mb4;
CREATE USER 'lookee'@'localhost' IDENTIFIED BY 'choose-a-password';
GRANT ALL PRIVILEGES ON lookee_data.* TO 'lookee'@'localhost';
```

The user needs `CREATE`, `ALTER` and the usual read/write rights on that one
schema: tables are created on first use and migrated automatically when a new
version adds columns.

Tell the tools how to connect:

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env                         # set O2RING_DB_PASSWORD (and host/user/name if different)
```

`.env` is git-ignored and is read by both the Python tools and the Node server.
Real environment variables take precedence over the file.

Load data:

```bash
./o2ring_download.py --db            # download from the ring, store and analyse
./o2ring_db.py o2ring_data           # or: import files you downloaded earlier
```

Both are safe to repeat – recordings already in the database are skipped.

## 4. Report server

```bash
cd server
npm install
npm test                             # optional
npm start                            # http://127.0.0.1:3000
```

- `HOST` and `PORT` (environment or `.env`) change where it listens. There is
  **no login**, so leave it on `127.0.0.1` unless the network is trusted or you
  put an authenticating reverse proxy in front of it.
- The server only answers to `localhost`, `127.0.0.1`, `::1` and the `HOST` you
  set. If you reach it under another name (a LAN IP with `HOST=0.0.0.0`, a
  hostname, a reverse proxy), list it: `O2RING_ALLOWED_HOSTS=nas.lan,192.168.1.20`.
- Combining recordings runs the Python analytics. The server calls `python3`;
  if that is not the interpreter that has `pymysql` (for example you use a venv
  and start the server from somewhere else), point it at the right one:

  ```bash
  O2RING_PYTHON=/path/to/lookee_o2ring_bluetooth/.venv/bin/python npm start
  ```

### Optional: the Ask panel

The start page, the Trends page and every report show an **Ask** panel that is
greyed out until you give the server an Anthropic API key:

1. Create a key at <https://console.anthropic.com/> (Settings → API keys). Usage
   is billed to your Anthropic account.
2. Add it to `.env`: `ANTHROPIC_API_KEY=sk-ant-…`
3. Restart the server.

If the panel stays grey, click it: the popup also points out a misspelt variable
name (it must be exactly `ANTHROPIC_API_KEY`).

`.env.example` lists the other settings (`O2RING_LLM_MODEL`,
`O2RING_LLM_SEND_NOTES=0`, `O2RING_LLM_DAILY_LIMIT`). Asking sends the figures
the model looks up to Anthropic's API – the README's *Asking questions* section
spells out what, and what is never sent. The server creates its two conversation
tables on start-up.

#### Optional: the read-only SQL tool

With `O2RING_LLM_SQL=1` the model may also write its own `SELECT` statements.
It must run through a MySQL user that can only read. As MySQL root
(`sudo mysql`):

```sql
CREATE USER 'lookee_ro'@'localhost' IDENTIFIED BY 'choose-another-password';
GRANT SELECT ON lookee_data.samples         TO 'lookee_ro'@'localhost';
GRANT SELECT ON lookee_data.session_metrics TO 'lookee_ro'@'localhost';
GRANT SELECT ON lookee_data.desat_events    TO 'lookee_ro'@'localhost';
GRANT SELECT ON lookee_data.tags            TO 'lookee_ro'@'localhost';
GRANT SELECT ON lookee_data.session_tags    TO 'lookee_ro'@'localhost';
-- sessions: everything except the ring's serial number (device_sn) and the raw file
GRANT SELECT (id, file_name, start_time, end_time, recording_s, gap_s, asleep_s, avg_spo2, min_spo2,
              drops_3pct, drops_4pct, seconds_below_90, drops_below_90, o2_score, steps, sample_count,
              notes, hidden, is_combined, merged_into)
      ON lookee_data.sessions TO 'lookee_ro'@'localhost';
```

Leave `notes` out of the last statement if you do not want the model to read
your notes. Then add to `.env` and restart:

```
O2RING_LLM_SQL=1
O2RING_DB_RO_USER=lookee_ro
O2RING_DB_RO_PASSWORD=choose-another-password
```

The server log says `Ask: read-only SQL tool enabled` – or why it stayed off.
It refuses the normal database user, a user with any privilege beyond `SELECT`
on this one database (`SELECT ON *.*` counts), and a user that turns out to be
able to read the serial number, the raw files, the `devices` table or your
stored conversations – or your notes, if `O2RING_LLM_SEND_NOTES=0`.

### Run it in the background (systemd user service)

`~/.config/systemd/user/o2ring-reports.service`:

```ini
[Unit]
Description=O2Ring report server
After=network.target mysql.service

[Service]
WorkingDirectory=%h/lookee_o2ring_bluetooth/server
Environment=O2RING_PYTHON=%h/lookee_o2ring_bluetooth/.venv/bin/python
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now o2ring-reports
```

## 5. Daily use

In the morning, with the ring still on (or put back on) and the phone app closed:

```bash
./o2ring_download.py --db
```

Then open <http://127.0.0.1:3000>. If the ring split the night into several
recordings the start page offers to combine them. Add tags ("alcohol", "late
meal", "side sleeping", …) at the bottom of a night's Insights so nights can be
compared on the Trends page; personal-baseline flags switch on after 14 full
nights. The ring only keeps its last few recordings, so download every day or two.

## Updating

```bash
git pull
pip install -r requirements.txt
(cd server && npm install)
./o2ring_db.py --reanalyze           # applies schema changes and recomputes nights analysed by an older version
```

Restart the server afterwards.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No O2Ring found` | Ring not on a finger (it sleeps when removed), still connected to the phone, or out of range. Try `--scan-timeout 30`, or pass `--address`. |
| Connects, then times out | The phone app grabbed the ring mid-transfer – force-stop the app or disable the phone's Bluetooth. |
| `skipped: the ring listed … but returned a different recording` | Firmware quirk: the ring lists a file it can no longer open and re-sends the previous one. Harmless – the bogus copy is discarded. |
| `org.bluez.Error.NotReady` / `No Bluetooth adapters found` | `bluetoothctl power on`; check `rfkill list`; inside a VM or container the adapter must be passed through. |
| `Access denied for user … to database` (1044) | The MySQL user has no rights on the schema – run the `GRANT` from step 3. |
| `Access denied for user …` (1045) | Wrong password in `.env` – or MySQL runs with `skip_name_resolve`, in which case create the user as `'lookee'@'127.0.0.1'` (the tools connect over TCP to `127.0.0.1`). |
| `You have an error in your SQL syntax … AS new` | MySQL older than 8.0.19, or MariaDB. |
| `host "…" is not allowed` (403) | You opened the server under a name it does not know – add it to `O2RING_ALLOWED_HOSTS` (step 4). |
| Ask panel is greyed out | No `ANTHROPIC_API_KEY` in `.env` (or the server was not restarted after adding it). Click the panel for the steps. On a saved report *file* it is always off – open the report from the server. |
| Log says `Ask: SQL tool is off – …` | The reason follows in the message: no read-only user configured, the user can do more than `SELECT`, or its login failed. |
| Ask: "Anthropic rejected the API key" / "model was not found" | Check the key, and that `O2RING_LLM_MODEL` names a model your key can use. |
| Report shows no Insights section | The night has not been analysed: `./o2ring_db.py --reanalyze`. |
| Combine works but the new night has no Insights; server log says `analytics failed` | The server could not run the Python analytics – set `O2RING_PYTHON` (step 4). |
| Times look shifted | Recordings carry the ring's wall-clock time with no time zone. The clock is set from the computer at each connection; after travelling, connect once before the night. |
| A hidden recording is gone | Start page → **Show hidden** → **Unhide**. Nothing is ever deleted by hiding or combining. |

## Uninstalling

```sql
DROP DATABASE lookee_data;
DROP USER 'lookee'@'localhost';
```

and delete the folder. `o2ring_data/` holds the raw downloads if you want to keep
them – they can be re-imported at any time with `./o2ring_db.py o2ring_data`.
