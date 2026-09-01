export const STANDARD_CLOUD_MODELS: Record<string, {
    hasKeyCheck: (creds: any) => boolean;
    ids: string[];
    names: string[];
    descs: string[];
    pmKey: 'geminiPreferredModel' | 'openaiPreferredModel' | 'claudePreferredModel' | 'groqPreferredModel' | 'deepseekPreferredModel' | 'nvidia_nimPreferredModel';
}> = {
    gemini: {
        hasKeyCheck: (creds) => !!creds?.hasGeminiKey,
        ids: ['gemini-3.7-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'],
        names: ['Gemini 3.7 Flash', 'Gemini 3.1 Flash Lite', 'Gemini 3.1 Pro'],
        descs: ['Fastest • Multimodal', 'Reasoning • High Quality'],
        pmKey: 'geminiPreferredModel'
    },
    openai: {
        hasKeyCheck: (creds) => !!creds?.hasOpenaiKey,
        ids: ['gpt-5.4'],
        names: ['GPT 5.4'],
        descs: ['OpenAI'],
        pmKey: 'openaiPreferredModel'
    },
    claude: {
        hasKeyCheck: (creds) => !!creds?.hasClaudeKey,
        ids: ['claude-sonnet-4-6'],
        names: ['Sonnet 4.6'],
        descs: ['Anthropic'],
        pmKey: 'claudePreferredModel'
    },
    groq: {
        hasKeyCheck: (creds) => !!creds?.hasGroqKey,
        // Groq retired every Llama id it hosted (llama-3.3-70b-versatile on
        // 2026-08-16, llama-4-scout on 2026-07-17). qwen3.6-27b leads because it
        // is the only Groq model that still accepts images, so it covers both the
        // text and the screenshot paths; the GPT-OSS pair is here so a user who
        // wants a text-only production-tier model can switch the default.
        ids: ['qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
        names: ['Groq Qwen 3.6', 'Groq GPT-OSS 120B', 'Groq GPT-OSS 20B'],
        descs: ['Ultra Fast • Multimodal', 'Highest Quality • Text-only', 'Fastest • Text-only'],
        pmKey: 'groqPreferredModel'
    },
    deepseek: {
        hasKeyCheck: (creds) => !!creds?.hasDeepseekKey,
        ids: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        names: ['DeepSeek V4 Flash', 'DeepSeek V4 Pro'],
        descs: ['Fast • Text-only', 'Reasoning • Text-only'],
        pmKey: 'deepseekPreferredModel'
    },
    nvidia_nim: {
        hasKeyCheck: (creds) => !!creds?.hasNvidiaNimKey,
        // NVIDIA retired BOTH ids this list used to offer — z-ai/glm4.7 on
        // 2026-05-14 and meta/llama-3.1-8b-instruct in the 2026-08-26 batch EOL
        // that also took every meta/* chat id — so the picker was offering two
        // models that answer 410 Gone to any request. The retired set itself
        // lives in electron/llm/nvidiaNimModels.ts.
        //
        // These presets are BEST-EFFORT, and cannot be more than that: NVIDIA's
        // catalogue lists ids that /chat/completions refuses, `GET /v1/models`
        // answers 200 to an invalid key, and there is no public signal for which
        // ids a given account may actually call. "Refresh" on the provider card
        // reads the account's own catalogue and is the authoritative list; a
        // preset that turns out to be unservable is handled at runtime, where a
        // 404/410 classifies as model_gone.
        ids: [
            'nvidia_nim/nvidia/llama-3.1-nemotron-70b-instruct',
            'nvidia_nim/nvidia/nemotron-3-super-120b-a12b',
            'nvidia_nim/openai/gpt-oss-20b',
        ],
        names: ['Llama 3.1 Nemotron 70B (Nvidia Nim)', 'Nemotron 3 Super (Nvidia Nim)', 'GPT-OSS 20B (Nvidia Nim)'],
        descs: ['Llama • Nvidia hosted', 'Reasoning • Nvidia hosted', 'Open weights • Nvidia hosted'],
        pmKey: 'nvidia_nimPreferredModel'
    },
};

export const CODEX_CLI_MODEL = {
    id: 'codex-cli',
    name: 'Codex CLI',
    desc: 'Local CLI transport',
};

export const CODEX_CLI_MODEL_PRESETS = [
    { id: 'gpt-5.5', name: 'ChatGPT 5.5' },
    { id: 'gpt-5.3-codex', name: 'Codex 5.3' },
    { id: 'gpt-5.3-codex-spark', name: 'Codex Spark 5.3' },
    { id: 'gpt-5.4', name: 'ChatGPT 5.4' },
];

export const codexCliSelectorId = (modelId: string): string => `codex-cli:${modelId}`;

export const getCodexCliModelDisplayName = (id: string): string | null => {
    if (id === CODEX_CLI_MODEL.id) return CODEX_CLI_MODEL.name;
    if (!id.startsWith('codex-cli:')) return null;

    const modelId = id.slice('codex-cli:'.length);
    const preset = CODEX_CLI_MODEL_PRESETS.find(model => model.id === modelId);
    return preset?.name || prettifyModelId(modelId);
};

export const CLAUDE_CLI_MODEL = {
    id: 'claude-cli',
    name: 'Claude Code',
    /** Compact prefix for narrow row labels — see claudeCliShortLabel. */
    shortName: 'CC',
    desc: 'Local CLI transport',
};

/**
 * Compact row label for one Claude Code alias: `CC-sonnet`, `CC-opus`, …
 *
 * Every surface that renders these rows is ~140px wide and clips with
 * Tailwind's `truncate`: the model-selector popup window is literally 140px
 * (ModelSelectorWindowHelper's BrowserWindow width) and the overlay's
 * current-model chip is `w-[140px]`. After the row's own padding and the
 * selected-row check icon there are ~78-100px of text box left, which at the
 * row's 12px font is about a dozen characters — so the previous long form,
 * `Claude Code: Sonnet`, rendered as `Claude Co…` for EVERY preset. Four rows,
 * pixel-identical, impossible to choose between.
 *
 * The alias is used verbatim from the id (`sonnet`, `opus`, `haiku`, `fable`)
 * rather than title-cased, because that is exactly the string the user passes
 * to `claude --model` — so the row names the thing it selects.
 */
export const claudeCliShortLabel = (alias: string): string =>
    `${CLAUDE_CLI_MODEL.shortName}-${alias}`;

/**
 * Label for the bare `claude-cli` id, which does NOT pin an alias — it means
 * "whatever model the Claude Code card in Settings is configured with". Kept
 * distinct from the pinned rows precisely because it used to render as
 * `Claude Code (Sonnet)` right next to `Claude Code: Sonnet`, a near-duplicate
 * that survived truncation as two identical `Claude Co…` rows.
 */
export const CLAUDE_CLI_DEFAULT_LABEL = claudeCliShortLabel('default');

/**
 * Model ALIASES, not pinned ids. `claude --model sonnet` resolves to whatever
 * the current Sonnet release is, so this list does not go stale the way the
 * pinned ids in STANDARD_CLOUD_MODELS.claude do — and a user on an older or
 * newer CLI gets a model that actually exists for them.
 */
export const CLAUDE_CLI_MODEL_PRESETS = [
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'opus', name: 'Opus' },
    { id: 'haiku', name: 'Haiku' },
    { id: 'fable', name: 'Fable' },
];

export const claudeCliSelectorId = (modelId: string): string => `claude-cli:${modelId}`;

export const getClaudeCliModelDisplayName = (id: string): string | null => {
    if (id === CLAUDE_CLI_MODEL.id) return CLAUDE_CLI_DEFAULT_LABEL;
    if (!id.startsWith('claude-cli:')) return null;

    // Unknown/custom aliases keep the prefix rather than falling back to
    // prettifyModelId: a bare `Claude 3 5 Haiku Latest` row loses the one piece
    // of information the picker actually needs — which TRANSPORT it goes through
    // — and is the label most likely to truncate into nothing.
    return claudeCliShortLabel(id.slice('claude-cli:'.length));
};

/**
 * Full, unabbreviated form of a Claude Code row, for the `title` tooltip on the
 * narrow surfaces the short labels are built for. `CC-` is deliberately terse,
 * so the long name has to stay reachable on hover.
 *
 * `configuredModel` is only meaningful for the bare `claude-cli` id, where it
 * names the alias Settings currently resolves it to.
 */
export const getClaudeCliModelTitle = (id: string, configuredModel?: string): string | null => {
    if (id === CLAUDE_CLI_MODEL.id) {
        return configuredModel
            ? `${CLAUDE_CLI_MODEL.name} — default (${configuredModel})`
            : `${CLAUDE_CLI_MODEL.name} — default`;
    }
    if (!id.startsWith('claude-cli:')) return null;
    return `${CLAUDE_CLI_MODEL.name} — ${id.slice('claude-cli:'.length)}`;
};

export const prettifyModelId = (id: string): string => {
    if (!id) return '';
    return id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

/**
 * Providers whose model allow-list is OPT-IN: an empty list means NOTHING is
 * selected, not "everything".
 *
 * Every other provider ships a curated handful of preset models, so "empty =
 * all" is the right default there and stays. A LiteLLM gateway fronts the
 * upstream's entire catalogue — 300+ models is normal — and defaulting that to
 * "all" floods the meeting-overlay picker with a list nobody chose.
 *
 * MIRRORED in ipcHandlers.ts modelAvailable(). The two must agree: this one
 * decides what the user can pick, that one decides what routing will accept.
 * A drift guard test pins them together.
 */
export const isOptInModelProvider = (provider: string): boolean => provider === 'litellm';

/**
 * Does `modelId` survive `provider`'s allow-list?
 *
 * The single definition of the allow-list contract, so the settings panel, the
 * meeting-overlay picker and routing cannot disagree about what "empty" means.
 */
export const isModelAllowed = (provider: string, modelId: string, allowList: string[]): boolean => {
    // Opt-in: nothing is permitted until the user ticks it.
    if (isOptInModelProvider(provider)) return allowList.includes(modelId);
    // Everyone else: empty means no filter at all.
    return allowList.length === 0 || allowList.includes(modelId);
};

/**
 * The display label for a LiteLLM-proxied model.
 *
 * TWO prefixes stack on these ids, and neither is identity:
 *   1. `litellm/` — Natively's own routing prefix. providerFamily() and
 *      modelAvailable() (ipcHandlers.ts) key off it, so it can never be
 *      dropped from the ID; it just has no business being on screen.
 *   2. `<upstream>/` — the PROXY's own model id. Most LiteLLM configs name
 *      models `openai/gpt-4o`, `anthropic/claude-3-5-sonnet`, `bedrock/...`,
 *      so a raw id reads `litellm/openai/gpt-4o`.
 *
 * The label is therefore the LAST segment. Accepts prefixed and bare ids
 * alike, because the two callers hold different forms: the picker and the
 * allow-list hold `litellm/<id>`, while the discovery cache
 * (getAvailableLiteLLMModels) holds the proxy's `<id>` verbatim.
 *
 * Deliberately NOT prettifyModelId(): that is built for our own hyphenated
 * ids and mangles proxy ids — `bedrock/anthropic.claude-v2` came out as
 * "Bedrock/Anthropic.Claude V2". A proxy model id is a literal the user typed
 * into their own config, so it renders verbatim.
 *
 * KNOWN, ACCEPTED: two upstreams can expose the same model name, so
 * `openai/gpt-4o` and `azure/gpt-4o` both label as "gpt-4o" and are
 * indistinguishable in a list. Showing the bare name was chosen with that
 * trade-off understood; disambiguating is a change to this one function.
 */
export const litellmModelLabel = (id: string): string => {
    if (!id) return '';
    const segments = id.replace(/^litellm\//, '').split('/').filter(Boolean);
    // Degenerate ids ("litellm/", "///") keep the input rather than becoming
    // an empty label — a blank row is worse than an ugly one.
    return segments.length ? segments[segments.length - 1] : id;
};
