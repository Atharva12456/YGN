import importlib.util
import io
import json
import sys
import tempfile
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

    def __init__(self):
        self.wiki_requests = []
        self.nominate_requests = []
        self.ethics_requests = []

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

    def CongressMembersID(self, bioguide_id):
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
            "source": "static_fallback",
        }

    def ethics_fallback_only(self, bioguide_id):
        return {
            "bioguideId": bioguide_id,
            "score": 72.0,
            "grade": "C-",
            "source": "static_fallback",
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
        self.assertEqual(manifest["ethics_fallback"], 2)
        self.assertTrue(manifest["member_score_index"])
        self.assertEqual(set(score_index["nominate"]), {"A000001", "B000001"})
        self.assertEqual(set(score_index["ethics"]), {"A000001", "B000001"})

    def _run_ethics_only(self, output_dir, extra_argv, backend):
        argv = [
            "generate_static_data.py", "--output-dir", str(output_dir),
            "--max-members", "all", "--skip-details", "--skip-wiki",
            "--skip-nominate", "--skip-recent-bills",
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
            eth_path.write_text(json.dumps({
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "source": "fec_live", "grade": "A", "score": 95.0,
            }), encoding="utf-8")
            self._run_ethics_only(output_dir, [], backend)
            score_index = json.loads((output_dir / "member-scores.json").read_text(encoding="utf-8"))
        # A000001 already fec_live + fresh → kept for free; only B000001 is scored.
        self.assertEqual(backend.ethics_requests, ["B000001"])
        self.assertEqual(score_index["ethics"]["A000001"]["grade"], "A")
        self.assertEqual(score_index["ethics"]["A000001"]["source"], "fec_live")

    def test_fec_score_limit_caps_live_scoring_per_run(self):
        backend = FakeBackend()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            self._run_ethics_only(output_dir, ["--fec-score-limit", "1"], backend)
            manifest = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))
        # Budget of 1 → only the first member hits compute_ethics_score; the second
        # falls back without a live call. Both still get written.
        self.assertEqual(backend.ethics_requests, ["A000001"])
        self.assertEqual(manifest["ethics"], 2)
        self.assertEqual(manifest["fec_scored_this_run"], 1)


if __name__ == "__main__":
    unittest.main()
