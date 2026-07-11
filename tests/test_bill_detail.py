import unittest
from unittest import mock

import app as fastapi_app


HOUSE_VOTE_XML = """<?xml version="1.0"?>
<rollcall-vote>
  <vote-metadata>
    <vote-question>On Passage</vote-question>
    <vote-result>Passed</vote-result>
    <vote-desc>A bill to do a thing</vote-desc>
    <action-date>3-Jan-2025</action-date>
    <action-time time-etz="12:00">12:00 PM</action-time>
  </vote-metadata>
  <vote-data>
    <recorded-vote><legislator name-id="A000370" party="D" state="NC" unaccented-name="Adams">Adams</legislator><vote>Yea</vote></recorded-vote>
    <recorded-vote><legislator name-id="A000055" party="R" state="AL" unaccented-name="Aderholt">Aderholt</legislator><vote>Nay</vote></recorded-vote>
    <recorded-vote><legislator name-id="A000371" party="D" state="CA" unaccented-name="Aguilar">Aguilar</legislator><vote>Not Voting</vote></recorded-vote>
    <recorded-vote><legislator name-id="B001302" party="R" state="IN" unaccented-name="Baird">Baird</legislator><vote>Present</vote></recorded-vote>
  </vote-data>
</rollcall-vote>"""

SENATE_VOTE_XML = """<?xml version="1.0"?>
<roll_call_vote>
  <vote_question_text>On the Cloture Motion</vote_question_text>
  <vote_result>Cloture Motion Agreed to</vote_result>
  <vote_title>Motion to Invoke Cloture</vote_title>
  <vote_date>January 1, 2025</vote_date>
  <members>
    <member><member_full>Baldwin (D-WI)</member_full><party>D</party><state>WI</state><lis_member_id>S354</lis_member_id><vote_cast>Yea</vote_cast></member>
    <member><member_full>Barrasso (R-WY)</member_full><party>R</party><state>WY</state><lis_member_id>S317</lis_member_id><vote_cast>Nay</vote_cast></member>
    <member><member_full>Bennet (D-CO)</member_full><party>D</party><state>CO</state><lis_member_id>S330</lis_member_id><vote_cast>Not Voting</vote_cast></member>
  </members>
</roll_call_vote>"""


class VoteParsingTests(unittest.TestCase):
    def setUp(self):
        self.gov = fastapi_app.government

    def test_house_vote_parses_positions_and_bioguide(self):
        q, result, desc, date, positions = self.gov._parse_house_vote_xml(HOUSE_VOTE_XML)
        self.assertEqual(q, "On Passage")
        self.assertEqual(result, "Passed")
        self.assertIn("3-Jan-2025", date)
        self.assertEqual(len(positions), 4)
        adams = positions[0]
        self.assertEqual(adams["bioguideId"], "A000370")
        self.assertEqual(adams["vote"], "Yea")
        tally = self.gov._tally_positions(positions)
        self.assertEqual(tally, {"Yea": 1, "Nay": 1, "Present": 1, "Not Voting": 1})

    def test_senate_vote_parses_positions(self):
        q, result, desc, date, positions = self.gov._parse_senate_vote_xml(SENATE_VOTE_XML)
        self.assertEqual(q, "On the Cloture Motion")
        self.assertEqual(len(positions), 3)
        self.assertEqual(positions[0]["name"], "Baldwin (D-WI)")
        self.assertEqual(positions[0]["vote"], "Yea")
        self.assertIsNone(positions[0]["bioguideId"])  # Senate XML has no bioguide

    def test_normalize_vote_position_maps_aliases(self):
        n = self.gov._normalize_vote_position
        self.assertEqual(n("Aye"), "Yea")
        self.assertEqual(n("No"), "Nay")
        self.assertEqual(n("Present"), "Present")
        self.assertEqual(n("Not Voting"), "Not Voting")
        self.assertEqual(n(""), "Not Voting")


class AiReadContractTests(unittest.TestCase):
    def setUp(self):
        self.gov = fastapi_app.government

    def test_event_confidence_is_deterministic_and_never_calls_model(self):
        with mock.patch.object(
            self.gov, "_llm_chat", side_effect=AssertionError("must not call AI")
        ):
            result = self.gov.get_event_confidence("Test event", context="Some context")

        self.assertFalse(result["available"])
        self.assertEqual(result["source"], "deterministic")
        self.assertEqual(result["subject"], "Test event")
        self.assertNotIn("confidence", result)

    def test_candidate_confidence_is_deterministic_and_never_calls_model(self):
        with mock.patch.object(
            self.gov, "_llm_chat", side_effect=AssertionError("must not call AI")
        ):
            result = self.gov.get_candidate_confidence("A000001")

        self.assertFalse(result["available"])
        self.assertEqual(result["source"], "deterministic")
        self.assertEqual(result["bioguideId"], "A000001")
        self.assertNotIn("confidence", result)

    def test_next_gen_model_detection(self):
        f = self.gov._is_next_gen_model
        for m in ["gpt-5-mini", "gpt-5", "o1-mini", "o3", "o4-mini"]:
            self.assertTrue(f(m), m)
        for m in ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-35-turbo", "", None]:
            self.assertFalse(f(m), m)

    def test_committed_bill_ai_served_without_provider(self):
        store = {"bills": {"119/hr/283": {
            "description": {"summary": "Committed description."},
            "impact": {"summary": "Committed impact."},
        }}}
        bill = {"congress": 119, "type": "HR", "number": "283"}
        with mock.patch.object(self.gov, "_static_bill_ai_store", return_value=store["bills"]), \
             mock.patch.object(self.gov, "_ai_provider_config", return_value=None), \
             mock.patch.object(self.gov, "_llm_chat", side_effect=AssertionError("must not call AI")):
            desc = self.gov.generate_bill_description(bill)
            impact = self.gov.generate_bill_impact(bill)
        self.assertEqual(desc["summary"], "Committed description.")
        self.assertEqual(desc["source"], "committed")
        self.assertEqual(impact["summary"], "Committed impact.")

    def test_bill_ai_identifier_is_scoped_to_congress(self):
        bill_118 = {"congress": 118, "type": "HR", "number": "1"}
        bill_119 = {"congress": 119, "type": "HR", "number": "1"}

        self.assertEqual(self.gov._bill_ai_identifier(bill_118), "118/hr/1")
        self.assertEqual(self.gov._bill_ai_identifier(bill_119), "119/hr/1")
        self.assertNotEqual(
            self.gov._bill_ai_identifier(bill_118),
            self.gov._bill_ai_identifier(bill_119),
        )

    def test_public_bill_ai_read_serves_cache_without_calling_model(self):
        seed = {
            "identifier": "H.R. 1",
            "congress": "119",
            "type": "hr",
            "number": "1",
            "description": {"text": "Official summary."},
        }

        def cached(_bill, field, *, queue_if_missing=False):
            self.assertTrue(queue_if_missing)
            return {
                "summary": f"Cached {field}.",
                "source": "refresh_cache",
            }

        with mock.patch.object(self.gov, "_load_bill_ai_seed", return_value=seed), \
             mock.patch.object(self.gov, "_cached_bill_ai_entry", side_effect=cached), \
             mock.patch.object(self.gov, "ai_insights_available", return_value=True), \
             mock.patch.object(self.gov, "_llm_chat", side_effect=AssertionError("must not call AI")), \
             mock.patch.object(
                 self.gov,
                 "generate_bill_description",
                 side_effect=AssertionError("must not generate on a read"),
             ), \
             mock.patch.object(
                 self.gov,
                 "generate_bill_impact",
                 side_effect=AssertionError("must not generate on a read"),
             ):
            result = self.gov.get_bill_ai("119", "hr", "1")

        self.assertTrue(result["available"])
        self.assertFalse(result["pending"])
        self.assertEqual(result["identifier"], "119/hr/1")
        self.assertEqual(result["aiDescription"]["summary"], "Cached description.")
        self.assertEqual(result["impact"]["summary"], "Cached impact.")

    def test_public_bill_detail_read_never_calls_model(self):
        detail = {
            "congress": 119,
            "type": "HR",
            "number": "1",
            "title": "Test Act",
            "policyArea": {"name": "Health"},
            "latestAction": {"text": "Introduced", "actionDate": "2025-01-03"},
        }

        def execute_fetch(_key, _source, fetcher, **_kwargs):
            return fetcher()

        with mock.patch.object(self.gov, "_cached_json", side_effect=execute_fetch), \
             mock.patch.object(self.gov, "_bill_detail_payload", return_value=detail), \
             mock.patch.object(self.gov, "_bill_summaries_payload", return_value=[]), \
             mock.patch.object(self.gov, "_bill_sponsor_items", return_value=[]), \
             mock.patch.object(self.gov, "_bill_cosponsor_items", return_value=[]), \
             mock.patch.object(self.gov, "_cached_bill_ai_entry", return_value=None), \
             mock.patch.object(self.gov, "ai_insights_available", return_value=True), \
             mock.patch.object(self.gov, "_llm_chat", side_effect=AssertionError("must not call AI")), \
             mock.patch.object(
                 self.gov,
                 "generate_bill_description",
                 side_effect=AssertionError("must not generate on a read"),
             ), \
             mock.patch.object(
                 self.gov,
                 "generate_bill_impact",
                 side_effect=AssertionError("must not generate on a read"),
             ):
            result = self.gov.get_bill_detail("119", "hr", "1", include_votes=False)

        self.assertEqual(result["ai_mode"], "cache_refresh_only")
        self.assertTrue(result["bill"]["aiPending"])

    def test_bill_ai_context_includes_bipartisanship(self):
        ctx = self.gov._bill_ai_context({
            "title": "Test Act",
            "sponsors": [{"name": "Rep. X", "party": "D", "state": "CA"}],
            "cosponsorCount": 5,
            "cosponsorParties": {"D": 3, "R": 2},
            "policyArea": "Health",
        })
        self.assertIn("bipartisan", ctx)
        self.assertIn("Lead sponsor", ctx)
        self.assertIn("Health", ctx)


if __name__ == "__main__":
    unittest.main()
