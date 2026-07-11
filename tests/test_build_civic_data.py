import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "build_civic_data.py"


def load_module():
    spec = importlib.util.spec_from_file_location("build_civic_data_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CivicDataHelperTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_module()

    def test_map_law_item_builds_detail_path(self):
        item = self.mod.map_law_item(
            {
                "congress": 119,
                "type": "HR",
                "number": "123",
                "title": "An Act",
                "laws": [{"number": "119-42", "type": "Public Law"}],
                "latestAction": {"actionDate": "2026-06-01", "text": "Became Public Law"},
            }
        )
        self.assertEqual(item["lawNumber"], "119-42")
        self.assertEqual(item["detailPath"], "119/hr/123")
        self.assertEqual(item["identifier"], "HR 123")

    def test_map_law_item_handles_missing_fields(self):
        item = self.mod.map_law_item({"title": "Orphan"})
        self.assertIsNone(item["lawNumber"])
        self.assertIsNone(item["detailPath"])

    def test_vote_notability_prefers_close_full_votes(self):
        close = self.mod._vote_notability({"totals": {"Yea": 215, "Nay": 214}})
        blowout = self.mod._vote_notability({"totals": {"Yea": 400, "Nay": 20}})
        tiny = self.mod._vote_notability({"totals": {"Yea": 5, "Nay": 4}})
        self.assertGreater(close, blowout)
        self.assertEqual(tiny, -1)  # near-empty procedural votes excluded

    def test_weekly_brief_input_is_stable_and_capped(self):
        digest = {
            "bills": [
                {
                    "identifier": f"HR {i}",
                    "title": f"Bill {i}",
                    "latestAction": {"text": "Referred"},
                    "aiDescription": {"summary": "Does a thing."},
                }
                for i in range(30)
            ]
        }
        material = self.mod.weekly_brief_input(digest)
        self.assertEqual(material.count("\n") + 1, 15)  # capped at 15 bills
        self.assertIn("HR 0", material)
        self.assertNotIn("HR 20", material)

    def test_weekly_brief_skips_when_hash_unchanged(self):
        digest = {"bills": [{"identifier": "HR 1", "title": "T", "latestAction": {"text": "x"}}]}
        material = self.mod.weekly_brief_input(digest)
        import hashlib

        input_hash = hashlib.sha256(
            f"{self.mod.WEEKLY_BRIEF_VERSION}|{material}".encode("utf-8")
        ).hexdigest()[:24]

        calls = {"llm": 0}

        class FakeBackend:
            @staticmethod
            def ai_insights_available():
                return True

            @staticmethod
            def _llm_chat(*a, **k):
                calls["llm"] += 1
                return "Summary."

            @staticmethod
            def _ai_provider_config():
                return {"model": "test"}

        import unittest.mock as mock

        with mock.patch.object(self.mod, "read_json") as read_json:
            def fake_read(path, default):
                name = str(path)
                if name.endswith("recent-bills-digest.json"):
                    return digest
                if name.endswith("weekly-brief.json"):
                    return {"input_hash": input_hash, "summary": "cached"}
                return default

            read_json.side_effect = fake_read
            payload, status = self.mod.build_weekly_brief(FakeBackend)

        self.assertEqual(calls["llm"], 0)  # the model must NOT run on unchanged input
        self.assertIn("unchanged", status)
        self.assertEqual(payload["summary"], "cached")


if __name__ == "__main__":
    unittest.main()
