"""Summarise component observations; these cases are not an accuracy benchmark."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = ROOT / "results/reproductions-0.2.24-host-0.2.1-rc.2.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT)
    args = parser.parse_args()
    report = json.loads(args.input.read_text(encoding="utf-8"))
    print("Guard:", report["guard"]["version"], "Host:", report["host"]["tools"])
    print("Component cases:", len(report["cases"]))
    for case in report["cases"]:
        print(case["case"], json.dumps(case["summary"], ensure_ascii=False))
    print("These are controlled failure/control traces, not population accuracy.")


if __name__ == "__main__":
    main()
