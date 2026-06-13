#!/usr/bin/env python3
"""
Hindsight embedded dev server (no Docker).

Starts the Hindsight semantic-memory server in-process (bundled pg0 Postgres +
pgvector) so Natively's HindsightClientAdapter can retain/recall against a real
backend locally. Dev-only — production hosting (spawn-from-Electron / Cloud) is a
separate decision.

Usage:
    GEMINI_API_KEY=... python3 scripts/hindsight-dev-server.py
    # optional overrides:
    HINDSIGHT_PORT=8888 HINDSIGHT_LLM_MODEL=gemini-2.5-flash python3 scripts/hindsight-dev-server.py

Then point Natively at it:
    HINDSIGHT_BASE_URL=http://localhost:8888

Requires:  pip install hindsight-all -U   (Python 3.11+)
"""
import os
import sys
import signal
import time

PORT = int(os.environ.get("HINDSIGHT_PORT", "8888"))

# Provider + key. Gemini is supported by the Hindsight server; the app already has
# GEMINI_API_KEY. Fall back to other common keys if a different provider is preferred.
PROVIDER = os.environ.get("HINDSIGHT_LLM_PROVIDER", "gemini")
API_KEY = (
    os.environ.get("HINDSIGHT_API_LLM_API_KEY")
    or os.environ.get("GEMINI_API_KEY")
    or os.environ.get("GOOGLE_API_KEY")
    or os.environ.get("OPENAI_API_KEY")
)
# A sensible default Gemini model; override via HINDSIGHT_LLM_MODEL if the server
# rejects it (the smoke test will surface that).
MODEL = os.environ.get("HINDSIGHT_LLM_MODEL", "gemini-2.5-flash")

if not API_KEY:
    print("[hindsight-dev-server] ERROR: no LLM API key found "
          "(set GEMINI_API_KEY or HINDSIGHT_API_LLM_API_KEY).", file=sys.stderr)
    sys.exit(1)

try:
    from hindsight import HindsightServer
except Exception as e:  # pragma: no cover
    print(f"[hindsight-dev-server] ERROR: could not import hindsight "
          f"(did you `pip install hindsight-all`?): {e}", file=sys.stderr)
    sys.exit(1)


# First boot downloads the embedding + reranker models from HuggingFace
# (BAAI/bge-small-en-v1.5 + a cross-encoder), which can blow past the default 30s
# startup timeout. Give it a generous window; subsequent boots are fast (cached).
START_TIMEOUT = float(os.environ.get("HINDSIGHT_START_TIMEOUT", "180"))


def main():
    print(f"[hindsight-dev-server] starting | provider={PROVIDER} model={MODEL} "
          f"port={PORT} start_timeout={START_TIMEOUT}s")
    print("[hindsight-dev-server] (first boot downloads embedding models — may take a minute)")
    server = HindsightServer(
        llm_provider=PROVIDER,
        llm_model=MODEL,
        llm_api_key=API_KEY,
        port=PORT,
    )
    # Call start() explicitly so we can pass a longer timeout than the context
    # manager's default 30s.
    server.start(timeout=START_TIMEOUT)
    try:
        url = getattr(server, "url", f"http://localhost:{PORT}")
        print(f"[hindsight-dev-server] READY at {url}")
        print(f"[hindsight-dev-server] set HINDSIGHT_BASE_URL={url} for Natively")
        print("[hindsight-dev-server] Ctrl-C to stop.")

        stop = {"flag": False}

        def _handle(signum, frame):
            stop["flag"] = True
        signal.signal(signal.SIGINT, _handle)
        signal.signal(signal.SIGTERM, _handle)

        while not stop["flag"]:
            time.sleep(0.5)
    finally:
        try:
            server.stop()
        except Exception:
            pass
    print("[hindsight-dev-server] stopped.")


if __name__ == "__main__":
    main()
