"""A real failing test whose startup timestamp changes; no source is modified."""
import time
import unittest

print(f"test_started_at_ns={time.time_ns()}", flush=True)


class FixedFailure(unittest.TestCase):
    def test_same_failure(self):
        self.assertEqual(1, 2, "fixed audit failure")


if __name__ == '__main__':
    unittest.main()
