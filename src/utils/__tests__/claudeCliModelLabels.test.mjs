// Regression for the Claude Code rows in the meeting model picker.
//
// The picker window is 140px wide (ModelSelectorWindowHelper's BrowserWindow)
// and every row clips with Tailwind's `truncate`. The old labels —
// `Claude Code (Sonnet)` for the bare id and `Claude Code: <Preset>` for each
// pinned alias — all rendered as `Claude Co…`, so the rows were pixel-identical
// and there was no way to tell sonnet from opus from haiku.
//
// Hard rules:
//   1. Every claude-cli row is `CC-<alias>`, with the alias verbatim from the
//      id (that is the string passed to `claude --model`).
//   2. The bare `claude-cli` id — "whatever Settings is configured with" —
//      renders distinctly from every pinned alias, so the near-duplicate row
//      cannot come back.
//   3. Labels stay short enough for the picker's usable text box.
//   4. Non-claude-cli ids are still passed through (null), so the shared
//      display-name resolver in ModelSelector / NativelyInterface keeps
//      falling through to its other branches.
//   5. The long form remains reachable for the row's `title` tooltip.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    CLAUDE_CLI_DEFAULT_LABEL,
    CLAUDE_CLI_MODEL,
    CLAUDE_CLI_MODEL_PRESETS,
    claudeCliSelectorId,
    claudeCliShortLabel,
    getClaudeCliModelDisplayName,
    getClaudeCliModelTitle,
} from '../modelUtils.ts';

// The picker row is 140px minus the panel's p-2 (8px each side) and the row's
// px-3 (12px each side) — and minus the 14px check icon plus its ml-2 on the
// SELECTED row. That leaves ~78px, which at the row's 12px medium font is
// roughly 13 characters. Every label has to clear that bar to be readable.
const MAX_ROW_CHARS = 13;

describe('Claude Code CLI picker labels', () => {
    test('each preset renders as CC-<alias>', () => {
        const labels = CLAUDE_CLI_MODEL_PRESETS.map(
            (preset) => getClaudeCliModelDisplayName(claudeCliSelectorId(preset.id)),
        );
        assert.deepEqual(labels, ['CC-sonnet', 'CC-opus', 'CC-haiku', 'CC-fable']);
    });

    test('the bare claude-cli id is distinct from every pinned alias', () => {
        const bare = getClaudeCliModelDisplayName(CLAUDE_CLI_MODEL.id);
        assert.equal(bare, CLAUDE_CLI_DEFAULT_LABEL);
        assert.equal(bare, 'CC-default');

        const pinned = CLAUDE_CLI_MODEL_PRESETS.map(
            (preset) => getClaudeCliModelDisplayName(claudeCliSelectorId(preset.id)),
        );
        assert.ok(
            !pinned.includes(bare),
            'the bare row used to read `Claude Code (Sonnet)` right beside `Claude Code: Sonnet` — ' +
            'two rows that truncated to the same thing',
        );
    });

    test('every row fits the picker without truncating', () => {
        const rows = [
            getClaudeCliModelDisplayName(CLAUDE_CLI_MODEL.id),
            ...CLAUDE_CLI_MODEL_PRESETS.map((p) => getClaudeCliModelDisplayName(claudeCliSelectorId(p.id))),
        ];
        for (const row of rows) {
            assert.ok(
                row.length <= MAX_ROW_CHARS,
                `"${row}" is ${row.length} chars, over the ${MAX_ROW_CHARS} the 140px picker row fits`,
            );
        }
    });

    test('all rows remain distinguishable from each other', () => {
        const rows = [
            getClaudeCliModelDisplayName(CLAUDE_CLI_MODEL.id),
            ...CLAUDE_CLI_MODEL_PRESETS.map((p) => getClaudeCliModelDisplayName(claudeCliSelectorId(p.id))),
        ];
        assert.equal(new Set(rows).size, rows.length, `duplicate rows: ${JSON.stringify(rows)}`);
    });

    test('an alias with no preset keeps the CC- prefix instead of being prettified', () => {
        // Users can point the Claude Code card at any alias their CLI accepts.
        // Falling back to prettifyModelId dropped the transport from the label,
        // which is the one thing the picker row has to convey.
        assert.equal(
            getClaudeCliModelDisplayName('claude-cli:claude-3-5-haiku-latest'),
            'CC-claude-3-5-haiku-latest',
        );
        assert.equal(claudeCliShortLabel('sonnet[1m]'), 'CC-sonnet[1m]');
    });

    test('non claude-cli ids fall through', () => {
        // The shared resolver in ModelSelector.tsx / NativelyInterface.tsx tries
        // this first and relies on null to reach its Ollama / LiteLLM / cloud
        // branches. A greedy match here would relabel unrelated models.
        assert.equal(getClaudeCliModelDisplayName('claude-sonnet-4-6'), null);
        assert.equal(getClaudeCliModelDisplayName('codex-cli:gpt-5.5'), null);
        assert.equal(getClaudeCliModelDisplayName('ollama-llama3'), null);
        assert.equal(getClaudeCliModelDisplayName(''), null);
    });

    test('the long form stays available for the row tooltip', () => {
        assert.equal(
            getClaudeCliModelTitle(claudeCliSelectorId('opus')),
            'Claude Code — opus',
        );
        assert.equal(
            getClaudeCliModelTitle(CLAUDE_CLI_MODEL.id, 'sonnet'),
            'Claude Code — default (sonnet)',
        );
        assert.equal(getClaudeCliModelTitle(CLAUDE_CLI_MODEL.id), 'Claude Code — default');
        assert.equal(getClaudeCliModelTitle('gemini-3.7-flash'), null);
    });
});
