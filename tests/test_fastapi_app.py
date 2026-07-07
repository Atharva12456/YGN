import importlib
import unittest
from unittest.mock import Mock, patch

import app as fastapi_app


class FastApiAppTests(unittest.TestCase):
    def setUp(self):
        self.app = importlib.reload(fastapi_app)

    def test_health_does_not_require_congress_api_key(self):
        with patch.dict(self.app.os.environ, {}, clear=True):
            response = self.app.health()

        self.assertEqual(response["status"], "ok")
        self.assertFalse(response["congress_api_key_configured"])
        self.assertFalse(response["congress_api_key_available"])

    def test_list_officials_uses_cached_backend_function(self):
        self.app.government.listCongressMembers = Mock(return_value={"members": []})

        response = self.app.list_officials()

        self.assertEqual(response, {"members": []})
        self.app.government.listCongressMembers.assert_called_once_with(
            limit=20,
            offset=0,
            congress=None,
            current_member=None,
        )

    def test_missing_api_key_maps_to_http_500(self):
        self.app.government.listCongressMembers = Mock(
            side_effect=self.app.government.MissingCongressApiKey("missing")
        )

        with self.assertRaises(self.app.HTTPException) as raised:
            self.app.list_officials()

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(raised.exception.detail, "Server is missing CONGRESS_API_KEY.")

    def test_search_official_returns_bioguide_id_shape(self):
        self.app.government.getMemberID = Mock(return_value="A000001")

        response = self.app.search_official("Example", chamber="house", congress=118)

        self.assertEqual(response, {"bioguideId": "A000001"})
        self.app.government.getMemberID.assert_called_once_with(
            "Example",
            chamber="house",
            congress=118,
        )

    def test_nominate_missing_score_maps_to_404(self):
        self.app.government.get_nominate_score = Mock(return_value=None)

        with self.assertRaises(self.app.HTTPException) as raised:
            self.app.official_nominate_score("A000001")

        self.assertEqual(raised.exception.status_code, 404)

    def test_profile_endpoint_uses_profile_backend(self):
        self.app.government.get_official_profile = Mock(return_value={"bioguideId": "A000001"})

        response = self.app.official_profile("A000001", include_wiki=False, include_nominate=True)

        self.assertEqual(response, {"bioguideId": "A000001"})
        self.app.government.get_official_profile.assert_called_once_with(
            "A000001",
            include_wiki=False,
            include_nominate=True,
            include_ethics=True,
        )

    def test_ethics_endpoint_uses_backend(self):
        self.app.government.get_ethics_score = Mock(return_value={"score": 72.0, "grade": "C"})

        response = self.app.official_ethics_score("A000001")

        self.assertEqual(response, {"score": 72.0, "grade": "C"})
        self.app.government.get_ethics_score.assert_called_once_with("A000001")

    def test_debt_metric_endpoint_uses_backend(self):
        self.app.government.get_national_debt_metric = Mock(
            return_value={"amount": "39375989952866.26"}
        )

        response = self.app.national_debt_metric()

        self.assertEqual(response, {"amount": "39375989952866.26"})
        self.app.government.get_national_debt_metric.assert_called_once_with()

    def test_recent_bill_digest_endpoint_uses_backend(self):
        self.app.government.getRecentBillDigest = Mock(return_value={"bills": []})

        response = self.app.recent_bill_digest(limit=5)

        self.assertEqual(response, {"bills": []})
        self.app.government.getRecentBillDigest.assert_called_once_with(limit=5)

    def test_warm_cache_endpoint_returns_report(self):
        self.app.government.warm_government_officials_cache = Mock(
            return_value={"members_seen": 2}
        )

        response = self.app.warm_cache(max_members=2)

        self.assertEqual(response, {"members_seen": 2})
        self.app.government.warm_government_officials_cache.assert_called_once_with(
            include_details=True,
            include_wiki=True,
            include_nominate=True,
            include_ethics=True,
            include_recent_bills=True,
            max_members=2,
            limit=250,
        )

    def test_cache_stats_endpoint_returns_stats(self):
        self.app.government.get_cache_stats = Mock(return_value={"total_entries": 3})

        response = self.app.cache_stats()

        self.assertEqual(response, {"total_entries": 3})
        self.app.government.get_cache_stats.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
