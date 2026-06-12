# Hindsight Local Setup (Optional Long-Term Memory)

Natively works **fully without Hindsight**. This is an opt-in, power-user/self-hosted feature that
adds cross-meeting long-term memory ("what did we discuss last time?", recurring patterns, course
memory). When Hindsight is not installed/configured/running, Natively's memory provider is a
**Noop** — live answers, local global search, and meeting summaries all keep working unchanged.

> **Source:** verified from the Hindsight repo (MIT, `github.com/vectorize-io/hindsight`) during the
> Intelligence OS Phase 0 research. See `NATIVELY_EXTERNAL_RESEARCH_NOTES.md`.

## Requirements

- **PostgreSQL 14+ with a vector extension** (pgvector by default; pgvectorscale / vchord / scann
  also supported). An embedded `pg0` exists for dev but is not recommended for production.
- **An LLM provider + API key** for the Hindsight server (OpenAI / Anthropic / Gemini / Groq /
  Ollama / etc.) — Hindsight uses an LLM for fact extraction and reflect.
- **The TS client** in Natively: `npm install @vectorize-io/hindsight-client` (optionalDependency;
  Natively's adapter lazy-requires it and falls back to Noop if absent).

## Run the server (Docker — simplest)

```bash
docker run -it --pull always --name hindsight --restart unless-stopped \
  -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
  -v hindsight-data:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
```

- API: `http://localhost:8888` · Control-plane UI: `http://localhost:9999`
- For an external Postgres, set `HINDSIGHT_API_DATABASE_URL` and run `CREATE EXTENSION vector;` in
  that DB. Other server vars: `HINDSIGHT_API_LLM_PROVIDER`, `HINDSIGHT_API_LLM_MODEL`,
  `HINDSIGHT_API_PORT`.

A managed **Hindsight Cloud** also exists (`ui.hindsight.vectorize.io`) — use its base URL + an API
key instead of self-hosting.

## Health check

```bash
curl -s http://localhost:8888/health   # or open the control-plane UI on :9999
```

## Configure Natively

1. `npm install @vectorize-io/hindsight-client`
2. In `.env` (see `.env.example`):
   ```
   HINDSIGHT_BASE_URL=http://localhost:8888
   HINDSIGHT_API_KEY=            # only for Hindsight Cloud
   HINDSIGHT_TIMEOUT_MS=800
   ```
3. Enable the feature flags **in this order** (each is `NATIVELY_*=1` env or a SettingsManager key):
   1. `NATIVELY_HINDSIGHT_MEMORY=1` — turns the provider on at all (without this it's Noop).
   2. `NATIVELY_HINDSIGHT_POST_MEETING_RETAIN=1` — async-retain meeting summaries after a meeting
      ends (the safest first step; retain only, no recall).
   3. *(future)* global recall in search, then **live recall last** — only after the above are
      validated.

## Isolation & privacy (how Natively scopes memory)

Natively's `HindsightTagBuilder` enforces isolation two ways (defense in depth), per the research:

- **Bank per tenant** — `org_<id>` when an org is present, else `user_<id>`. Banks are strictly
  isolated by Hindsight; no cross-bank leakage.
- **Strict scope tags** on every retained item — `user:<id>`, `org:<id|personal>`,
  `visibility:private`, `source:<type>`, `mode:<mode>`, plus context tags (`meeting:`, `session:`,
  `course:`, `lecture:`, `company:`, hashed `participant:`, `date:`). Recall filters with
  `tags_match: "all_strict"`, which **excludes untagged/foreign** memories. Participant ids are
  hashed, never stored raw. Isolation is enforced by **tags + bank, never metadata alone**.

## Timeouts & async (never blocks live answers)

- **retain** is async/queued (concurrency-1, backpressure-bounded) — the live answer path only
  enqueues and returns.
- **recall** is bounded by an `AbortController` + `Promise.race` timeout (live ≤ 800ms, global
  2–5s). On timeout/error it returns `[]` and the answer proceeds **without** memory.
- **reflect** is offline/deep-analysis only — never on the live answer path.

## Failure fallback

If the Hindsight server is down or unreachable:

- Live answers still work (no dependency).
- Local global search still works (local DB only).
- Meeting summaries still save.
- Retain calls are skipped (the queue worker logs and drops; a future version may retry).
- No user-facing crash — the adapter degrades to Noop on any construction/call failure.

## Backup / restore

Hindsight state lives in Postgres (the `hindsight-data` Docker volume for `pg0`, or your external
DB). Back up the database with standard Postgres tooling (`pg_dump` / volume snapshot). Natively
keeps its own meeting data in its local SQLite DB independently, so a Hindsight loss never loses
meetings — only the long-term-memory index, which can be rebuilt by re-retaining.
