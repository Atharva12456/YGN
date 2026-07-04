import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "empty-folder" / "CongressMembers.py"


def load_module():
    requests_stub = types.SimpleNamespace(get=Mock())
    previous_requests = sys.modules.get("requests")
    sys.modules["requests"] = requests_stub

    spec = importlib.util.spec_from_file_location("CongressMembers_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    finally:
        if previous_requests is None:
            sys.modules.pop("requests", None)
        else:
            sys.modules["requests"] = previous_requests

    return module


def fake_response(payload):
    response = Mock()
    response.json.return_value = payload
    response.raise_for_status.return_value = None
    return response


class CongressMembersCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_env = dict(os.environ)
        os.environ["YGN_CACHE_PATH"] = str(Path(self.temp_dir.name) / "cache.sqlite")
        os.environ["YGN_CACHE_TTL_SECONDS"] = "900"
        os.environ["CONGRESS_API_KEY"] = "test-key"
        self.module = load_module()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old_env)
        self.temp_dir.cleanup()

    def test_all_congress_members_uses_fresh_cache(self):
        with patch.object(self.module.requests, "get") as requests_get:
            requests_get.return_value = fake_response({"members": [{"name": "Test Member"}]})

            first = self.module.allCongressMembers()
            second = self.module.allCongressMembers()

        self.assertEqual(first, second)
        self.assertEqual(requests_get.call_count, 1)

    def test_stale_cache_refreshes(self):
        os.environ["YGN_CACHE_TTL_SECONDS"] = "0"
        responses = [
            fake_response({"members": [{"name": "Old"}]}),
            fake_response({"members": [{"name": "New"}]}),
        ]

        with patch.object(self.module.requests, "get", side_effect=responses) as requests_get:
            first = self.module.allCongressMembers()
            second = self.module.allCongressMembers()

        self.assertEqual(first["members"][0]["name"], "Old")
        self.assertEqual(second["members"][0]["name"], "New")
        self.assertEqual(requests_get.call_count, 2)

    def test_missing_congress_api_key_raises_before_request(self):
        os.environ.pop("CONGRESS_API_KEY")

        with patch.object(self.module.requests, "get") as requests_get:
            with self.assertRaises(self.module.MissingCongressApiKey):
                self.module.allCongressMembers()

        requests_get.assert_not_called()

    def test_get_member_id_paginates_and_caches_pages(self):
        def response_for_request(url, params=None, **kwargs):
            offset = params.get("offset", 0)
            if offset == 0:
                return fake_response(
                    {
                        "members": [
                            {
                                "name": "Someone Else",
                                "bioguideId": "X000000",
                                "terms": {"item": [{"congress": 118, "chamber": "House"}]},
                            }
                        ],
                        "pagination": {"count": 251},
                    }
                )

            return fake_response(
                {
                    "members": [
                        {
                            "name": "Example, Jane",
                            "bioguideId": "J000001",
                            "partyName": "Independent",
                            "state": "NY",
                            "terms": {"item": [{"congress": 118, "chamber": "House"}]},
                        }
                    ],
                    "pagination": {"count": 251},
                }
            )

        with patch.object(self.module.requests, "get", side_effect=response_for_request) as requests_get:
            first = self.module.getMemberID("Jane", chamber="house", congress=118)
            second = self.module.getMemberID("Jane", chamber="house", congress=118)

        self.assertEqual(first, "J000001")
        self.assertEqual(second, "J000001")
        self.assertEqual(requests_get.call_count, 2)

    def test_wiki_summary_is_cached_by_bioguide_id(self):
        def response_for_request(url, params=None, headers=None, **kwargs):
            if "/member/A000001" in url:
                return fake_response({"member": {"directOrderName": "Jane Example"}})
            if "/member/B000001" in url:
                return fake_response({"member": {"directOrderName": "John Example"}})
            if "Jane_Example" in url:
                return fake_response(
                    {
                        "title": "Jane Example",
                        "extract": "Jane summary",
                        "thumbnail": {"source": "https://example.test/jane.jpg"},
                        "content_urls": {
                            "desktop": {"page": "https://en.wikipedia.org/wiki/Jane_Example"}
                        },
                    }
                )
            return fake_response(
                {
                    "title": "John Example",
                    "extract": "John summary",
                    "content_urls": {
                        "desktop": {"page": "https://en.wikipedia.org/wiki/John_Example"}
                    },
                }
            )

        with patch.object(self.module.requests, "get", side_effect=response_for_request) as requests_get:
            first = self.module.get_wiki_summary("A000001")
            second = self.module.get_wiki_summary("A000001")
            third = self.module.get_wiki_summary("B000001")

        self.assertEqual(first, second)
        self.assertEqual(first["title"], "Jane Example")
        self.assertEqual(third["title"], "John Example")
        self.assertEqual(requests_get.call_count, 4)

    def test_nominate_score_allows_blank_geo_mean(self):
        csv_path = Path(self.temp_dir.name) / "HSall_members.csv"
        csv_path.write_text(
            "congress,bioguide_id,nominate_dim1,nominate_geo_mean_probability\n"
            "117,A000001,0.25,\n",
            encoding="utf-8",
        )
        self.module.CSV_PATH = csv_path

        score = self.module.get_nominate_score("A000001")

        self.assertEqual(score, {"dim1": 0.25, "geo_mean": None})


if __name__ == "__main__":
    unittest.main()
