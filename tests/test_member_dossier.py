import os
import shutil
import tempfile
import unittest
from unittest.mock import Mock, patch

import app as fastapi_app


class MemberDossierBackendTests(unittest.TestCase):
    def setUp(self):
        self.gov = fastapi_app.government
        self._tmp = tempfile.mkdtemp()
        os.environ["YGN_CACHE_PATH"] = os.path.join(self._tmp, "cache.sqlite")

    def tearDown(self):
        os.environ.pop("YGN_CACHE_PATH", None)
        shutil.rmtree(self._tmp, ignore_errors=True)

    # --- state-code normalization (regression for the FEC matching bug) ---

    def test_member_state_code_converts_full_name_to_usps(self):
        self.assertEqual(self.gov._member_state_code({"state": "Vermont"}), "VT")
        self.assertEqual(self.gov._member_state_code({"state": "New York"}), "NY")

    def test_member_state_code_passes_through_two_letter_code(self):
        self.assertEqual(self.gov._member_state_code({"stateCode": "ca"}), "CA")
        self.assertEqual(self.gov._member_state_code({"state": "TX"}), "TX")

    def test_member_state_code_returns_none_for_unknown(self):
        self.assertIsNone(self.gov._member_state_code({"state": "Neverland"}))

    def test_fec_search_uses_usps_state_code(self):
        captured = {}

        def fake_fec_get(path, params=None, ttl_seconds=None):
            captured["params"] = params
            return {"results": []}

        member = {
            "state": "Vermont",
            "directOrderName": "Bernard Sanders",
            "terms": {"item": [{"chamber": "Senate", "startYear": "2007"}]},
        }
        with patch.object(self.gov, "_fec_get", side_effect=fake_fec_get):
            self.gov._fec_search_candidates(member)

        self.assertEqual(captured["params"]["state"], "VT")

    def test_precomputed_ethics_only_accepts_fec_live(self):
        with patch.object(self.gov, "_read_json_file", return_value={"grade": "A", "source": "fec_live"}):
            self.assertIsNotNone(self.gov._precomputed_fec_ethics("X"))
        with patch.object(self.gov, "_read_json_file", return_value={"grade": "A", "source": "static_fallback"}):
            self.assertIsNone(self.gov._precomputed_fec_ethics("X"))
        with patch.object(self.gov, "_read_json_file", return_value=None):
            self.assertIsNone(self.gov._precomputed_fec_ethics("X"))

    def test_get_ethics_prefers_precomputed_snapshot(self):
        with patch.object(self.gov, "_precomputed_fec_ethics",
                          return_value={"grade": "A", "source": "fec_live"}), patch.object(
            self.gov, "compute_ethics_score", side_effect=AssertionError("must not recompute")
        ):
            self.assertEqual(self.gov.get_ethics_score("X0001")["grade"], "A")

    def test_get_ethics_computes_when_no_snapshot(self):
        with patch.object(self.gov, "_precomputed_fec_ethics", return_value=None), patch.object(
            self.gov, "compute_ethics_score", return_value={"grade": "B", "source": "fec_live"}
        ):
            self.assertEqual(self.gov.get_ethics_score("X0001")["grade"], "B")

    def test_cached_json_dynamic_ttl_depends_on_result(self):
        captured = {}
        with patch.object(self.gov, "_read_cache", return_value=None), patch.object(
            self.gov, "_write_cache",
            side_effect=lambda k, v, s, ttl_seconds=None: captured.update({"ttl": ttl_seconds}),
        ):
            ttl_for = (lambda r: self.gov.FEC_LIVE_CACHE_TTL_SECONDS
                       if r.get("source") == "fec_live" else 900)
            self.gov._cached_json_dynamic("k1", "src", lambda: {"source": "fec_live"}, ttl_for)
            self.assertEqual(captured["ttl"], self.gov.FEC_LIVE_CACHE_TTL_SECONDS)
            self.gov._cached_json_dynamic("k2", "src", lambda: {"source": "static_fallback"}, ttl_for)
            self.assertEqual(captured["ttl"], 900)

    # --- committees (extra feature) ---------------------------------------

    def test_committees_map_full_and_subcommittee_assignments(self):
        datasets = {
            "committee-membership-current.yaml": {
                "SSAF": [
                    {"bioguide": "X0001", "title": "Chairman", "rank": 1, "party": "majority"}
                ],
                "SSAF15": [{"bioguide": "X0001", "rank": 2, "party": "majority"}],
            },
            "committees-current.yaml": [
                {
                    "thomas_id": "SSAF",
                    "name": "Agriculture Committee",
                    "type": "senate",
                    "subcommittees": [{"thomas_id": "15", "name": "Nutrition Subcommittee"}],
                }
            ],
        }
        with patch.object(self.gov, "_unitedstates_dataset", side_effect=lambda f, **k: datasets[f]):
            result = self.gov.get_member_committees("X0001")

        self.assertEqual(result["count"], 2)
        self.assertEqual(result["leadershipCount"], 1)
        first = result["assignments"][0]
        self.assertEqual(first["committee"], "Agriculture Committee")
        self.assertEqual(first["role"], "Chairman")
        self.assertFalse(first["isSubcommittee"])
        sub = next(a for a in result["assignments"] if a["isSubcommittee"])
        self.assertEqual(sub["subcommittee"], "Nutrition Subcommittee")

    # --- legislation ------------------------------------------------------

    def test_legislation_parses_items_and_counts(self):
        def fake_congress_get(path, params=None, ttl_seconds=None):
            if "cosponsored" in path:
                return {"pagination": {"count": 7}, "cosponsoredLegislation": []}
            if "sponsored" in path:
                return {
                    "pagination": {"count": 42},
                    "sponsoredLegislation": [
                        {
                            "congress": 118,
                            "type": "HR",
                            "number": "1",
                            "title": "A bill",
                            "introducedDate": "2023-01-01",
                            "policyArea": {"name": "Taxation"},
                            "latestAction": {
                                "text": "Became Public Law No: 118-1.",
                                "actionDate": "2023-02-01",
                            },
                        }
                    ],
                }
            return {"pagination": {"count": 0}, "cosponsoredLegislation": []}

        with patch.object(self.gov, "_congress_get", side_effect=fake_congress_get):
            result = self.gov.get_member_legislation("X0001", limit=5)

        self.assertEqual(result["sponsoredCount"], 42)
        self.assertEqual(result["cosponsoredCount"], 7)
        self.assertEqual(result["enactedShown"], 1)
        item = result["sponsored"][0]
        self.assertTrue(item["becameLaw"])
        self.assertEqual(
            item["url"], "https://www.congress.gov/bill/118th-congress/house-bill/1"
        )

    def test_legislation_labels_amendments(self):
        item = self.gov._legislation_item(
            {
                "amendmentNumber": "6349",
                "congress": 119,
                "introducedDate": "2026-06-24",
                "latestAction": None,
                "type": None,
                "url": "https://api.congress.gov/v3/amendment/119/samdt/6349?format=json",
            }
        )
        self.assertTrue(item["isAmendment"])
        self.assertEqual(item["type"], "S.Amdt.")
        self.assertEqual(item["number"], "6349")
        self.assertIn("Senate Amendment 6349", item["title"])
        self.assertIn("senate-amendment/6349", item["url"])

    # --- funding ----------------------------------------------------------

    def test_funding_reports_unavailable_when_no_candidate(self):
        with patch.object(self.gov, "CongressMembersID", return_value={"member": {}}), patch.object(
            self.gov, "_fec_best_candidate", return_value=None
        ):
            result = self.gov.get_funding_summary("X0001")

        self.assertFalse(result["available"])
        self.assertIn("No matching FEC", result["note"])

    def test_funding_degrades_gracefully_on_fec_error(self):
        with patch.object(self.gov, "CongressMembersID", return_value={"member": {}}), patch.object(
            self.gov, "_fec_best_candidate", side_effect=self.gov.UpstreamDataError("boom")
        ):
            result = self.gov.get_funding_summary("X0001")

        self.assertFalse(result["available"])
        self.assertIn("temporarily unavailable", result["note"])

    def test_funding_builds_breakdown_and_reuses_grade(self):
        totals = {
            "receipts": 1000,
            "contributions": 800,
            "individual_contributions": 700,
            "individual_itemized_contributions": 500,
            "individual_unitemized_contributions": 200,
            "other_political_committee_contributions": 100,
            "disbursements": 900,
            "last_cash_on_hand_end_period": 100,
            "cycle": 2024,
        }
        candidate = {"candidate_id": "S1", "name": "X", "office": "S", "state": "VT"}
        with patch.object(self.gov, "CongressMembersID", return_value={"member": {}}), patch.object(
            self.gov, "_fec_best_candidate", return_value=candidate
        ), patch.object(self.gov, "_latest_candidate_total", return_value=totals), patch.object(
            self.gov, "get_ethics_score", return_value={"grade": "A", "score": 95}
        ):
            result = self.gov.get_funding_summary("X0001")

        self.assertTrue(result["available"])
        self.assertEqual(result["totals"]["receipts"], 1000.0)
        self.assertEqual(result["totals"]["cashOnHand"], 100.0)
        labels = [line["label"] for line in result["breakdown"]]
        self.assertIn("Small individual (unitemized)", labels)
        self.assertEqual(result["grade"]["grade"], "A")

    # --- stocks -----------------------------------------------------------

    def test_stocks_house_returns_disclosure_filings(self):
        rows = [
            {
                "Last": "Smith",
                "First": "Jo",
                "FilingType": "P",
                "DocID": "20001",
                "Year": "2026",
                "FilingDate": "6/1/2026",
                "StateDst": "CA01",
            }
        ]
        member = {
            "member": {
                "lastName": "Smith",
                "firstName": "Jo",
                "terms": {"item": [{"chamber": "House of Representatives", "startYear": "2021"}]},
            }
        }

        def fake_index(year):
            return rows if year == self.gov._current_year() else []

        with patch.object(self.gov, "CongressMembersID", return_value=member), patch.object(
            self.gov, "_house_disclosure_index", side_effect=fake_index
        ):
            result = self.gov.get_member_stock_activity("X0001")

        self.assertTrue(result["available"])
        self.assertEqual(result["provider"], "house_clerk")
        self.assertEqual(result["chamber"], "house")
        self.assertTrue(result["filings"][0]["isStockReport"])
        self.assertIn("ptr-pdfs", result["filings"][0]["pdfUrl"])

    def test_house_disclosure_filings_filter_by_state(self):
        # Two different reps named "Smith" in different states; only CA should match.
        rows = [
            {"Last": "Smith", "First": "Jo", "FilingType": "P", "DocID": "1",
             "Year": "2026", "FilingDate": "6/1/2026", "StateDst": "CA11"},
            {"Last": "Smith", "First": "Jo", "FilingType": "P", "DocID": "2",
             "Year": "2026", "FilingDate": "6/2/2026", "StateDst": "TX05"},
        ]
        with patch.object(
            self.gov, "_house_disclosure_index",
            side_effect=lambda y: rows if y == self.gov._current_year() else [],
        ):
            filings = self.gov._house_disclosure_filings("Smith", "Jo", "CA")
        self.assertEqual(len(filings), 1)
        self.assertEqual(filings[0]["stateDistrict"], "CA11")

    def test_nominate_index_is_used_for_lookup(self):
        fake_index = {"X0001": {"congress": 118, "nominate_dim1": "-0.42",
                                "nominate_geo_mean_probability": "0.9"}}
        with patch.object(self.gov, "_load_nominate_index", return_value=fake_index):
            self.assertEqual(self.gov.get_nominate_score("X0001")["dim1"], -0.42)
            self.assertIsNone(self.gov.get_nominate_score("NOPE"))

    def test_stocks_senate_links_to_efd_search(self):
        member = {
            "member": {
                "lastName": "Doe",
                "firstName": "J",
                "terms": {"item": [{"chamber": "Senate", "startYear": "2019"}]},
            }
        }
        with patch.object(self.gov, "CongressMembersID", return_value=member):
            result = self.gov.get_member_stock_activity("X0002")

        self.assertEqual(result["chamber"], "senate")
        self.assertEqual(result["senateSearchUrl"], self.gov.SENATE_EFD_SEARCH_URL)

    # --- dossier aggregation ----------------------------------------------

    def test_dossier_collects_sections_and_captures_errors(self):
        with patch.object(
            self.gov, "CongressMembersID", return_value={"member": {"directOrderName": "X"}}
        ), patch.object(self.gov, "get_member_wiki_full", return_value={"title": "X"}), patch.object(
            self.gov, "get_nominate_score", return_value={"dim1": 0.1}
        ), patch.object(self.gov, "get_ethics_score", return_value={"grade": "A"}), patch.object(
            self.gov, "get_funding_summary", side_effect=RuntimeError("fec down")
        ), patch.object(self.gov, "get_member_committees", return_value={"count": 0}), patch.object(
            self.gov, "get_member_contact", return_value={}
        ), patch.object(self.gov, "get_member_history", return_value={}), patch.object(
            self.gov, "get_member_legislation", return_value={}
        ), patch.object(self.gov, "get_member_stock_activity", return_value={}):
            result = self.gov.get_member_dossier("X0001")

        self.assertEqual(result["wiki"]["title"], "X")
        self.assertIsNone(result["funding"])
        self.assertTrue(any(e["stage"] == "funding" for e in result["errors"]))


class AiInsightsTests(unittest.TestCase):
    def setUp(self):
        self.gov = fastapi_app.government
        self._tmp = tempfile.mkdtemp()
        os.environ["YGN_CACHE_PATH"] = os.path.join(self._tmp, "cache.sqlite")

    def tearDown(self):
        os.environ.pop("YGN_CACHE_PATH", None)
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_provider_config_prefers_azure(self):
        env = {
            "AZURE_OPENAI_ENDPOINT": "https://myres.openai.azure.com",
            "AZURE_OPENAI_API_KEY": "k",
            "AZURE_OPENAI_DEPLOYMENT": "gpt-4o-mini",
        }
        with patch.dict(os.environ, env, clear=False):
            cfg = self.gov._ai_provider_config()
        self.assertEqual(cfg["kind"], "azure")
        self.assertIn("/openai/deployments/gpt-4o-mini/chat/completions", cfg["url"])

    def test_provider_config_openai_fallback(self):
        env = {"OPENAI_API_KEY": "sk-x", "OPENAI_MODEL": "gpt-4o-mini"}
        # Ensure Azure vars are absent so the OpenAI branch is taken.
        with patch.dict(os.environ, env, clear=False):
            os.environ.pop("AZURE_OPENAI_ENDPOINT", None)
            os.environ.pop("AZURE_OPENAI_API_KEY", None)
            cfg = self.gov._ai_provider_config()
        self.assertEqual(cfg["kind"], "openai")

    def test_bill_impact_none_and_unavailable_without_provider(self):
        with patch.object(self.gov, "_ai_provider_config", return_value=None):
            self.assertFalse(self.gov.ai_insights_available())
            self.assertIsNone(self.gov.generate_bill_impact({"identifier": "x"}))

    def test_generate_bill_impact_uses_llm(self):
        cfg = {"kind": "azure", "url": "http://x", "key": "k", "model": "gpt-4o-mini", "api_version": "v"}
        with patch.object(self.gov, "_ai_provider_config", return_value=cfg), patch.object(
            self.gov, "_llm_chat", return_value="This bill funds X and affects Y."
        ):
            result = self.gov.generate_bill_impact(
                {"identifier": "hr-1-119", "title": "A bill",
                 "description": {"text": "..."}, "policyArea": "Health",
                 "committees": ["Ways and Means"], "latestAction": {"text": "Referred"}}
            )
        self.assertEqual(result["summary"], "This bill funds X and affects Y.")
        self.assertEqual(result["provider"], "azure")

    def test_digest_enriches_impact_when_ai_available(self):
        with patch.object(self.gov, "getRecentBills", return_value={"bills": [{"x": 1}]}), patch.object(
            self.gov, "_bill_digest_item",
            side_effect=lambda b: {"identifier": "hr-1",
                                   "impact": {"status": "Pending AI impact analysis",
                                              "summary": "placeholder", "sources": []}},
        ), patch.object(self.gov, "ai_insights_available", return_value=True), patch.object(
            self.gov, "generate_bill_impact",
            return_value={"status": "AI impact analysis", "summary": "Affects taxpayers.",
                          "model": "gpt-4o-mini", "generated_at": "now"},
        ):
            digest = self.gov.getRecentBillDigest(limit=1)
        self.assertEqual(digest["impact_status"], "ai")
        self.assertEqual(digest["bills"][0]["impact"]["summary"], "Affects taxpayers.")
        self.assertEqual(digest["bills"][0]["impact"]["status"], "AI impact analysis")


class EconomySnapshotTests(unittest.TestCase):
    def setUp(self):
        self.gov = fastapi_app.government

    def test_snapshot_aggregates_and_derives(self):
        with patch.object(self.gov, "get_national_debt_metric",
                          return_value={"amount": "1000", "record_date": "2026-01-01"}), patch.object(
            self.gov, "_treasury_debt_history", return_value={"points": []}
        ), patch.object(
            self.gov, "_worldbank_indicator",
            side_effect=lambda ind: {"NY.GDP.MKTP.CD": {"value": 500.0, "date": "2025"},
                                     "SP.POP.TOTL": {"value": 100.0, "date": "2025"}}[ind]
        ), patch.object(self.gov, "_bls_latest_value", return_value={"value": 4.2}), patch.object(
            self.gov, "_bls_inflation", return_value={"value": 3.9}
        ):
            snap = self.gov.get_economy_snapshot()
        m = snap["metrics"]
        self.assertEqual(snap["errors"], [])
        self.assertEqual(m["debt_to_gdp"]["value"], 200.0)   # 1000/500*100
        self.assertEqual(m["debt_per_capita"]["value"], 10.0)  # 1000/100

    def test_snapshot_degrades_per_metric(self):
        with patch.object(self.gov, "get_national_debt_metric", side_effect=RuntimeError("treasury down")), patch.object(
            self.gov, "_treasury_debt_history", return_value={"points": []}
        ), patch.object(
            self.gov, "_worldbank_indicator", return_value={"value": 500.0, "date": "2025"}
        ), patch.object(self.gov, "_bls_latest_value", return_value={"value": 4.2}), patch.object(
            self.gov, "_bls_inflation", return_value={"value": 3.9}
        ):
            snap = self.gov.get_economy_snapshot()
        self.assertIsNone(snap["metrics"]["debt"])
        self.assertTrue(any(e["metric"] == "debt" for e in snap["errors"]))
        self.assertIsNotNone(snap["metrics"]["gdp"])  # other metrics still populate
        self.assertNotIn("debt_to_gdp", snap["metrics"])  # derived skipped when debt missing


class MemberDossierRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = fastapi_app

    def test_dossier_route_delegates_to_backend(self):
        self.app.government.get_member_dossier = Mock(return_value={"bioguideId": "X"})
        response = self.app.official_dossier("X")
        self.assertEqual(response["bioguideId"], "X")

    def test_wiki_route_supports_full_flag(self):
        self.app.government.get_member_wiki_full = Mock(return_value={"full": True})
        self.app.government.get_wiki_summary = Mock(return_value={"full": False})

        self.assertEqual(self.app.official_wiki_summary("X", full=True), {"full": True})
        self.assertEqual(self.app.official_wiki_summary("X", full=False), {"full": False})

    def test_funding_route_delegates_to_backend(self):
        self.app.government.get_funding_summary = Mock(return_value={"available": True})
        response = self.app.official_funding("X")
        self.assertTrue(response["available"])

    def test_health_reports_stock_key_availability(self):
        response = self.app.health()
        self.assertIn("stock_api_key_available", response)


if __name__ == "__main__":
    unittest.main()
