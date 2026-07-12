import unittest
from unittest.mock import patch

import app as fastapi_app


class MemberOverviewTests(unittest.TestCase):
    def setUp(self):
        self.gov = fastapi_app.government

    def test_get_member_overview_prefers_committed_snapshot(self):
        committed = {"summary": "Committed overview.", "source": "committed"}
        with patch.object(self.gov, "_static_member_overview", return_value=committed), \
             patch.object(self.gov, "_read_ai_result", side_effect=AssertionError("must not hit cache")), \
             patch.object(self.gov, "_llm_chat", side_effect=AssertionError("must not call model")):
            result = self.gov.get_member_overview("P000197")
        self.assertTrue(result["available"])
        self.assertEqual(result["overview"]["summary"], "Committed overview.")

    def test_get_member_overview_never_calls_model_on_miss(self):
        queued = {}
        with patch.object(self.gov, "_static_member_overview", return_value=None), \
             patch.object(self.gov, "_read_ai_result",
                          side_effect=lambda kind, cid, queue_payload=None: queued.update(
                              {"kind": kind, "id": cid, "payload": queue_payload}) or None), \
             patch.object(self.gov, "_llm_chat", side_effect=AssertionError("must not call model")):
            result = self.gov.get_member_overview("X0001")
        self.assertFalse(result["available"])
        self.assertEqual(queued["kind"], "member-overview")
        self.assertEqual(queued["payload"], {"bioguide_id": "X0001"})

    def test_member_ai_context_includes_role_and_committees(self):
        ctx = self.gov._member_ai_context({
            "bioguideId": "X0001",
            "name": "Jane Example",
            "party": "Independent",
            "state": "Vermont",
            "chamber": "Senate",
            "firstElectedYear": 2007,
            "yearsOfService": 19,
            "committees": ["Budget", "Veterans' Affairs"],
            "sponsoredCount": 412,
            "topPolicyAreas": ["Health"],
        })
        for expected in ("Jane Example", "Senate", "Vermont", "Budget", "412", "Health"):
            self.assertIn(expected, ctx)

    def test_refresh_worker_handles_member_jobs(self):
        # A queued member job must route to refresh_member_ai and clear on success.
        job_key = "job-key-1"
        job = {"kind": "member-overview", "cache_id": "X0001", "payload": {"bioguide_id": "X0001"}}
        deleted = []
        with patch.object(self.gov, "ai_insights_available", return_value=True), \
             patch.object(self.gov, "_pending_ai_refresh_jobs", return_value=[(job_key, job)]), \
             patch.object(self.gov, "refresh_member_ai",
                          return_value={"available": True, "overview": {"summary": "x"}}) as refreshed, \
             patch.object(self.gov, "_delete_cache_entry", side_effect=deleted.append):
            report = self.gov.refresh_ai_generation_cache(limit=1)
        refreshed.assert_called_once_with("X0001", force=True)
        self.assertEqual(report["completed"], 1)
        self.assertEqual(deleted, [job_key])

    def test_refresh_member_ai_requires_provider(self):
        with patch.object(self.gov, "ai_insights_available", return_value=False):
            result = self.gov.refresh_member_ai("X0001")
        self.assertFalse(result["available"])
        self.assertIn("provider", result["reason"].lower())


if __name__ == "__main__":
    unittest.main()
