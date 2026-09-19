import struct, sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from o2ring_download import build_cmd, crc8, name_matches, safe_name


def header(y, mo, d, h, mi, s):
    return (struct.pack("<BBHBBBBB", 3, 0, y, mo, d, h, mi, s)).ljust(40, b"\0")


class Download(unittest.TestCase):
    def test_known_command_bytes(self):
        self.assertEqual(build_cmd(0x14).hex(), "aa14eb00000000c6")
        self.assertEqual(crc8(b""), 0)

    def test_file_must_contain_the_recording_it_is_named_after(self):
        raw = header(2026, 9, 19, 5, 2, 55)
        self.assertTrue(name_matches("20260919050255", raw))
        self.assertFalse(name_matches("20260918121910", raw))   # ring re-served the previously opened file
        self.assertFalse(name_matches("20260919050255", b"short"))

    def test_ring_supplied_names_cannot_escape_the_output_folder(self):
        self.assertTrue(safe_name("20260919050255"))
        for bad in ("../../.ssh/authorized_keys", "a/b", "..", "", "x" * 33, "name.dat", "a\x00b"):
            self.assertFalse(safe_name(bad), bad)


if __name__ == "__main__":
    unittest.main()
