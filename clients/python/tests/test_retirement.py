"""Retirement receipts are data contracts, not simulated model results."""
import unittest
from agenticdriver._retrieval import valid_retire_result

class RetirementReceiptTests(unittest.TestCase):
    def test_fence_is_explicit_and_matches_exact_source(self):
        request = {"corpus": "library", "sourceId": "paper-immutable", "revision": "revision-1"}
        ordinary = {**request, "deleted": False}
        self.assertFalse(valid_retire_result(ordinary, request))
        for flag in (False, 1, "true", None):
            self.assertFalse(valid_retire_result({**ordinary, "retired": flag}, request))
        self.assertTrue(valid_retire_result({**ordinary, "retired": True}, request))
        self.assertFalse(valid_retire_result({**ordinary, "retired": True, "revision": "other-revision"}, request))
