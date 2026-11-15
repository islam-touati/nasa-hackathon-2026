import contextlib
import importlib.util
import io
import json
import os
import struct
import tempfile
import unittest
import zipfile


spec = importlib.util.spec_from_file_location(
    "firms_reader", os.path.join(os.path.dirname(__file__), "read-firms-zip.py")
)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def fixture_dbf():
    fields = [("LATITUDE", 8), ("ACQ_DATE", 8)]
    header_size = 32 + 32 * len(fields) + 1
    record_size = 1 + sum(width for _, width in fields)
    header = bytearray(32)
    header[0] = 3
    struct.pack_into("<IHH", header, 4, 24000, header_size, record_size)
    descriptors = bytearray()
    for name, width in fields:
        descriptor = bytearray(32)
        descriptor[:len(name)] = name.encode("ascii")
        descriptor[11] = ord("C")
        descriptor[16] = width
        descriptors.extend(descriptor)
    data = bytearray(header + descriptors + b"\r")
    for i in range(24000):
        month = i // 2000 + 1
        data.extend(f" {'1':<8}2025{month:02}01".encode("ascii"))
    return data


class SampleTests(unittest.TestCase):
    def test_sample_is_reproducible_across_twelve_months_and_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "source.zip")
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("source.dbf", fixture_dbf())

            def read(after):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    reader.records(path, "source.dbf", after, 5)
                return [json.loads(line) for line in output.getvalue().splitlines()]

            all_rows = read(0)
            self.assertEqual(all_rows, read(0))
            self.assertEqual([x for x in all_rows if x["row"] > 12000], read(12000))
            for month in range(1, 13):
                count = sum(x["fields"]["acq_date"][4:6] == f"{month:02}" for x in all_rows)
                self.assertGreaterEqual(count, 60)
                self.assertLessEqual(count, 140)
            self.assertTrue(all(1 <= row["row"] <= 24000 for row in all_rows))


if __name__ == "__main__":
    unittest.main()
