import argparse
import importlib.util
import json
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_PATH = PROJECT_ROOT / "empty-folder" / "CongressMembers.py"


def load_backend():
    spec = importlib.util.spec_from_file_location("ygn_government_backend", BACKEND_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load backend module at {BACKEND_PATH}.")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args():
    parser = argparse.ArgumentParser(description="Warm the YGN government officials cache.")
    parser.add_argument("--max-members", type=int, default=None)
    parser.add_argument("--limit", type=int, default=250)
    parser.add_argument("--skip-details", action="store_true")
    parser.add_argument("--skip-wiki", action="store_true")
    parser.add_argument("--skip-nominate", action="store_true")
    parser.add_argument("--skip-recent-bills", action="store_true")
    parser.add_argument("--stats", action="store_true", help="Print cache stats after warming.")
    return parser.parse_args()


def main():
    args = parse_args()
    backend = load_backend()

    try:
        report = backend.warm_government_officials_cache(
            include_details=not args.skip_details,
            include_wiki=not args.skip_wiki,
            include_nominate=not args.skip_nominate,
            include_recent_bills=not args.skip_recent_bills,
            max_members=args.max_members,
            limit=args.limit,
        )
    except backend.MissingCongressApiKey as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except backend.UpstreamDataError as exc:
        print(str(exc), file=sys.stderr)
        return 3

    output = {"warm_cache": report}
    if args.stats:
        output["cache_stats"] = backend.get_cache_stats()

    print(json.dumps(output, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
