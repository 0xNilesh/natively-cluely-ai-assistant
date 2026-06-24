// electron/rag/LocalReranker.ts
//
// Phase 1 (smart-retrieval rollout) — LOCAL cross-encoder reranker.
//
// A cross-encoder scores (query, passage) JOINTLY and is far more accurate than
// the bi-encoder cosine fusion used on the hot path — at the cost of running one
// model pass per candidate. We run it ON-DEVICE via @huggingface/transformers
// (the SAME ONNX runtime already loaded for the MiniLM embedder and the
// mobilebert intent classifier), so the escalation costs $0, hits no API, and is
// immune to the Gemini 429s that are routine in this app.
//
// LOAD POSTURE — mirrors LocalEmbeddingProvider exactly:
//   • ESM-only package → forced runtime import() via `new Function` (opaque to
//     the TS commonjs rewrite, see LocalEmbeddingProvider for the why).
//   • Packaged prod: local_files_only, model read from resources/models. The
//     reranker model is NOT bundled yet, so in a packaged build load() fails and
//     the caller falls through to the existing top-K — that is the intended
//     default-OFF posture until the model is added to extraResources.
//   • Dev: allowRemoteModels so the model is fetched + cached on first use.
//
// Everything here is best-effort: any failure (package missing, model absent,
// API shape mismatch) resolves to `null`, never throws, and the retriever keeps
// its current behavior. The Phase-1 flag (`ragLocalRerank`) gates whether this
// is consulted at all.

import path from 'path';
import { app } from 'electron';

export interface RerankResult {
    /** Index into the input passages array. */
    index: number;
    /** Cross-encoder relevance score (higher = more relevant). Raw logit. */
    score: number;
}

/**
 * Default model: bge-reranker-base, ONNX port that runs in transformers.js.
 * Small cross-encoder (~1.1GB fp32 / ~280MB quantized) — quantized is used.
 * Override via NATIVELY_RERANKER_MODEL for experimentation.
 */
const DEFAULT_RERANKER_MODEL = 'Xenova/bge-reranker-base';

class LocalRerankerImpl {
    private model: any = null;
    private tokenizer: any = null;
    private loadingPromise: Promise<void> | null = null;
    private loadFailed = false;
    private readonly modelId: string;
    private readonly modelPath: string;

    constructor() {
        this.modelId = (process.env.NATIVELY_RERANKER_MODEL || '').trim() || DEFAULT_RERANKER_MODEL;
        // Same resolution as LocalEmbeddingProvider: bundled resources in prod,
        // app-relative resources/ in dev.
        this.modelPath = path.join(
            app?.isPackaged ? (process.resourcesPath || '') : path.join(app?.getAppPath?.() || process.cwd(), 'resources'),
            'models',
        );
    }

    /**
     * Phase 3: warm the model ahead of the live path (called at mode
     * activation, fire-and-forget) so a live transcript turn never pays the
     * cold-load cost inside its retrieval budget. Best-effort — swallows any
     * failure (the load-failed flag then makes later rerank() calls no-op).
     */
    async prewarm(): Promise<void> {
        try { await this.ensureLoaded(); } catch { /* logged in ensureLoaded */ }
    }

    /**
     * True once a usable model is loaded. Returns false (never throws) when the
     * model/package is unavailable — the caller treats that as "no rerank" and
     * keeps the current top-K.
     */
    async isAvailable(): Promise<boolean> {
        if (this.loadFailed) return false;
        try {
            await this.ensureLoaded();
            return this.model !== null && this.tokenizer !== null;
        } catch {
            return false;
        }
    }

    private async ensureLoaded(): Promise<void> {
        if (this.model && this.tokenizer) return;
        if (this.loadFailed) throw new Error('reranker previously failed to load');
        if (this.loadingPromise) return this.loadingPromise;

        this.loadingPromise = (async () => {
            // Forced ESM import — opaque to the TS commonjs rewrite (see
            // LocalEmbeddingProvider for the full explanation of this trick).
            const transformers = await (new Function('return import("@huggingface/transformers")')()) as any;
            const { AutoModelForSequenceClassification, AutoTokenizer, env } = transformers;

            const isPackaged = Boolean(app?.isPackaged);
            if (isPackaged) {
                env.allowRemoteModels = false;
                env.localModelPath = this.modelPath;
            } else {
                // Dev: allow the first-run download, cache alongside the other
                // bundled models so a later prod bundling step can pick it up.
                env.allowRemoteModels = true;
                env.cacheDir = this.modelPath;
            }

            const tokenizer = await AutoTokenizer.from_pretrained(this.modelId, {
                local_files_only: isPackaged,
            });
            const model = await AutoModelForSequenceClassification.from_pretrained(this.modelId, {
                local_files_only: isPackaged,
                // transformers.js v3 selects the ONNX variant by `dtype` (the old
                // `quantized: true` is ignored). q8 loads model_quantized.onnx
                // (~280MB) instead of the fp32 model.onnx (~1.1GB) — the bundled
                // download fetches the quantized variant, so this keeps both the
                // installer and the loaded footprint small. NATIVELY_RERANKER_DTYPE
                // overrides (e.g. 'fp32') for accuracy experiments.
                dtype: (process.env.NATIVELY_RERANKER_DTYPE || 'q8').trim() || 'q8',
            } as any);
            this.tokenizer = tokenizer;
            this.model = model;
        })();

        try {
            await this.loadingPromise;
        } catch (e) {
            this.loadFailed = true;
            this.loadingPromise = null;
            this.model = null;
            this.tokenizer = null;
            console.warn('[LocalReranker] model load failed (rerank disabled, falling back to top-K):', e instanceof Error ? e.message : e);
            throw e;
        }
    }

    /**
     * Score each passage against the query with the cross-encoder. Returns
     * results in DESCENDING score order. On any failure returns `null` so the
     * caller keeps the pre-rerank ordering — rerank must never make retrieval
     * worse than the baseline.
     *
     * Cost: one forward pass per passage (batched by the tokenizer). Keep the
     * candidate pool bounded (caller caps at ~30) so this stays in the
     * tens-of-milliseconds range on the local ONNX runtime.
     */
    async rerank(query: string, passages: string[]): Promise<RerankResult[] | null> {
        if (!query.trim() || passages.length === 0) return null;
        try {
            if (!(await this.isAvailable())) return null;

            // Cross-encoder: tokenize [query, passage] pairs together. The model
            // emits a single relevance logit per pair (num_labels === 1 for
            // bge-reranker). We read logits.data and sort descending.
            const inputs = await this.tokenizer(
                new Array(passages.length).fill(query),
                { text_pair: passages, padding: true, truncation: true },
            );
            const output = await this.model(inputs);
            const logits = output?.logits;
            const data: Float32Array | number[] | undefined = logits?.data ?? logits?.ort_tensor?.data;
            if (!data || data.length < passages.length) {
                console.warn('[LocalReranker] unexpected logits shape — skipping rerank');
                return null;
            }

            const results: RerankResult[] = passages.map((_, i) => ({ index: i, score: Number(data[i]) }));
            results.sort((a, b) => b.score - a.score);
            return results;
        } catch (e) {
            console.warn('[LocalReranker] rerank failed (keeping pre-rerank order):', e instanceof Error ? e.message : e);
            return null;
        }
    }

    /** Test-only: reset cached load state so a test can re-exercise loading. */
    __resetForTests(): void {
        this.model = null;
        this.tokenizer = null;
        this.loadingPromise = null;
        this.loadFailed = false;
    }
}

// Process-wide singleton — one model load shared across all modes/queries,
// matching the embedder/intent-classifier lifetime.
let _instance: LocalRerankerImpl | null = null;
export function getLocalReranker(): LocalRerankerImpl {
    if (!_instance) _instance = new LocalRerankerImpl();
    return _instance;
}

export type { LocalRerankerImpl };
