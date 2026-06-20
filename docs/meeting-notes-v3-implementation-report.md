# Meeting Notes V3 — Implementation Report (Phase 16)

Date: 2026-06-20
Branch: `feat/browser-extension-v2-pairing` (uncommitted working tree)

## 1. What changed

Natively now produces a polished, trustworthy post-meeting work artifact: clean skim-first
notes, decisions, action items with owners/deadlines, open questions, risks/blockers,
mode-specific sections, evidence with timestamps, an LLM-written follow-up draft, editable
speaker labels, meeting-type auto-detection, cross-meeting carryover, and a
regenerate/copy/export UI. Long meetings are summarized via token-aware chunk → per-chunk
structured extraction → reduce (never a transcript prefix). Default-ON behind flags.

## 2. Files

### New services (`electron/services/meeting/`)
- `MeetingSummaryV3.ts` — canonical spec schema + runtime validator (`validateMeetingSummaryV3`) + legacy normalizer (`normalizeLegacySummary`) + `sanitizeFollowUpDraft`.
- `generateStructured.ts` — provider-agnostic JSON ladder: extract → validate → repair-once → fallback.
- `MeetingSummaryStrategySelector.ts` — direct / map_reduce / long_context selection.
- `FollowUpDraftGenerator.ts` — mode-aware LLM follow-up prose + deterministic fallback.
- `MeetingModeDetector.ts` — deterministic meeting-type detection from transcript + calendar.
- `SpeakerLabelService.ts` — canonical speaker ids, rename map, apply-to-all.
- `CrossMeetingRecall.ts` — "still open from last time" carryover (local-first).
- `__tests__/MeetingNotesV3.test.mjs` — 29 new tests.

### Refactored services (existing)
- `types.ts` (re-exports canonical schema + Ms-named transcript/chunk types, segmentId),
  `TranscriptNormalizer.ts` (segmentId + canonical speakerId), `TranscriptChunker.ts`
  (startMs/endMs, segmentIds), `ChunkSummaryGenerator.ts` (uses `generateStructured`, drops
  empty atoms), `MeetingSummaryReducer.ts` (emits spec schema: whatChanged, mode, generation),
  `MeetingSummarySchemaValidator.ts` (delegates summary validation to canonical),
  `MeetingContextAssembler.ts` (strategy + generation block + follow-up), `MeetingRecipes.ts`.

### Modified integration
- `electron/MeetingPersistence.ts` — mode-detect + cross-meeting wiring; `regenerateSavedMeeting`, `regenerateFollowUpDraft`; spec-shaped persistence.
- `electron/IntelligenceManager.ts` — `regenerateMeetingSummary` / `regenerateMeetingFollowUp`.
- `electron/db/DatabaseManager.ts` — `replaceDetailedSummary`, `updateSpeakerLabels`; V3 detailedSummary type.
- `electron/ipcHandlers.ts` — `regenerate-meeting-summary`, `regenerate-meeting-followup`, `update-meeting-speaker-labels`.
- `electron/preload.ts` + `src/types/electron.d.ts` — new bridge methods.
- `electron/intelligence/intelligenceFlags.ts` — 4 new flags (V3 set default-ON).
- `src/components/MeetingDetails.tsx` — V3 renderer: toolbar (regenerate/evidence toggle/status), mode suggestion, cross-meeting carryover, TLDR, what-changed, decisions, actions, questions, risks, mode sections, follow-up draft (copy/regenerate/tone), speaker rename + evidence→transcript jump.
- `src/components/settings/IntelligenceSettings.tsx` — new flag toggles.
- `package.json` — `test:meeting-notes` script.

## 3. Long-meeting handling
`MeetingSummaryStrategySelector` chooses direct (≤1500 tok) vs map_reduce (default). The
chunker splits on segment boundaries (3000 tok / 300 overlap), preserves
timestamp/speaker/segmentId, and carries overlap. Each chunk → `ChunkMeetingAtoms` via the
extraction LLM (through `generateStructured`); empty/failed chunks are dropped and counted.
The reducer merges/dedupes decisions/actions/questions/risks (word-overlap ≥0.8), preserves
contradictory decisions, preserves section order, and reports `transcriptCoverage`.
No `substring` truncation on the primary path; the legacy fallback uses balanced
begin/middle/end context.

## 4. JSON / schema validation
`validateMeetingSummaryV3` is a never-throwing runtime validator that coerces every field,
drops invalid items, infers severities/confidence, and returns `ok:false` only when there is
no usable content (→ V2 fallback). `generateStructured` runs the full ladder for every
meeting-note LLM call (chunk atoms, follow-up): primary call → JSON extract → validate →
**one** repair retry (resends the bad output + errors) → deterministic fallback. Provider-
native JSON mode is intentionally not relied upon — the ladder guarantees validity across
all providers (Gemini/Groq/OpenAI/OpenRouter/Ollama/custom).

## 5. Follow-up drafts
`FollowUpDraftGenerator` maps mode → draft type (sales/recruiting/looking-for-work → email,
team-meet → project_update, technical-interview → interview_feedback, lecture → study_notes),
builds an LLM prompt from **note content only** (overview + decisions + actions + questions,
never transcript), tone-controlled, returning a `FollowUpDraft {type, subject?, body, tone,
basedOn*Ids}`. Deterministic fallback on LLM failure/scope-deny. UI offers copy, regenerate,
and a tone selector.

## 6. Speaker labels / diarization
STT emits no diarization today (two-channel capture: mic→`me`, system→`speaker_1`).
`SpeakerLabelService` derives canonical ids, stores a per-meeting rename map in
`summary_json.speakerLabels` (no migration), applies labels to transcript for regeneration,
and resolves display names in transcript + evidence. UI: rename + apply-to-all.
`docs/speaker-diarization-plan.md` documents the provider-diarization path for later.

## 7. Mode detection
`MeetingModeDetector` scores keyword signals (opening window weighted 2×) + calendar title →
`{templateType, confidence}`. Stored in `summary.mode.detected*`; never switches the live
mode. UI suggests "Regenerate as <detected>" on a confident mismatch.

## 8. UI changes
Skim-first V3 layout, all sections evidence-aware (toggle + click-to-jump), empty sections
hidden, copy/regenerate/export surfaced, legacy summaries still render via the V2 path.

## 9. Tests
- `electron/services/meeting/__tests__/MeetingSummaryPipeline.test.mjs` — 10 (reducer/chunker/validator pipeline; followUp assertion updated to the new generator).
- `electron/services/meeting/__tests__/MeetingNotesV3.test.mjs` — 29 (schema validate/repair, legacy back-compat, strategy selector, mode detector, speaker labels, cross-meeting recall, generateStructured ladder, bad-JSON, follow-up fallback+LLM, long-transcript coverage/segmentId).
- `npm run test:meeting-notes` → **39/39 pass**.
- `electron/services/__tests__/{SaveMeetingIdempotency,MeetingPersistenceRace}.test.mjs` (electron runner) → **5/5 pass**.
- `PostCallWorkflow.test.mjs` → **8/8 pass**.

## 10. Test results / build
- `npm run typecheck:electron` ✅
- frontend `tsc --noEmit` ✅ (0 errors)
- `npm run build:electron` ✅
- meeting-notes + DB + post-call suites green.

## 11. Code review
A `code-reviewer` agent pass found 1 CRITICAL (false positive — `ModesManager.getNoteSections`
**does** exist, line 452; regenerate is correct), 2 HIGH, 4 MEDIUM, 4 LOW. Fixed: empty-atom
drop accounting (HIGH), `actionItemsV3 || actionItemsStructured` fallback in follow-up
regenerate (MED), `updateSpeakerLabels` no longer fabricates an empty stub (MED), double
sanitize call removed (LOW), cross-meeting filter type-narrowed + null-guarded (LOW). HIGH #2
(title path payload) is pre-existing uncommitted behavior and is independently scope-gated
inside `LLMHelper.generateMeetingSummary`. Privacy, backward-compat, no-throw validation,
bounded repair, and UI-non-blocking all verified clean.

## 12. Privacy
`post_call_summary` scope gates every cloud LLM path (chunk, follow-up, regenerate, title).
Reference-file bodies never enter prompts. Telemetry carries only counts/durations/status/
strategy/coverage%/model — never raw transcript or note text. Evidence quotes are stored
locally only. Speaker labels and cross-meeting recall are local-first.

## 13. Known limitations
- Provider-native JSON mode not implemented (ladder makes it unnecessary; reserved flag off).
- Long-context single-pass degrades to map_reduce (documented; selector hint recorded).
- Reducer dedup is deterministic word-overlap, not semantic.
- True per-utterance diarization within the remote channel awaits a diarizing STT provider.
- Cross-meeting recall is keyword-overlap and local-only; Hindsight deep recall remains optional.
- Live end-to-end LLM quality depends on provider output; tests validate deterministic pipeline
  behavior + schema invariants (no live-Gemini eval run this pass).

## 14. Remaining work to fully outperform Granola/Otter/Fireflies
1. Live-Gemini end-to-end quality eval + golden before/after corpus.
2. Provider diarization (Deepgram `diarize`) → real multi-speaker remote labels.
3. Semantic dedup in the reducer (embedding similarity).
4. Cross-meeting "decision changed since last time" diffing.
5. Inline note editing for V3 sections (currently V2-only editable blocks).
6. Searchable evidence index across meetings.
