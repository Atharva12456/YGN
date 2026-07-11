import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "snapshot_bill_ai.py"


def load_snapshot_module():
    spec = importlib.util.spec_from_file_location("ygn_snapshot_bill_ai_test", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SnapshotBillAiTests(unittest.TestCase):
    def setUp(self):
        self.module = load_snapshot_module()
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.module.OUT_PATH = root / "bill-ai.json"
        self.module.DIGEST_PATH = root / "recent-bills-digest.json"
        self.module.BILLS_DIR = root / "bills"

    def tearDown(self):
        self.temp_dir.cleanup()

    @staticmethod
    def bill(updated_at="2026-07-11T00:00:00Z"):
        return {
            "identifier": "HR 1",
            "title": "Test bill",
            "congress": 119,
            "type": "HR",
            "number": "1",
            "detailPath": "119/hr/1",
            "updatedAt": updated_at,
        }

    @staticmethod
    def generated():
        return {
            "aiDescription": {
                "summary": "Plain-language description.",
                "model": "test-model",
                "provider": "test",
                "generated_at": "2026-07-11T01:00:00Z",
                "content_version": "bill-ai-v5",
                "input_hash": "description-hash",
            },
            "impact": {
                "summary": "Concrete impact analysis.",
                "model": "test-model",
                "provider": "test",
                "generated_at": "2026-07-11T01:00:00Z",
                "content_version": "bill-ai-v5",
                "input_hash": "impact-hash",
            },
        }

    def write_json(self, path, payload):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")

    def run_main(self, backend, *args):
        with patch.object(self.module, "load_backend", return_value=backend), patch.object(
            sys, "argv", [str(SCRIPT_PATH), *args]
        ):
            return self.module.main()

    def test_canonical_key_scopes_the_same_display_id_by_congress(self):
        bill_118 = {**self.bill(), "congress": 118, "detailPath": "118/hr/1"}
        self.assertEqual(self.module.canonical_key(bill_118), "118/hr/1")
        self.assertEqual(self.module.canonical_key(self.bill()), "119/hr/1")

    def test_unchanged_bill_makes_no_model_refresh_call(self):
        bill = self.bill()
        entry = {
            "content_version": "bill-ai-v5",
            "source_updated_at": bill["updatedAt"],
            "description": {"summary": "Already cached."},
            "impact": {"summary": "Already cached impact."},
        }
        self.write_json(
            self.module.OUT_PATH,
            {"schema_version": 2, "bills": {"119/hr/1": entry}},
        )
        backend = Mock()
        backend.AI_BILL_CONTENT_VERSION = "bill-ai-v5"
        backend.ai_insights_available.return_value = True
        backend.congress_api_key_available.return_value = True
        backend.getRecentBillDigest.return_value = {"bills": [bill]}

        self.assertEqual(self.run_main(backend), 0)
        backend.refresh_bill_ai.assert_not_called()

    def test_new_bill_refreshes_once_and_updates_same_run_artifacts(self):
        bill = self.bill()
        self.write_json(
            self.module.DIGEST_PATH,
            {"bills": [{**bill, "impact": {"status": "Pending"}}]},
        )
        self.write_json(
            self.module.BILLS_DIR / "119-hr-1.json",
            {"bill": {**bill, "impact": {"status": "Pending"}}},
        )
        backend = Mock()
        backend.AI_BILL_CONTENT_VERSION = "bill-ai-v5"
        backend.ai_insights_available.return_value = True
        backend.congress_api_key_available.return_value = True
        backend.getRecentBillDigest.return_value = {"bills": [bill]}
        backend.refresh_bill_ai.return_value = self.generated()

        self.assertEqual(self.run_main(backend), 0)
        backend.refresh_bill_ai.assert_called_once_with("119", "hr", "1", force=True)

        store = json.loads(self.module.OUT_PATH.read_text(encoding="utf-8"))
        self.assertIn("119/hr/1", store["bills"])
        digest = json.loads(self.module.DIGEST_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            digest["bills"][0]["impact"]["summary"], "Concrete impact analysis."
        )
        detail = json.loads(
            (self.module.BILLS_DIR / "119-hr-1.json").read_text(encoding="utf-8")
        )
        self.assertFalse(detail["bill"]["aiPending"])

    def test_failed_refresh_preserves_previous_committed_record(self):
        bill = self.bill("2026-07-12T00:00:00Z")
        previous = {
            "content_version": "bill-ai-v5",
            "source_updated_at": "2026-07-10T00:00:00Z",
            "description": {"summary": "Previous description."},
            "impact": {"summary": "Previous impact."},
        }
        original = {"schema_version": 2, "bills": {"119/hr/1": previous}}
        self.write_json(self.module.OUT_PATH, original)
        backend = Mock()
        backend.AI_BILL_CONTENT_VERSION = "bill-ai-v5"
        backend.ai_insights_available.return_value = True
        backend.congress_api_key_available.return_value = True
        backend.getRecentBillDigest.return_value = {"bills": [bill]}
        backend.refresh_bill_ai.side_effect = RuntimeError("provider down")

        self.assertEqual(self.run_main(backend), 0)
        self.assertEqual(
            json.loads(self.module.OUT_PATH.read_text(encoding="utf-8")), original
        )

    def test_legacy_display_key_is_read_then_replaced_canonically(self):
        bill = self.bill()
        store = {"HR 1": {"description": {"summary": "Legacy content."}}}
        self.assertEqual(
            self.module.store_entry_for_bill(store, bill)["description"]["summary"],
            "Legacy content.",
        )
        self.write_json(self.module.OUT_PATH, {"bills": store})
        backend = Mock()
        backend.AI_BILL_CONTENT_VERSION = "bill-ai-v5"
        backend.ai_insights_available.return_value = True
        backend.congress_api_key_available.return_value = True
        backend.getRecentBillDigest.return_value = {"bills": [bill]}
        backend.refresh_bill_ai.return_value = self.generated()

        self.assertEqual(self.run_main(backend), 0)
        migrated = json.loads(self.module.OUT_PATH.read_text(encoding="utf-8"))["bills"]
        self.assertIn("119/hr/1", migrated)
        self.assertNotIn("HR 1", migrated)


if __name__ == "__main__":
    unittest.main()
