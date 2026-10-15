"""Offline contract tests. Never load weights or send provider requests."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

script = Path(__file__).resolve().parents[1] / "scripts/langextract-experiment.py"
spec = importlib.util.spec_from_file_location("grounded_trial", script)
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


class GroundingTests(unittest.TestCase):
    def extraction(self, quote, interval=None):
        return SimpleNamespace(extraction_text=quote, char_interval=interval, attributes={"category": "item", "subject": "钥匙", "predicate": "持有人", "object": "许照", "time": "current", "modality": "asserted"})

    def test_exact_unique_quote_can_support_two_distinct_facts(self):
        source = "# 第1章\n她捡起信封，将钥匙交给许照。"
        row = trial.ground(source, self.extraction("她捡起信封，将钥匙交给许照。"))
        self.assertEqual(row["paragraph"], 2)
        self.assertEqual(row["alignment"], "unique_exact_quote")
        self.assertEqual(source[row["start"]:row["end"]], row["evidence"])

    def test_repeated_ambiguous_quote_is_not_guessed(self):
        self.assertIsNone(trial.ground("门开了。门开了。", self.extraction("门开了。")))

    def test_nonexistent_quote_is_rejected(self):
        self.assertIsNone(trial.ground("许照不知密码。", self.extraction("许照知道密码。")))

    def test_existing_exact_span_is_retained(self):
        row = trial.ground("门开了。门开了。", self.extraction("门开了。", SimpleNamespace(start_pos=4, end_pos=8)))
        self.assertEqual(row["start"], 4)
        self.assertEqual(row["alignment"], "langextract_exact")

    def test_emoji_uses_utf16_offsets_and_nonblank_paragraph_numbers(self):
        source = "# 第1章\n\n🗝️韩芷不知道密码。"
        row = trial.ground(source, self.extraction("韩芷不知道密码。"))
        self.assertEqual(row["paragraph"], 2)
        self.assertEqual(source.encode("utf-16-le")[row["start"]*2:row["end"]*2].decode("utf-16-le"), row["evidence"])

    def test_replay_cannot_create_even_one_missing_request(self):
        budget = trial.Budget.__new__(trial.Budget)
        budget.ledger, budget.offline, budget.key = {"calls": []}, True, None
        with self.assertRaisesRegex(RuntimeError, "network is forbidden"):
            budget.request("a prompt without a saved response")

    def test_uncertain_request_is_never_resubmitted(self):
        budget = trial.Budget.__new__(trial.Budget)
        budget.ledger, budget.offline, budget.key = {"calls": [{"inputHash": "other", "status": "unknown"}]}, False, "unused-test-value"
        with self.assertRaisesRegex(RuntimeError, "manual reconciliation"):
            budget.request("test")


if __name__ == "__main__":
    unittest.main()
