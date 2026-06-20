// MeetingSummarySchemaValidator.ts
// JSON extraction + chunk-atom validation. Full MeetingSummaryV3 validation now lives in
// MeetingSummaryV3.validateMeetingSummaryV3 — this class delegates to it for back-compat
// so existing callers keep working.

import type { ChunkMeetingAtoms } from './types';
import {
  cleanString,
  cleanNoteText,
  sanitizeStringArray,
  sanitizeDecisions,
  sanitizeActions,
  sanitizeQuestions,
  sanitizeRisks,
  sanitizeEvidenceArray,
  validateMeetingSummaryV3,
  type MeetingSummaryV3,
} from './MeetingSummaryV3';

export class MeetingSummarySchemaValidator {
  parseJsonObject<T = any>(raw: string): T | null {
    const text = String(raw || '').trim();
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = (fenced?.[1] || text).trim();
    try {
      return JSON.parse(candidate) as T;
    } catch {
      const first = candidate.indexOf('{');
      const last = candidate.lastIndexOf('}');
      if (first >= 0 && last > first) {
        try { return JSON.parse(candidate.slice(first, last + 1)) as T; } catch { /* fall through */ }
      }
      return null;
    }
  }

  validateAndRepairAtoms(value: unknown, fallbackChunkIndex: number): ChunkMeetingAtoms | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as any;
    // Accept both new (timeRange.startMs/endMs) and legacy (start/end) keys.
    const startMs = num(raw.timeRange?.startMs) ?? num(raw.timeRange?.start);
    const endMs = num(raw.timeRange?.endMs) ?? num(raw.timeRange?.end);
    const atoms: ChunkMeetingAtoms = {
      chunkIndex: Number.isFinite(Number(raw.chunkIndex)) ? Number(raw.chunkIndex) : fallbackChunkIndex,
      timeRange: {
        ...(startMs !== undefined ? { startMs } : {}),
        ...(endMs !== undefined ? { endMs } : {}),
      },
      brief: cleanNoteText(raw.brief, 500),
      topics: sanitizeStringArray(raw.topics, 20),
      decisions: sanitizeDecisions(raw.decisions, 20),
      actionItems: sanitizeActions(raw.actionItems, 20),
      openQuestions: sanitizeQuestions(raw.openQuestions, 20),
      risks: sanitizeRisks(raw.risks, 20),
      deadlines: sanitizeActions(raw.deadlines, 20),
      people: Array.isArray(raw.people)
        ? raw.people.map((p: any) => ({
            name: cleanString(p?.name),
            ...(p?.role ? { role: cleanString(p.role) } : {}),
            ...(p?.organization ? { organization: cleanString(p.organization) } : {}),
            ...(Number.isFinite(Number(p?.mentions)) ? { mentions: Number(p.mentions) } : {}),
          })).filter((p: any) => p.name).slice(0, 20)
        : [],
      importantQuotes: sanitizeEvidenceArray(raw.importantQuotes, 12),
      modeSpecificFindings: sanitizeFindings(raw.modeSpecificFindings),
      sourceQualityWarnings: sanitizeStringArray(raw.sourceQualityWarnings, 12),
    };
    return atoms;
  }

  validateAndRepairSummary(value: unknown): MeetingSummaryV3 | null {
    const res = validateMeetingSummaryV3(value);
    return res.ok && res.data ? res.data : null;
  }
}

function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function sanitizeFindings(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [key, items] of Object.entries(value as Record<string, unknown>)) {
    const title = cleanString(key).slice(0, 80);
    const bullets = sanitizeStringArray(items, 20);
    if (title && bullets.length) out[title] = bullets;
  }
  return out;
}
