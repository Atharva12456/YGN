import importlib.util
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "generate_static_data.py"


def load_module():
    spec = importlib.util.spec_from_file_location("generate_static_data_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeBackend:
    UpstreamDataError = RuntimeError
    ETHICS_METHOD_VERSION = "campaign_finance_stock_v4"

    def __init__(self):
        self.wiki_requests = []
        self.nominate_requests = []
        self.ethics_requests = []
        self.detail_requests = []
        self.fallback_requests = []
        self.debt_requests = 0

    def congress_api_key_available(self):
        return True

    def listCongressMembers(self, limit, offset, congress, current_member):
        return {
            "members": [
                {"bioguideId": "A000001", "name": "Example, Jane"},
                {"bioguideId": "B000001", "name": "Example, John"},
            ],
            "pagination": {"count": 2},
        }

    def getRecentBills(self):
        return {"bills": []}

    def getRecentBillDigest(self, limit=40):
        return {"bills": []}

    def get_national_debt_metric(self):
        self.debt_requests += 1
        return None

    def _member_chamber(self, member):
        return member.get("chamber") or "House"

    def _party_abbreviation(self, member):
        return member.get("party") or "D"

    def _member_state_code(self, member):
        return member.get("state") or "NY"

    def CongressMembersID(self, bioguide_id):
        self.detail_requests.append(bioguide_id)
        return {"member": {"bioguideId": bioguide_id}}

    def get_wiki_summary(self, bioguide_id):
        self.wiki_requests.append(bioguide_id)
        return {
            "source": "wikipedia",
            "title": f"{bioguide_id} title",
            "summary": f"{bioguide_id} summary",
        }

    def get_nominate_score(self, bioguide_id):
        self.nominate_requests.append(bioguide_id)
        return {"dim1": 0.25, "geo_mean": None}

    def compute_ethics_score(self, bioguide_id):
        self.ethics_requests.append(bioguide_id)
        return {
            "bioguideId": bioguide_id,
            "score": 72.0,
            "grade": "C-",
            "source": "fec_live",
            "method": self.ETHICS_METHOD_VERSION,
            "funding": {
                "available": True,
                "candidate": {"candidateId": "H0XX00001"},
                "cycle": 2026,
                "totals": {"receipts": 1000.0},
                "breakdown": [],
            },
        }

    def ethics_fallback_only(self, bioguide_id):
        self.fallback_requests.append(bioguide_id)
        return {
            "bioguideId": bioguide_id,
            "available": False,
            "score": None,
            "grade": "N/A",
            "source": "unavailable",
            "method": self.ETHICS_METHOD_VERSION,
            "components": {},
        }


class GenerateStaticDataTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()

    def test_reused_wiki_snapshot_does_not_skip_nominate_generation(self):
        backend = FakeBackend()

        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            wiki_path = output_dir / "wiki" / "A000001.json"
            wiki_path.parent.mkdir(parents=True, exist_ok=True)
            wiki_path.write_text(
                json.dumps(
                    {
                        "generated_at": datetime.now(timezone.utc).isoformat(),
                        "source": "wikipedia",
                        "title": "Jane Example",
                        "summary": "Reusable summary",
                    }
                ),
                encoding="utf-8",
            )

            argv = [
                "generate_static_data.py",
                "--output-dir",
                str(output_dir),
                "--max-members",
                "all",
                "--skip-details",
                "--skip-recent-bills",
                "--wiki-delay-seconds",
                "0",
            ]
            with patch.object(sys, "argv", argv), patch.object(
                self.module, "load_backend", return_value=backend
            ), redirect_stdout(io.StringIO()):
                exit_code = self.module.main()

            manifest = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))
            score_index = json.loads((output_dir / "member-scores.json").read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(backend.wiki_requests, ["B000001"])
        self.assertEqual(backend.nominate_requests, ["A000001", "B000001"])
        self.assertEqual(backend.ethics_requests, ["A000001", "B000001"])
        self.assertEqual(manifest["descriptions"], 2)
        self.assertEqual(manifest["wiki_reused"], 1)
        self.assertEqual(manifest["nominate"], 2)
        self.assertEqual(manifest["ethics"], 2)
        self.assertEqual(manifest["ethics_fallback"], 0)
        self.assertTrue(manifest["member_score_index"])
        self.assertEqual(set(score_index["nominate"]), {"A000001", "B000001"})
        self.assertEqual(set(score_index["ethics"]), {"A000001", "B000001"})

    def _run_ethics_only(self, output_dir, extra_argv, backend):
        argv = [
            "generate_static_data.py", "--output-dir", str(output_dir),
            "--max-members", "all", "--ethics-only",
        ] + extra_argv
        with patch.object(sys, "argv", argv), patch.object(
            self.module, "load_backend", return_value=backend
        ), redirect_stdout(io.StringIO()):
            self.module.main()

    def test_fresh_fec_live_grade_is_reused_not_rescored(self):
        backend = FakeBackend()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            eth_path = output_dir / "ethics" / "A000001.json"
            eth_path.parent.mkdir(parents=True, exist_ok=True)
            original_generated_at = datetime.now(timezone.utc).isoformat()
            eth_path.write_text(json.dumps({
                "generated_at": original_generated_at,
                "source": "fec_live", "grade": "A", "score": 95.0,
                "method": backend.ETHICS_METHOD_VERSION,
                "funding": {"available": True},
            }), encoding="utf-8")
            self._run_ethics_only(output_dir, [], backend)
            score_index = json.loads((output_dir / "member-scores.json").read_text(encoding="utf-8"))
            persisted = json.loads(eth_path.read_text(encoding="utf-8"))
        # A000001 is current-method fec_live + fresh, so only B000001 is scored.
        self.assertEqual(backend.ethics_requests, ["B000001"])
        self.assertEqual(score_index["ethics"]["A000001"]["grade"], "A")
        self.assertEqual(score_index["ethics"]["A000001"]["source"], "fec_live")
        self.assertEqual(persisted["generated_at"], original_generated_at)

    def test_fresh_ethics_without_funding_is_selected_for_migration(self):
        backend = FakeBackend()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            eth_path = output_dir / "ethics" / "A000001.json"
            eth_path.parent.mkdir(parents=True, exist_ok=True)
            eth_path.write_text(json.dumps({
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "source": "fec_live", "grade": "A", "score": 95.0,
                "method": backend.ETHICS_METHOD_VERSION,
            }), encoding="utf-8")

            self._run_ethics_only(
                output_dir, ["--fec-score-limit", "1"], backend
            )
            persisted = json.loads(eth_path.read_text(encoding="utf-8"))

        self.assertEqual(backend.ethics_requests, ["A000001"])
        self.assertTrue(persisted["funding"]["available"])

    def test_funding_snapshot_from_ethics_avoids_recursive_payload(self):
        ethics = FakeBackend().compute_ethics_score("A000001")
        funding = self.module.funding_snapshot_from_ethics(ethics)

        self.assertTrue(funding["available"])
        self.assertEqual(funding["source"], "fec_committed")
        self.assertEqual(funding["grade"]["grade"], "C-")
        self.assertNotIn("funding", funding["grade"])

    def test_fec_score_limit_caps_live_scoring_per_run(self):
        backend = FakeBackend()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            self._run_ethics_only(output_dir, ["--fec-score-limit", "1"], backend)
            manifest = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))
            unavailable = json.loads(
                (output_dir / "ethics" / "B000001.json").read_text(encoding="utf-8")
            )
        # A budget of one leaves the second member explicitly unavailable instead
        # of assigning a synthetic grade. Both records are still written.
        self.assertEqual(backend.ethics_requests, ["A000001"])
        self.assertEqual(manifest["ethics"], 2)
        self.assertEqual(manifest["ethics_fallback"], 1)
        self.assertEqual(manifest["fec_scored_this_run"], 1)
        self.assertIsNone(unavailable["score"])
        self.assertEqual(unavailable["grade"], "N/A")
        self.assertEqual(unavailable["source"], "unavailable")

    def test_ethics_only_reuses_unselected_fallback_without_full_rebuild(self):
        backend = FakeBackend()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            ethics_dir = output_dir / "ethics"
            ethics_dir.mkdir(parents=True)
            (ethics_dir / "B000001.json").write_text(json.dumps({
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "bioguideId": "B000001",
                "score": None,
                "grade": "N/A",
                "source": "unavailable",
                "method": backend.ETHICS_METHOD_VERSION,
            }), encoding="utf-8")

            self._run_ethics_only(
                output_dir, ["--fec-score-limit", "1"], backend
            )

        self.assertEqual(backend.ethics_requests, ["A000001"])
        self.assertEqual(backend.fallback_requests, [])
        self.assertEqual(backend.detail_requests, [])
        self.assertEqual(backend.debt_requests, 0)

    def test_ethics_only_can_overlap_live_lookups(self):
        backend = FakeBackend()
        active = 0
        peak_active = 0
        lock = threading.Lock()
        original_compute = backend.compute_ethics_score

        def slow_compute(bioguide_id):
            nonlocal active, peak_active
            with lock:
                active += 1
                peak_active = max(peak_active, active)
            try:
                time.sleep(0.03)
                return original_compute(bioguide_id)
            finally:
                with lock:
                    active -= 1

        backend.compute_ethics_score = slow_compute
        with tempfile.TemporaryDirectory() as temp_dir:
            self._run_ethics_only(
                Path(temp_dir), ["--fec-workers", "2"], backend
            )

        self.assertEqual(set(backend.ethics_requests), {"A000001", "B000001"})
        self.assertEqual(peak_active, 2)

    def test_fec_budget_advances_across_runs_and_preserves_prior_grade(self):
        backend = FakeBackend()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            self._run_ethics_only(output_dir, ["--fec-score-limit", "1"], backend)
            first_manifest = json.loads(
                (output_dir / "manifest.json").read_text(encoding="utf-8")
            )

            self._run_ethics_only(output_dir, ["--fec-score-limit", "1"], backend)
            second_manifest = json.loads(
                (output_dir / "manifest.json").read_text(encoding="utf-8")
            )
            score_index = json.loads(
                (output_dir / "member-scores.json").read_text(encoding="utf-8")
            )

        self.assertEqual(backend.ethics_requests, ["A000001", "B000001"])
        self.assertEqual(first_manifest["ethics_sweep_cursor"], "A000001")
        self.assertEqual(second_manifest["ethics_sweep_cursor"], "B000001")
        self.assertEqual(set(score_index["ethics"]), {"A000001", "B000001"})

    def test_skip_ethics_keeps_existing_grades_in_score_index(self):
        backend = FakeBackend()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            self._run_ethics_only(output_dir, [], backend)
            (output_dir / "member-scores.json").unlink()

            self._run_ethics_only(output_dir, ["--skip-ethics"], backend)
            score_index = json.loads(
                (output_dir / "member-scores.json").read_text(encoding="utf-8")
            )

        self.assertEqual(set(score_index["ethics"]), {"A000001", "B000001"})


if __name__ == "__main__":
    unittest.main()
