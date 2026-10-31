"""Read the official model catalogue using a local environment variable."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    key = os.environ.get("DEEPSEEK_API_KEY", "")
    result = {"endpoint": "https://api.deepseek.com/models", "method": "GET"}
    if not key:
        result["status"] = "missing_environment_variable"
    else:
        request = urllib.request.Request(result["endpoint"], headers={
            "Authorization": "Bearer " + key,
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.load(response)
                result.update(status="ok", http_status=response.status,
                              model_ids=[x["id"] for x in payload.get("data", [])])
        except urllib.error.HTTPError as error:
            result.update(status="http_error", http_status=error.code)
        except Exception as error:
            result.update(status="connection_error", error_type=type(error).__name__)
    target = ROOT / "results/environment/deepseek-models.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
