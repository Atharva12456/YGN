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

    def get_ethics_score(self, bioguide_id):
        self.ethics_requests.append(bioguide_id)
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

        self.assertEqual(exit_code, 0)
        self.assertEqual(backend.wiki_requests, ["B000001"])
        self.assertEqual(backend.nominate_requests, ["A000001", "B000001"])
        self.assertEqual(backend.ethics_requests, ["A000001", "B000001"])
        self.assertEqual(manifest["descriptions"], 2)
        self.assertEqual(manifest["wiki_reused"], 1)
        self.assertEqual(manifest["nominate"], 2)
        self.assertEqual(manifest["ethics"], 2)
        self.assertEqual(manifest["ethics_fallback"], 2)


if __name__ == "__main__":
    unittest.main()
