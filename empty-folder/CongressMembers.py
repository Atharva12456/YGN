import requests
import csv
from pathlib import Path

API_KEY = "RNCdgTenkNjuA20Q45IjjWbQhbxrkrIBjSDByN4K"
BASE_URL = "https://api.congress.gov/v3"
CSV_PATH = Path(__file__).parent / "HSall_members.csv"

def getRecentBills():
    r = requests.get(
        f"{BASE_URL}/bill",
        params={
            "api_key": API_KEY,
            "limit": 20,
            "format": "json"
        }
    )
    return r.json()

def allCongressMembers():
    r = requests.get(
        f"{BASE_URL}/member",
        params={
            "api_key": API_KEY,
            "limit": 20,
            "format": "json"
        }
    )
    return r.json()

def CongressMembersID(bioGuideID):
    r = requests.get(
        f"{BASE_URL}/member/{bioGuideID}",
        params={
            "api_key": API_KEY,
            "limit": 20,
            "bioguideId": bioGuideID,
            "format": "json"
        }
    )
    return r.json()

def getMemberID(Name, chamber=None, congress=None):
    """
    Look up a member of Congress's bioguideId by name. (last, first) or (last) works

    Args:
        Name (str): Full or partial name to search for (e.g. "Pelosi").
        chamber (str, optional): "house" or "senate" to narrow results.
        congress (int, optional): Congress number (e.g. 118) to narrow results.

    Returns:
        list of dict: Matching members with bioguideId, name, party, state.
                       Empty list if nothing found.
    """
    matches = []
    offset = 0
    limit = 250  # max page size allowed by the API
    name_lower = Name.lower()

    while True:
        r = requests.get(
            f"{BASE_URL}/member",
            params={
                "api_key": API_KEY,
                "limit": limit,
                "offset": offset,
                "format": "json"
            }
        )
        data = r.json()

        members = data.get("members", [])
        if not members:
            break

        for m in members:
            full_name = m.get("name", "")
            if name_lower in full_name.lower():
                terms = m.get("terms", {}).get("item", [])

                if congress is not None:
                    if not any(t.get("congress") == congress for t in terms):
                        continue

                if chamber is not None:
                    if not any(chamber.lower() in t.get("chamber", "").lower() for t in terms):
                        continue

                matches.append({
                    "bioguideId": m.get("bioguideId"),
                    "name": full_name,
                    "party": m.get("partyName"),
                    "state": m.get("state"),
                })

        offset += limit
        if offset >= data.get("pagination", {}).get("count", 0):
            break

## if this comes back to bite us in the ___ delete this
    return matches[0].get("bioguideId")

def get_nominate_score(bioguide_id: str):
    """
    Returns a member's most recent NOMINATE dim1 score and geo mean probability
    by scanning the CSV directly. No database needed.

    Returns {"dim1": float, "geo_mean": float} or None if not found.
    """
    best_row = None

    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["bioguide_id"] != bioguide_id:
                continue
            # keep the row from the highest (most recent) congress
            if best_row is None or int(row["congress"]) > int(best_row["congress"]):
                best_row = row

    if best_row is None or not best_row["nominate_dim1"]:
        return None

    return {
        "dim1": float(best_row["nominate_dim1"]),
        "geo_mean": float(best_row["nominate_geo_mean_probability"]),
    }

def get_wiki_summary(bioguideId):
    name=CongressMembersID(bioguideId).get("member").get("directOrderName")
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{name}"
    headers = {"User-Agent": "YourAppName/1.0 (your-email@example.com)"}
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    data = resp.json()
    return {
        "title": data.get("title"),
        "extract": data.get("extract"),
        "thumbnail": data.get("thumbnail", {}).get("source"),
        "wiki_url": data.get("content_urls", {}).get("desktop", {}).get("page")
    }