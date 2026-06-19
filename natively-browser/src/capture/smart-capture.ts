/**
 * Smart Browser Context v2 — in-page smart capture orchestrator.
 *
 * Runs IN the page (content script) at capture/answer time. Pipeline:
 *   1. gather coarse boolean page signals (just-in-time),
 *   2. classify the tab locally (registry + scorer + sensitive floor),
 *   3. if blocked → return nothing,
 *   4. otherwise run the structured extractor → { envelope, dom }.
 *
 * Everything is dependency-injected (document, registry, selection,
 * readabilityFactory, contextId, capturedAt) so it unit-tests under node --test.
 * No eval, no remote code, no background execution.
 */

import { DEFAULT_REGISTRY, findPlatform, normalizeHost } from './registry/registry';
import type { CaptureRegistry } from './registry/registry-types';
import { classifyTab } from './classifier/tab-classifier';
import { gatherPageSignals } from './page-signals';
import { runExtractor } from './extractors';
import type { CaptureMode, ContextEnvelope, TabCandidate } from './types';

export interface SmartCaptureDeps {
  document: Document;
  host: string;
  url: string;
  title?: string;
  getSelection?: () => string;
  readabilityFactory?: (doc: Document) => { parse(): { title?: string | null; textContent?: string | null } | null };
  contextId: string;
  capturedAt: number;
  captureMode: CaptureMode;
  registry?: CaptureRegistry;
  /**
   * Auto-capture path: classify first and ONLY run the (heavier) structured
   * extractor when the local policy permits auto-attach. This keeps the
   * "capture page content only when it will be used" guarantee — a normal
   * non-coding page during a meeting answer is classified (cheap) and skipped
   * without ever extracting its body. Manual captures leave this false.
   */
  autoEligibleOnly?: boolean;
  /**
   * EXPERIMENTAL full-page mode: when true, the auto path does NOT apply the
   * coding-only `autoEligibleOnly` skip — every non-sensitive page is extracted
   * (full readable text) so the answer model can take what it needs. This relaxes
   * ONLY the coding-only gate; the sensitive blocked-floor return runs first and
   * is never bypassed.
   */
  fullPageMode?: boolean;
}

/** Policies that may auto-attach without an explicit user action. */
const AUTO_ELIGIBLE = new Set(['auto', 'auto_if_high_confidence']);

export interface SmartCaptureResult {
  /** Local classification of the page. */
  candidate: TabCandidate;
  /** Structured capture (null for blocked/sensitive pages). */
  envelope: ContextEnvelope | null;
  /** Legacy plain-string DOM ('' for blocked). */
  dom: string;
  /** True when the page was blocked (sensitive) and nothing was captured. */
  blocked: boolean;
}

/** A short, lowercased visible-text sample for keyword signals (not transmitted). */
function visibleSample(doc: Document, cap = 4000): string {
  try {
    const body = doc.body;
    const t = (body as { innerText?: string } | null)?.innerText ?? body?.textContent ?? '';
    return t.slice(0, cap);
  } catch {
    return '';
  }
}

/**
 * Run the full in-page smart capture. The caller (content script) supplies the
 * real document + selection; tests supply fakes.
 */
export function smartCapture(deps: SmartCaptureDeps): SmartCaptureResult {
  const registry = deps.registry ?? DEFAULT_REGISTRY;
  const host = normalizeHost(deps.host);
  const url = deps.url || '';
  const selection = (deps.getSelection?.() || '').trim();

  const signals = gatherPageSignals(deps.document, selection, visibleSample(deps.document));

  const candidate = classifyTab({
    registry,
    host,
    url,
    title: deps.title ?? deps.document.title,
    signals,
  });
  // Stamp the candidate with the host/url it was built from (classifyTab uses -1
  // tabId; the service worker fills the real tabId/lastSeenAt on its side).
  candidate.url = url;
  candidate.host = host;

  if (candidate.autoPolicy === 'blocked') {
    return { candidate, envelope: null, dom: '', blocked: true };
  }

  // Auto path: skip extraction entirely for non-auto-eligible pages so we never
  // read a non-coding page's body just to discard it. Manual captures extract
  // regardless (the user explicitly asked). EXPERIMENTAL full-page mode also
  // extracts every (non-sensitive) page — the sensitive floor above already ran.
  if (deps.autoEligibleOnly && !deps.fullPageMode && !AUTO_ELIGIBLE.has(candidate.autoPolicy)) {
    return { candidate, envelope: null, dom: '', blocked: false };
  }

  const platform = findPlatform(registry, host, url);
  const { envelope, dom } = runExtractor({
    document: deps.document,
    getSelection: deps.getSelection,
    readabilityFactory: deps.readabilityFactory,
    contextId: deps.contextId,
    capturedAt: deps.capturedAt,
    candidate,
    platform,
    captureMode: deps.captureMode,
    // Full-page mode upgrades the unknown-category `selectionOnly` extractor to
    // the full-text article extractor so the model sees the whole page.
    fullPage: deps.fullPageMode,
  });

  return { candidate, envelope, dom, blocked: false };
}
