import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "empty-folder" / "CongressMembers.py"


class FakeRequestException(Exception):
    pass


class FakeHTTPError(FakeRequestException):
    pass


def load_module():
    requests_stub = types.SimpleNamespace(
        get=Mock(),
        HTTPError=FakeHTTPError,
        RequestException=FakeRequestException,
    )
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


def fake_response(payload, status_code=200, raise_for_status=None, headers=None):
    response = Mock()
    response.status_code = status_code
    response.headers = headers or {}
    response.json.return_value = payload
    if raise_for_status is None:
        response.raise_for_status.return_value = None
    else:
        response.raise_for_status.side_effect = raise_for_status
    return response


class CongressMembersCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_env = dict(os.environ)
        os.environ["YGN_CACHE_PATH"] = str(Path(self.temp_dir.name) / "cache.sqlite")
        os.environ["YGN_CACHE_TTL_SECONDS"] = "900"
        os.environ["CONGRESS_API_KEY"] = "test-key"
        self.module = load_module()
        self.module.ENV_PATHS = ()

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

    def test_list_congress_members_can_filter_current_congress(self):
        with patch.object(self.module.requests, "get") as requests_get:
            requests_get.return_value = fake_response({"members": []})

            self.module.listCongressMembers(limit=250, offset=0, congress=119, current_member=True)

        self.assertTrue(requests_get.call_args.args[0].endswith("/member/congress/119"))
        self.assertEqual(requests_get.call_args.kwargs["params"]["currentMember"], "true")

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

    def test_local_dotenv_api_key_is_used(self):
        os.environ.pop("CONGRESS_API_KEY")
        env_path = Path(self.temp_dir.name) / ".env"
        env_path.write_text("CONGRESS_API_KEY=local-test-key\n", encoding="utf-8")
        self.module.ENV_PATHS = (env_path,)

        with patch.object(self.module.requests, "get") as requests_get:
            requests_get.return_value = fake_response({"members": []})

            self.module.allCongressMembers()

        self.assertEqual(requests_get.call_args.kwargs["params"]["api_key"], "local-test-key")

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
        self.assertEqual(first["summary"], "Jane summary")
        self.assertEqual(first["extract"], "Jane summary")
        self.assertEqual(third["title"], "John Example")
        self.assertEqual(requests_get.call_count, 4)

    def test_wiki_summary_searches_when_exact_title_is_missing(self):
        def response_for_request(url, params=None, headers=None, **kwargs):
            if "/member/A000001" in url:
                return fake_response(
                    {
                        "member": {
                            "directOrderName": "Eugene Simon Vindman",
                            "firstName": "Eugene",
                            "lastName": "Vindman",
                            "state": "Virginia",
                            "terms": [
                                {
                                    "chamber": "House of Representatives",
                                    "memberType": "Representative",
                                    "stateName": "Virginia",
                                }
                            ],
                        }
                    }
                )
            if "Eugene_Simon_Vindman" in url:
                return fake_response(
                    {},
                    status_code=404,
                    raise_for_status=self.module.requests.HTTPError("missing"),
                )
            if "w/api.php" in url:
                return fake_response(
                    {"query": {"search": [{"title": "Eugene Vindman"}]}}
                )
            if "Eugene_Vindman" in url:
                return fake_response(
                    {
                        "title": "Eugene Vindman",
                        "extract": "Eugene Vindman is an American politician and U.S. representative from Virginia.",
                        "content_urls": {
                            "desktop": {"page": "https://en.wikipedia.org/wiki/Eugene_Vindman"}
                        },
                    }
                )
            return fake_response({})

        with patch.object(self.module.requests, "get", side_effect=response_for_request):
            summary = self.module.get_wiki_summary("A000001")

        self.assertEqual(summary["source"], "wikipedia")
        self.assertEqual(summary["title"], "Eugene Vindman")
        self.assertIn("U.S. representative", summary["summary"])

    def test_wiki_summary_returns_congress_fallback_when_no_wiki_match(self):
        def response_for_request(url, params=None, headers=None, **kwargs):
            if "/member/A000001" in url:
                return fake_response(
                    {
                        "member": {
                            "directOrderName": "Jane Example",
                            "firstName": "Jane",
                            "lastName": "Example",
                            "state": "New York",
                            "district": 1,
                            "partyHistory": [{"partyName": "Democratic", "startYear": 2025}],
                            "terms": [
                                {
                                    "chamber": "House of Representatives",
                                    "memberType": "Representative",
                                    "startYear": 2025,
                                    "stateName": "New York",
                                    "district": 1,
                                }
                            ],
                        }
                    }
                )
            if "w/api.php" in url:
                return fake_response({"query": {"search": []}})
            return fake_response(
                {},
                status_code=404,
                raise_for_status=self.module.requests.HTTPError("missing"),
            )

        with patch.object(self.module.requests, "get", side_effect=response_for_request):
            summary = self.module.get_wiki_summary("A000001")

        self.assertEqual(summary["source"], "congress_fallback")
        self.assertIn("Jane Example", summary["summary"])
        self.assertIn("Democratic representative", summary["summary"])

    def test_wiki_summary_rejects_ambiguous_name_pages(self):
        def response_for_request(url, params=None, headers=None, **kwargs):
            if "/member/A000001" in url:
                return fake_response(
                    {
                        "member": {
                            "directOrderName": "John McGuire",
                            "firstName": "John",
                            "lastName": "McGuire",
                            "state": "Virginia",
                            "district": 5,
                            "partyHistory": [{"partyName": "Republican", "startYear": 2025}],
                            "terms": [
                                {
                                    "chamber": "House of Representatives",
                                    "memberType": "Representative",
                                    "startYear": 2025,
                                    "stateName": "Virginia",
                                    "district": 5,
                                }
                            ],
                        }
                    }
                )
            if "John_McGuire" in url:
                return fake_response(
                    {
                        "title": "John McGuire",
                        "extract": "John McGuire is the name of:",
                    }
                )
            if "w/api.php" in url:
                return fake_response({"query": {"search": []}})
            return fake_response(
                {},
                status_code=404,
                raise_for_status=self.module.requests.HTTPError("missing"),
            )

        with patch.object(self.module.requests, "get", side_effect=response_for_request):
            summary = self.module.get_wiki_summary("A000001")

        self.assertEqual(summary["source"], "congress_fallback")
        self.assertIn("John McGuire", summary["summary"])
        self.assertIn("Republican representative", summary["summary"])

    def test_wiki_summary_uses_longer_cache_ttl(self):
        os.environ["YGN_CACHE_TTL_SECONDS"] = "0"
        os.environ["YGN_WIKI_CACHE_TTL_SECONDS"] = "86400"

        def response_for_request(url, params=None, headers=None, **kwargs):
            if "/member/A000001" in url:
                return fake_response({"member": {"directOrderName": "Jane Example"}})
            return fake_response({"title": "Jane Example", "extract": "Jane summary"})

        with patch.object(self.module.requests, "get", side_effect=response_for_request) as requests_get:
            first = self.module.get_wiki_summary("A000001")
            second = self.module.get_wiki_summary("A000001")

        self.assertEqual(first, second)
        self.assertEqual(requests_get.call_count, 2)

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

    def test_ethics_score_is_unavailable_without_evidence_backed_fec_data(self):
        os.environ.pop("FEC_API_KEY", None)
        os.environ.pop("ECON_API_KEY", None)
        os.environ.pop("YGN_ECON_API_KEY", None)
        self.module.CongressMembersID = Mock(
            return_value={"member": {"bioguideId": "A000001", "directOrderName": "Jane Example"}}
        )

        score = self.module.get_ethics_score("A000001")

        self.assertFalse(score["available"])
        self.assertEqual(score["source"], "unavailable")
        self.assertEqual(score["method"], self.module.ETHICS_METHOD_VERSION)
        self.assertIsNone(score["score"])
        self.assertEqual(score["grade"], "N/A")
        self.assertEqual(score["components"], {})
        self.assertTrue(any("synthetic" in note.lower() for note in score["notes"]))

        other_score = self.module._static_ethics_fallback(
            "B000001",
            {
                "bioguideId": "B000001",
                "directOrderName": "John Example",
                "state": "CA",
                "district": 10,
                "partyName": "Republican",
                "terms": [{"chamber": "House of Representatives", "district": 10}],
            },
        )
        self.assertIsNone(other_score["score"])
        self.assertEqual(other_score["grade"], "N/A")
        self.assertEqual(other_score["source"], "unavailable")

    def test_ethics_formula_scores_live_fec_components(self):
        member = {
            "bioguideId": "A000001",
            "directOrderName": "Jane Example",
            "state": "NY",
            "district": 1,
            "partyHistory": [{"partyName": "Democratic", "startYear": 2025}],
            "terms": [{"chamber": "House of Representatives", "district": 1}],
        }
        candidate = {
            "candidate_id": "H0NY00001",
            "name": "EXAMPLE, JANE",
            "office": "H",
            "state": "NY",
            "district": "01",
            "party": "DEM",
        }
        totals = {
            "cycle": 2026,
            "individual_contributions": 1000,
            "individual_itemized_contributions": 600,
            "individual_unitemized_contributions": 400,
            "contributions": 1200,
            "receipts": 1500,
            "other_political_committee_contributions": 120,
            "political_party_committee_contributions": 0,
            "candidate_contribution": 0,
            "loans_made_by_candidate": 0,
            "loan_repayments_candidate_loans": 0,
        }
        by_size = [{"size": 2000, "total": 120}]
        by_state = [{"state": "NY", "total": 450}, {"state": "CA", "total": 550}]

        score = self.module._score_ethics_from_fec(member, candidate, totals, by_size, by_state)

        self.assertEqual(score["source"], "fec_live")
        self.assertEqual(score["method"], self.module.ETHICS_METHOD_VERSION)
        self.assertEqual(score["score"], 94.7)
        self.assertEqual(score["grade"], "A")

    def test_recent_bill_digest_enriches_and_caches_top_bills(self):
        def response_for_request(url, params=None, headers=None, **kwargs):
            if url == f"{self.module.BASE_URL}/bill":
                return fake_response(
                    {
                        "bills": [
                            {
                                "congress": 119,
                                "type": "HR",
                                "number": "1",
                                "title": "List title",
                                "originChamber": "House",
                                "latestAction": {
                                    "actionDate": "2026-01-02",
                                    "text": "Introduced in House.",
                                },
                                "updateDate": "2026-01-02",
                                "url": "https://api.congress.gov/v3/bill/119/hr/1?format=json",
                            }
                        ]
                    }
                )
            if url.endswith("/bill/119/hr/1/summaries"):
                return fake_response(
                    {
                        "summaries": [
                            {
                                "text": "<p>Summary from Congress.gov.</p>",
                                "updateDate": "2026-01-03",
                            }
                        ]
                    }
                )
            if url.endswith("/bill/119/hr/1"):
                return fake_response(
                    {
                        "bill": {
                            "title": "Detailed title",
                            "sponsors": [
                                {
                                    "fullName": "Jane Example",
                                    "state": "NY",
                                    "party": "D",
                                    "bioguideId": "E000001",
                                }
                            ],
                            "policyArea": {"name": "Education"},
                            "committees": [{"name": "House Education and Workforce"}],
                        }
                    }
                )
            return fake_response({})

        with patch.object(self.module.requests, "get", side_effect=response_for_request) as requests_get:
            first = self.module.getRecentBillDigest(limit=5)
            second = self.module.getRecentBillDigest(limit=5)

        self.assertEqual(first, second)
        self.assertEqual(requests_get.call_count, 3)
        bill = first["bills"][0]
        self.assertEqual(bill["identifier"], "HR 1")
        self.assertEqual(bill["title"], "Detailed title")
        self.assertEqual(bill["description"]["text"], "Summary from Congress.gov.")
        self.assertEqual(bill["members"][0]["name"], "Jane Example")
        self.assertEqual(bill["committees"], ["House Education and Workforce"])
        self.assertEqual(bill["impact"]["status"], "Pending AI impact analysis")

    def test_warm_cache_fills_member_detail_wiki_nominate_and_recent_bills(self):
        csv_path = Path(self.temp_dir.name) / "HSall_members.csv"
        csv_path.write_text(
            "congress,bioguide_id,nominate_dim1,nominate_geo_mean_probability\n"
            "117,A000001,0.25,0.99\n"
            "117,B000001,-0.5,\n",
            encoding="utf-8",
        )
        self.module.CSV_PATH = csv_path

        def response_for_request(url, params=None, headers=None, **kwargs):
            if url.endswith("/bill"):
                return fake_response({"bills": []})
            if url.endswith("/member") and params.get("offset") == 0:
                return fake_response(
                    {
                        "members": [
                            {"name": "Example, Jane", "bioguideId": "A000001"},
                            {"name": "Example, John", "bioguideId": "B000001"},
                        ],
                        "pagination": {"count": 2},
                    }
                )
            if "/member/A000001" in url:
                return fake_response({"member": {"directOrderName": "Jane Example"}})
            if "/member/B000001" in url:
                return fake_response({"member": {"directOrderName": "John Example"}})
            if "Jane_Example" in url:
                return fake_response({"title": "Jane Example", "extract": "Jane summary"})
            return fake_response({"title": "John Example", "extract": "John summary"})

        with patch.object(self.module.requests, "get", side_effect=response_for_request):
            report = self.module.warm_government_officials_cache()
            stats = self.module.get_cache_stats()

        self.assertEqual(report["member_pages_cached"], 1)
        self.assertEqual(report["members_seen"], 2)
        self.assertEqual(report["member_details_cached"], 2)
        self.assertEqual(report["wiki_summaries_cached"], 2)
        self.assertEqual(report["nominate_scores_checked"], 2)
        self.assertEqual(report["ethics_scores_cached"], 2)
        self.assertTrue(report["recent_bills_cached"])
        self.assertTrue(report["recent_bill_digest_cached"])
        self.assertEqual(report["errors"], [])
        self.assertGreaterEqual(stats["total_entries"], 6)

    def test_official_profile_returns_partial_data_when_wiki_is_missing(self):
        self.module.CongressMembersID = Mock(return_value={"member": {"directOrderName": "Missing Wiki"}})
        self.module.get_wiki_summary = Mock(side_effect=Exception("wiki missing"))
        self.module.get_nominate_score = Mock(return_value={"dim1": 0.2, "geo_mean": None})
        self.module.get_ethics_score = Mock(return_value={"score": 72.0, "grade": "C"})

        profile = self.module.get_official_profile("A000001")

        self.assertEqual(profile["bioguideId"], "A000001")
        self.assertEqual(profile["detail"], {"member": {"directOrderName": "Missing Wiki"}})
        self.assertIsNone(profile["wiki_summary"])
        self.assertEqual(profile["nominate_score"], {"dim1": 0.2, "geo_mean": None})
        self.assertEqual(profile["ethics_score"], {"score": 72.0, "grade": "C"})
        self.assertEqual(profile["errors"][0]["stage"], "wiki")


if __name__ == "__main__":
    unittest.main()
