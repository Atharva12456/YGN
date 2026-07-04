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

    def test_list_officials_uses_cached_backend_function(self):
        self.app.government.allCongressMembers = Mock(return_value={"members": []})

        response = self.app.list_officials()

        self.assertEqual(response, {"members": []})
        self.app.government.allCongressMembers.assert_called_once_with()

    def test_missing_api_key_maps_to_http_500(self):
        self.app.government.allCongressMembers = Mock(
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


if __name__ == "__main__":
    unittest.main()
