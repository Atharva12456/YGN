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
