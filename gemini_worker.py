"""Long-lived JSON-lines bridge from the Node server to gemini-gateway."""

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

from gemini_gateway import GeminiGateway


if not os.environ.get("GEMINI_API_KEYS", "").strip():
    os.environ.pop("GEMINI_API_KEYS", None)
gateway = GeminiGateway.from_env(load_dotenv_file=False)
output_lock = Lock()


def send(message):
    with output_lock:
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def translate(request, received_at):
    started_at = time.perf_counter()
    queue_ms = round((started_at - received_at) * 1000)
    try:
        result = gateway.generate_text_result(request["prompt"], max_output_tokens=400)
        send({
            "id": request["id"],
            "translation": result.text.strip(),
            "queueMs": queue_ms,
            "gatewayMs": round((time.perf_counter() - started_at) * 1000),
            "model": result.model,
            "keyLabel": result.api_key_label,
        })
    except Exception as exc:
        # Provider messages can contain request URLs or prompt fragments.
        print(f"Gemini translation failed: {type(exc).__name__}", file=sys.stderr)
        send({
            "id": request["id"],
            "error": "Ошибка перевода Gemini",
            "errorType": type(exc).__name__,
            "queueMs": queue_ms,
            "gatewayMs": round((time.perf_counter() - started_at) * 1000),
        })


send({"ready": True})
with ThreadPoolExecutor(max_workers=4) as pool:
    for line in sys.stdin:
        try:
            pool.submit(translate, json.loads(line), time.perf_counter())
        except (ValueError, KeyError):
            print("Invalid Gemini worker request", file=sys.stderr)
