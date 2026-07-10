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


class ConfidenceParsingTests(unittest.TestCase):
    def setUp(self):
        self.gov = fastapi_app.government

    def test_parse_confidence_json_handles_code_fence(self):
        raw = '```json\n{"confidence": 62, "label": "Moderate", "summary": "x", ' \
              '"support_factors": ["a", "b"], "concern_factors": ["c"], ' \
              '"confidence_in_estimate": "medium"}\n```'
        parsed = self.gov._parse_confidence_json(raw)
        self.assertEqual(parsed["confidence"], 62)
        self.assertEqual(parsed["label"], "Moderate")
        self.assertEqual(parsed["support_factors"], ["a", "b"])
        self.assertEqual(parsed["confidence_in_estimate"], "medium")

    def test_parse_confidence_json_clamps_and_extracts(self):
        raw = 'Sure! {"confidence": 140, "label": "High", "summary": "y"} hope that helps'
        parsed = self.gov._parse_confidence_json(raw)
        self.assertEqual(parsed["confidence"], 100)  # clamped to 0-100

    def test_confidence_disabled_returns_none(self):
        with mock.patch.object(self.gov, "_ai_provider_config", return_value=None):
            self.assertIsNone(self.gov.generate_event_confidence("Test war"))
            self.assertIsNone(self.gov.generate_candidate_confidence("A000001"))

    def test_next_gen_model_detection(self):
        f = self.gov._is_next_gen_model
        for m in ["gpt-5-mini", "gpt-5", "o1-mini", "o3", "o4-mini"]:
            self.assertTrue(f(m), m)
        for m in ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-35-turbo", "", None]:
            self.assertFalse(f(m), m)


if __name__ == "__main__":
    unittest.main()
