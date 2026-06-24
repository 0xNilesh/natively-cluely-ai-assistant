const path = require('path');
const fs = require('fs');

async function downloadModels() {
    const { pipeline, env } = await import('@huggingface/transformers');
    const modelsDir = path.join(__dirname, '../resources/models');
    
    // Ensure the directory exists
    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }

    // Let Transformers.js handle the download but specify the local directory cache
    env.cacheDir = modelsDir;
    
    try {
        // 1. Embedding model (RAG)
        console.log('[download-models] Downloading Xenova/all-MiniLM-L6-v2...');
        await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log('[download-models] all-MiniLM-L6-v2 downloaded.');

        // 2. Zero-shot classification model (Intent Classifier)
        console.log('[download-models] Downloading Xenova/mobilebert-uncased-mnli...');
        await pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli');
        console.log('[download-models] mobilebert-uncased-mnli downloaded.');

        // 3. Cross-encoder reranker (smart-retrieval Phase 1/3 — confidence-gated
        //    rerank escalation). LocalReranker.ts loads this via
        //    AutoModelForSequenceClassification + AutoTokenizer with
        //    local_files_only in packaged builds, so it MUST be bundled here or
        //    the rerank silently no-ops in production. The `text-classification`
        //    pipeline fetches the same model + tokenizer files those Auto* APIs
        //    read. Gated by the (default-OFF) ragLocalRerank flag at runtime, but
        //    bundled unconditionally so flipping the flag needs no re-download.
        //    Honors NATIVELY_RERANKER_MODEL so an override is bundled too.
        const rerankerModel = (process.env.NATIVELY_RERANKER_MODEL || '').trim() || 'Xenova/bge-reranker-base';
        const rerankerDtype = (process.env.NATIVELY_RERANKER_DTYPE || 'q8').trim() || 'q8';
        console.log(`[download-models] Downloading reranker ${rerankerModel} (dtype=${rerankerDtype})...`);
        // Fetch ONLY the quantized ONNX variant the runtime loads (LocalReranker
        // uses dtype:'q8' → model_quantized.onnx, ~280MB) instead of the fp32
        // model.onnx (~1.1GB) the generic pipeline() would pull, so the bundle
        // stays small. Use the Auto* APIs with an explicit dtype to match.
        const { AutoModelForSequenceClassification, AutoTokenizer } = await import('@huggingface/transformers');
        await AutoTokenizer.from_pretrained(rerankerModel);
        await AutoModelForSequenceClassification.from_pretrained(rerankerModel, { dtype: rerankerDtype });
        console.log(`[download-models] ${rerankerModel} downloaded.`);

        console.log('[download-models] All models downloaded successfully!');
    } catch (e) {
        console.error('[download-models] Error downloading model:', e);
        process.exit(1);
    }
}

downloadModels().catch((e) => {
    console.error('[download-models] Fatal error:', e);
    process.exit(1);
});

