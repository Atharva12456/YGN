import importlib
import unittest
from pathlib import Path
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

    def test_api_root_keeps_api_metadata(self):
        response = self.app.api_root()

        self.assertEqual(response["health"], "/health")
        self.assertEqual(response["docs"], "/docs")

    def test_frontend_index_serves_static_home(self):
        response = self.app.frontend_index()

        self.assertEqual(Path(response.path).name, "index.html")

    def test_frontend_config_uses_same_origin_api_by_default(self):
        response = self.app.frontend_config()

        self.assertIn("window.location.origin", response.body.decode())

    def test_frontend_file_serves_known_pages(self):
        response = self.app.frontend_file("recent-bills.html")

        self.assertEqual(Path(response.path).name, "recent-bills.html")

    def test_frontend_file_rejects_paths_outside_docs(self):
        with self.assertRaises(self.app.HTTPException) as raised:
            self.app.frontend_file("../app.py")

        self.assertEqual(raised.exception.status_code, 404)

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

        with patch.dict(
            self.app.os.environ, {"YGN_ADMIN_TOKEN": "test-admin-token"}
        ):
            response = self.app.warm_cache(
                max_members=2, admin_token="test-admin-token"
            )

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

    def test_cache_admin_endpoints_are_disabled_without_token_config(self):
        with patch.dict(self.app.os.environ, {}, clear=True):
            with self.assertRaises(self.app.HTTPException) as raised:
                self.app.refresh_cache(admin_token=None)

        self.assertEqual(raised.exception.status_code, 503)

    def test_refresh_cache_can_explicitly_drain_ai_for_an_admin(self):
        self.app.government.refresh_government_officials_cache = Mock(
            return_value={"aiRefresh": {"completed": 1}}
        )
        with patch.dict(
            self.app.os.environ, {"YGN_ADMIN_TOKEN": "test-admin-token"}
        ):
            response = self.app.refresh_cache(
                include_ai=True, admin_token="test-admin-token"
            )

        self.assertEqual(response["aiRefresh"]["completed"], 1)
        self.app.government.refresh_government_officials_cache.assert_called_once_with(
            include_ai=True
        )

    def test_ai_status_never_probes_the_model(self):
        config = {
            "kind": "openai",
            "url": "https://api.openai.com/v1/chat/completions",
            "model": "gpt-4o-mini",
        }
        with patch.object(
            self.app.government, "_ai_provider_config", return_value=config
        ), patch.object(
            self.app.government,
            "_llm_chat",
            side_effect=AssertionError("status must not call the model"),
        ):
            response = self.app.ai_status()

        self.assertTrue(response["configured"])
        self.assertFalse(response["probe_performed"])

    def test_cache_stats_endpoint_returns_stats(self):
        self.app.government.get_cache_stats = Mock(return_value={"total_entries": 3})

        response = self.app.cache_stats()

        self.assertEqual(response, {"total_entries": 3})
        self.app.government.get_cache_stats.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
