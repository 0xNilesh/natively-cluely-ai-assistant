// electron/rag/embeddingSpace.ts
// Single source of truth for an embedding "space" identity.
//
// An embedding space is the (provider family, model, dimensions) tuple that a
// vector was produced in. Two vectors are only comparable if they share a space.
//
// The historical bug this fixes: re-index compatibility used to key on the
// provider NAME alone ('gemini'). That cannot distinguish gemini-embedding-001
// (768d) from gemini-embedding-2 (768d) — same name, same dims, but INCOMPATIBLE
// vector spaces. Comparing them yields semantically random cosine similarity with
// no error. Keying on the composite space string fixes this and generalizes to
// any provider/model/dimension change.

/** Strip the optional `models/` prefix and normalize casing/whitespace so
 *  'models/gemini-embedding-001' and 'gemini-embedding-001' collapse to one key. */
export function normalizeModel(model: string): string {
  return model.replace(/^models\//, '').trim().toLowerCase();
}

/** Canonical identity for an embedding space: `${name}:${model}:${dims}`. */
export function embeddingSpaceKey(p: { name: string; model: string; dimensions: number }): string {
  return `${p.name}:${normalizeModel(p.model)}:${p.dimensions}`;
}

/**
 * Synthesize the v1 (pre-migration) space for a legacy row that only has an
 * `embedding_provider` name (+ maybe dims). Used by the schema backfill so that
 * old rows carry a concrete space string which correctly DIFFERS from any new
 * model's space, triggering re-index.
 *
 * Must stay in sync with the model defaults the providers shipped with at the
 * time the legacy rows were written.
 */
export function legacySpaceForProvider(name: string, dims: number | null): string {
  const legacyModel: Record<string, string> = {
    gemini: 'gemini-embedding-001',
    ollama: 'nomic-embed-text',
    openai: 'text-embedding-3-small',
    local: 'xenova/all-minilm-l6-v2',
  };
  const model = legacyModel[name] ?? 'unknown';
  return `${name}:${model}:${dims ?? 'unknown'}`;
}
