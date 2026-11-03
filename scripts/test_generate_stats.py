"""Tests for scripts/generate-stats.py (stdlib unittest, zero new deps).

The module filename contains a dash, so it is loaded by path via importlib.
Upstream fetches are mocked at fetch_svg; no network is touched.

Run: python -m unittest discover -s scripts -v
"""

import importlib.util
import os
import unittest
from unittest.mock import patch

_SPEC = importlib.util.spec_from_file_location(
    "generate_stats", os.path.join(os.path.dirname(os.path.abspath(__file__)), "generate-stats.py")
)
gs = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(gs)


class FetchWithFallbackTests(unittest.TestCase):
    def test_falls_back_to_second_source_when_first_fails(self):
        # attempts=1 isolates fallback semantics from the per-URL retry loop
        with patch.object(gs, "fetch_svg", side_effect=[OSError("boom"), "<svg>ok</svg>"]):
            svg, url = gs.fetch_with_fallback(["a", "b"], gs.STATS_ERROR_MARKS, attempts=1)
        self.assertEqual(svg, "<svg>ok</svg>")
        self.assertEqual(url, "b")

    def test_rejects_upstream_error_card_and_falls_back(self):
        with patch.object(gs, "fetch_svg", side_effect=["Something went wrong while rendering", "<svg>ok</svg>"]):
            svg, url = gs.fetch_with_fallback(["a", "b"], gs.STATS_ERROR_MARKS, attempts=1)
        self.assertEqual(url, "b", "error-marked HTTP-200 card must be rejected, not returned")

    def test_rejects_streak_structural_error_marker(self):
        with patch.object(gs, "fetch_svg", side_effect=["<!-- Error lable -->", "<svg>ok</svg>"]):
            svg, url = gs.fetch_with_fallback(["a", "b"], gs.STREAK_ERROR_MARKS, attempts=1)
        self.assertEqual(url, "b")

    def test_raises_last_error_when_all_sources_fail(self):
        with patch.object(gs, "fetch_svg", side_effect=OSError("down")), \
             self.assertRaises(OSError):
            gs.fetch_with_fallback(["a", "b"], gs.STATS_ERROR_MARKS)

    def test_backoff_sleeps_between_but_not_after_final_attempt(self):
        # 2 urls x 2 attempts, all failing -> exactly 2 sleeps (one before each
        # retry), never after the final attempt.
        with patch.object(gs, "fetch_svg", side_effect=OSError("down")), \
             patch.object(gs.time, "sleep") as sleep_mock, \
             self.assertRaises(OSError):
            gs.fetch_with_fallback(["a", "b"], gs.STATS_ERROR_MARKS, attempts=2)
        self.assertEqual(sleep_mock.call_count, 2)

    def test_successful_first_source_never_sleeps(self):
        with patch.object(gs, "fetch_svg", side_effect=["<svg>ok</svg>"]), \
             patch.object(gs.time, "sleep") as sleep_mock:
            gs.fetch_with_fallback(["a", "b"], gs.STATS_ERROR_MARKS)
        sleep_mock.assert_not_called()


class ErrorMarkContractTests(unittest.TestCase):
    def test_streak_marks_cover_all_known_error_shapes(self):
        # The shim normalizes self-hosted error cards to 503, but the demoted
        # public fallback (demolab) still answers 200 with these bodies.
        for mark in ("Something went wrong", "Could not find a user with that name.", "Error lable"):
            self.assertIn(mark, gs.STREAK_ERROR_MARKS)

    def test_stats_marks_cover_upstream_error_card(self):
        self.assertIn("Something went wrong", gs.STATS_ERROR_MARKS)


if __name__ == "__main__":
    unittest.main()
