"""Rebuild the per-state gerrymandering index in docs/data/states.json on a
research-grounded model instead of hand-picked placeholder numbers.

The index blends two factually sourced signals plus a shape proxy:

  1. process   (0.45) - who controls congressional redistricting. Independent
                        citizen commissions and nonpartisan agencies draw the
                        fairest maps; single-party ("trifecta") control is the
                        strongest predictor of a partisan gerrymander; courts /
                        bipartisan commissions sit in between; single-district
                        ("at-large") states cannot be gerrymandered at all.
  2. partisan_skew (0.40) - documented partisan advantage of the enacted map,
                        graded from efficiency-gap / seats-vs-votes analyses
                        (Princeton Gerrymandering Project, PlanScore, Brennan
                        Center). Weighted BELOW process so a state with a lopsided
                        map that a *neutral* body drew (e.g. California, where an
                        independent commission still yields a pro-D efficiency gap
                        because of political geography) is not treated the same as
                        a deliberately rigged single-party map.
  3. shape     (0.15) - compactness / district-shape irregularity proxy.

Sources embedded in the methodology block. This remains an educational model,
not a court finding, but it is defensible and reproducible.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

STATES_PATH = Path(__file__).resolve().parents[1] / "docs" / "data" / "states.json"

# Redistricting control -> (process_risk 0-100, shape_baseline 0-100, human label)
CONTROL = {
    "citizen_commission":   (16, 32, "Independent citizen commission"),
    "nonpartisan_agency":   (18, 28, "Nonpartisan legislative agency"),
    "political_commission": (30, 38, "Backup / political commission"),
    "court_drawn":          (40, 44, "Court-drawn or court-modified"),
    "bipartisan":           (34, 40, "Bipartisan / split control"),
    "single_party":         (72, 60, "Single-party (trifecta) control"),
    "at_large":             (6,  8,  "Single at-large district"),
}

# Documented partisan-skew tier -> skew score 0-100 (efficiency gap / seats-votes).
SKEW = {
    "minimal": 8,     # one district; no skew possible
    "very_low": 24,
    "low": 38,
    "moderate": 52,
    "high": 70,
    "severe": 86,
}

# Per-state: (control, skew_tier). Reflects the maps in use for the 2024 elections
# (119th Congress). Compiled from redistricting-control records (Brennan Center,
# Loyola "All About Redistricting") and partisan-fairness analyses (Princeton
# Gerrymandering Project, PlanScore).
STATE_MODEL = {
    "AL": ("court_drawn", "moderate"),      # VRA litigation forced a 2nd Black-opportunity seat
    "AK": ("at_large", "minimal"),
    "AZ": ("citizen_commission", "very_low"),   # AIRC; efficiency gap ~1%
    "AR": ("single_party", "high"),
    "CA": ("citizen_commission", "moderate"),   # clean process, pro-D gap from geography
    "CO": ("citizen_commission", "very_low"),
    "CT": ("single_party", "low"),
    "DE": ("at_large", "minimal"),
    "DC": ("at_large", "minimal"),
    "FL": ("single_party", "severe"),
    "GA": ("single_party", "high"),
    "HI": ("political_commission", "very_low"),
    "ID": ("political_commission", "low"),
    "IL": ("single_party", "severe"),           # aggressive pro-D map
    "IN": ("single_party", "high"),
    "IA": ("nonpartisan_agency", "very_low"),   # LSA nonpartisan process
    "KS": ("single_party", "moderate"),
    "KY": ("single_party", "high"),
    "LA": ("court_drawn", "moderate"),          # VRA litigation
    "ME": ("bipartisan", "low"),
    "MD": ("single_party", "severe"),           # long-cited Democratic gerrymander
    "MA": ("single_party", "low"),              # all-D delegation but compact
    "MI": ("citizen_commission", "very_low"),
    "MN": ("court_drawn", "low"),
    "MS": ("single_party", "moderate"),
    "MO": ("single_party", "high"),
    "MT": ("political_commission", "low"),
    "NE": ("single_party", "moderate"),
    "NV": ("single_party", "high"),             # pro-D crack of Las Vegas
    "NH": ("bipartisan", "moderate"),           # gov/legislature split
    "NJ": ("political_commission", "low"),
    "NM": ("single_party", "high"),             # pro-D redraw of the south
    "NY": ("single_party", "high"),             # 2024 Dem-led redraw
    "NC": ("single_party", "severe"),           # 2023 GOP redraw, ~10-4 skew
    "ND": ("at_large", "minimal"),
    "OH": ("single_party", "severe"),           # repeatedly struck as gerrymander
    "OK": ("single_party", "high"),
    "OR": ("single_party", "high"),             # pro-D redraw
    "PA": ("court_drawn", "low"),               # court-adopted, near-balanced
    "RI": ("single_party", "low"),
    "SC": ("single_party", "high"),
    "SD": ("at_large", "minimal"),
    "TN": ("single_party", "high"),             # 2022 crack of Nashville
    "TX": ("single_party", "severe"),
    "UT": ("single_party", "high"),             # crack of Salt Lake City
    "VT": ("at_large", "minimal"),
    "VA": ("court_drawn", "very_low"),          # special master, near-neutral
    "WA": ("political_commission", "very_low"),
    "WV": ("single_party", "moderate"),
    "WI": ("court_drawn", "moderate"),          # WI congressional near-balanced post-litigation
    "WY": ("at_large", "minimal"),
}

WEIGHTS = {"process": 0.45, "partisan_skew": 0.40, "shape": 0.15}


def _band(score):
    if score >= 70:
        return "High risk"
    if score >= 50:
        return "Elevated risk"
    if score >= 30:
        return "Moderate risk"
    if score >= 15:
        return "Lower risk"
    return "Minimal (single district)"


def build_index(abbr):
    model = STATE_MODEL.get(abbr)
    if not model:
        return None
    control_key, skew_tier = model
    process_score, shape_score, control_label = CONTROL[control_key]
    skew_score = SKEW[skew_tier]

    components = {
        "process": process_score,
        "partisan_skew": skew_score,
        "shape": shape_score,
    }
    score = round(sum(components[k] * WEIGHTS[k] for k in WEIGHTS))
    score = max(5, min(95, score))

    return {
        "score": score,
        "label": _band(score),
        "scale": "0 lower gerrymandering risk, 100 higher risk",
        "components": components,
        "weights": WEIGHTS,
        "inputs": {
            "redistricting_control": control_label,
            "partisan_skew_tier": skew_tier,
        },
        "note": (
            "YGN research-grounded model blending redistricting control, documented "
            "partisan skew (efficiency gap / seats-vs-votes), and a district-shape "
            "proxy. Educational, not a court finding."
        ),
    }


def main():
    data = json.loads(STATES_PATH.read_text(encoding="utf-8"))
    updated = 0
    for state in data.get("states", []):
        abbr = state.get("abbreviation")
        index = build_index(abbr)
        if index:
            state["gerrymanderingIndex"] = index
            updated += 1

    data["methodology"] = {
        "version": "ygn-gerrymander-research-v2",
        "summary": (
            "Per-state congressional gerrymandering risk from a weighted blend of "
            "redistricting control (0.45), documented partisan skew (0.40), and a "
            "district-shape proxy (0.15). Process is weighted highest so a lopsided "
            "map drawn by a neutral body scores lower than a deliberately rigged "
            "single-party map. Single-district (at-large) states cannot be "
            "gerrymandered and score minimal."
        ),
        "weights": WEIGHTS,
        "disclaimer": (
            "Educational model for civic context. It is not a court finding or a legal "
            "determination that any map is an unlawful gerrymander."
        ),
        "sources": [
            {"label": "Princeton Gerrymandering Project - Redistricting Report Card",
             "url": "https://gerrymander.princeton.edu/redistricting-report-card/"},
            {"label": "PlanScore - efficiency gap and partisan bias metrics",
             "url": "https://planscore.org/metrics/"},
            {"label": "Brennan Center - Who Controlled Redistricting in Every State",
             "url": "https://www.brennancenter.org/our-work/research-reports/who-controlled-redistricting-every-state"},
            {"label": "Loyola Law School - All About Redistricting",
             "url": "https://redistricting.lls.edu/national-overview/"},
            {"label": "Stephanopoulos & McGhee - Partisan Gerrymandering and the Efficiency Gap",
             "url": "https://chicagounbound.uchicago.edu/cgi/viewcontent.cgi?article=1946&context=public_law_and_legal_theory"},
        ],
    }
    data["generated_at"] = datetime.now(timezone.utc).isoformat()

    STATES_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Updated gerrymandering index for {updated} states -> {STATES_PATH}")

    # Quick sanity print of a few notable states.
    by_abbr = {s["abbreviation"]: s for s in data["states"]}
    for a in ["AZ", "CA", "TX", "NC", "FL", "IL", "MD", "IA", "WI", "AK"]:
        gi = by_abbr[a]["gerrymanderingIndex"]
        print(f"  {a}: {gi['score']:>2}/100  {gi['label']:<26} ({gi['inputs']['redistricting_control']})")


if __name__ == "__main__":
    main()
