# Natively External Research Notes

**Date:** 2026-06-12
**Purpose:** Research-only notes to design a thin, optional Hindsight adapter for Natively Intelligence OS Phase 16. The external repo is cloned under `_external_research/` (gitignored, NOT vendored, NOT committed, NOT a runtime dependency).

---

## Hindsight

- **Repo cloned:** ✅ yes — `_external_research/hindsight` (`git clone --depth=1 https://github.com/vectorize-io/hindsight.git`).
- **Clone failure reason:** N/A (succeeded).
- **License:** **MIT** (top-level `LICENSE` — "Copyright (c) 2025 Vectorize AI, Inc."). Note: two sub-package READMEs (`hindsight-api`, `hindsight-api-slim`) say "Apache 2.0", but the authoritative top-level LICENSE is MIT. Either way, permissive — safe to integrate against via the published client. We integrate against the **published npm client**, not vendored source.

### Core operations (verified from `hindsight-api-slim/.../api/http.py` + docs)

| Op | Endpoint | Purpose | Natively use |
|---|---|---|---|
| **retain** | `POST /v1/default/banks/{bank_id}/memories` | Store conversations/docs/facts; LLM extracts facts/entities/temporal links. Supports `async`. | Post-meeting / post-lecture background retain. |
| **recall** | `POST /v1/default/banks/{bank_id}/memories/recall` | Multi-strategy (semantic + BM25 + graph + temporal) search, fused/reranked. Returns `results[]`. 504 on timeout. | "What did we discuss last time?", cross-meeting/global recall. |
| **reflect** | `POST /v1/default/banks/{bank_id}/reflect` | Disposition-aware LLM answer over memories + mental models. 504 on timeout. | OFFLINE only — coaching, weakness/objection pattern analysis, course mastery. **Never** on the live answer path. |

### TS client (verified from `hindsight-clients/typescript/`)

- Package: **`@vectorize-io/hindsight-client`** (v0.8.1). Description: "TypeScript client for Hindsight".
- Construct: `new HindsightClient({ baseUrl, apiKey?, userAgent? })`; apiKey → `Authorization: Bearer`.
- Methods (all take `bankId` first, all accept `signal?: AbortSignal`):
  - `retain(bankId, content, { timestamp?, context?, metadata?, tags?, async?, updateMode?, signal? })`
  - `retainBatch(bankId, items, { documentId?, async?, signal? })`
  - `recall(bankId, query, { types?, maxTokens?, budget?, tags?, tagsMatch?, tagGroups?, signal? })`
  - `reflect(bankId, query, { budget?, tags?, tagsMatch?, factTypes?, signal? })`
  - bank/document/directive/mental-model management methods.

### Tags / metadata / isolation (verified)

- **Banks are strictly isolated** (`CLAUDE.md`: "Each bank is an isolated memory store… no cross-bank data leakage"). All routes are scoped by `{bank_id}`.
- **Tags** (`MemoryItem.tags: string[]`): "visibility scoping… filtered during recall". Migration comment: "Tags enable filtering by scope (e.g., user IDs, session IDs)."
- **Recall/reflect filters:** `tags` + `tags_match` (`any | all | any_strict | all_strict`) + `tag_groups` (boolean AND/OR/NOT). `_strict` variants **exclude untagged** memories.
- **Metadata** (`metadata: dict[str,str]`) exists on retain and is returned on recall, **but the core recall/reflect request schema exposes TAG filters, not metadata filters.** → **Isolation MUST be enforced by tags (and/or per-tenant bank), NOT metadata alone** — which aligns with Natively non-negotiable rule #6.

### Deployment (verified)

- **Self-hostable** (Docker / pip / Helm) OR **Hindsight Cloud** (managed). Requires **PostgreSQL 14+ with a vector extension** (pgvector default; pgvectorscale/vchord/scann also supported). Embedded `pg0` for dev only.
- Docker: `ghcr.io/vectorize-io/hindsight:latest`, API on `:8888`, control-plane UI on `:9999`.
- Key server env: `HINDSIGHT_API_DATABASE_URL`, `HINDSIGHT_API_LLM_PROVIDER`, `HINDSIGHT_API_LLM_API_KEY`, `HINDSIGHT_API_PORT`.
- Client needs only `baseUrl` (+ `apiKey` for cloud). **No documented concrete hosted base URL found in repo** — cloud signup at `ui.hindsight.vectorize.io`. → NOT FOUND IN REPO: a hardcodeable cloud dataplane URL; it must be a user-supplied config.

### Timeouts / async / batching (verified)

- `async: true` retain returns immediately with `operation_id(s)` → **use this for all Natively retain** (never block live).
- All client methods take `AbortSignal` → **the adapter will impose Natively's own strict timeouts** (live recall ≤800ms, global ≤3–5s) via `AbortController`, never relying on server defaults.
- Recall/reflect return **504 on timeout** → adapter treats any error/timeout as "no memory" and the answer proceeds without it.

---

## What Natively SHOULD use from Hindsight

1. The **published TS client** (`@vectorize-io/hindsight-client`) as an **optionalDependency** — wrapped behind a `MemoryProvider` interface so the app compiles and runs whether or not it's installed/configured.
2. **`retain` (async)** for post-meeting + post-lecture background memory.
3. **`recall` (with hard AbortSignal timeout)** for backward-looking cross-meeting questions and global search fusion ONLY — never identity, never the live current-question path.
4. **`reflect`** OFFLINE only (coaching / weakness / course mastery), never live.
5. **Isolation by per-user/per-org BANK + scope TAGS** (`user:{id}`, `org:{id}`, `source:{...}`, `mode:{...}`, `visibility:private`) with `tags_match: "all_strict"` on recall so untagged/foreign memories can't leak. (Strongest: one bank per tenant; tags as defense-in-depth.)

## What Natively should NOT do

- ❌ Do NOT vendor Hindsight source into `electron/`/`premium/`.
- ❌ Do NOT make Hindsight a hard/required dependency. A `NoopMemoryProvider` must be the default so the app works fully with memory disabled (non-negotiable rules #3, #14, #15).
- ❌ Do NOT use Hindsight as the primary identity source (rule #2) or on the live current-question path (rule #4).
- ❌ Do NOT rely on metadata for isolation (rule #6) — tags + bank only.
- ❌ Do NOT use `reflect` live (it's an LLM analysis pass — slow).
- ❌ Do NOT commit `_external_research/` (gitignored).

## Other research repos

- `graphrag`, `graphiti` — **NOT cloned** this pass. Only needed if Phase 14/15 (lecture/diagram) or memory comparison demands a graph approach; the existing sqlite-vec hybrid RAG + a tagged Hindsight bank cover the spec without them. Will revisit at Phase 14/16 if a concrete gap appears, and document then.

## Risks

- Running Hindsight requires a Postgres+pgvector service + an LLM key → a real ops burden. For Natively (local-first desktop), this is an **opt-in power-user / cloud feature**, not a default. The adapter + Noop default keep the desktop app self-contained.
- The TS client is v0.x (pre-1.0) → API may shift. Wrapping it behind our own `MemoryProvider` interface insulates the app from client churn.
