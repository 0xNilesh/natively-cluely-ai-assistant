/**
 * Content script — runs IN the page, injected on demand by the service worker
 * via `chrome.scripting.executeScript({ files: ['content-script.js'] })`.
 *
 * SECURITY: this script runs in an untrusted page context, so it NEVER receives
 * the pairing token and NEVER talks to the loopback server. Its only job is:
 *   page DOM  -->  extractPageContent()  -->  reply with clean text.
 * The service worker owns the token and performs the actual POST to /dom.
 *
 * It bundles Mozilla Readability (MIT) and exposes a single message handler.
 * `executeScript` re-injects this file on every capture; guarding the listener
 * registration keeps repeated injections from stacking duplicate handlers.
 */
import { Readability } from '@mozilla/readability';
import { extractPageContent, type ExtractResult } from './extract';
import { smartCapture, type SmartCaptureResult } from './capture/smart-capture';
import type { CaptureMode } from './capture/types';

export type CaptureRequest =
  | { type: 'natively:extract' }
  // Smart Browser Context v2: classify + structured-extract in one round-trip.
  // `mode` lets the SW distinguish manual vs auto captures for the envelope.
  // `fullPage` (experimental) attaches the full readable text of any non-sensitive
  // page in auto mode — sensitive pages are still hard-blocked downstream.
  | { type: 'natively:smart-extract'; contextId: string; capturedAt: number; mode?: CaptureMode; fullPage?: boolean };
export type CaptureResponse =
  | { ok: true; result: ExtractResult }
  | { ok: true; smart: SmartCaptureResult }
  | { ok: false; error: string };

const GUARD = '__natively_capture_listener__';

function pageSelection(): string {
  try {
    return window.getSelection()?.toString() ?? '';
  } catch {
    return '';
  }
}

function runExtraction(): ExtractResult {
  return extractPageContent({
    document,
    readabilityFactory: (doc) => new Readability(doc),
    getSelection: pageSelection,
  });
}

function runSmartCapture(contextId: string, capturedAt: number, mode: CaptureMode, fullPage = false): SmartCaptureResult {
  return smartCapture({
    document,
    host: location.hostname,
    url: location.href,
    title: document.title,
    getSelection: pageSelection,
    readabilityFactory: (doc) => new Readability(doc),
    contextId,
    capturedAt,
    captureMode: mode,
    // Auto captures (pre-answer pull) only extract auto-eligible coding pages;
    // a manual capture extracts whatever the user is on.
    autoEligibleOnly: mode === 'auto',
    // EXPERIMENTAL: relax the coding-only auto gate and capture the full page
    // text for any non-sensitive page. Sensitive pages stay blocked.
    fullPageMode: fullPage,
  });
}

const w = window as unknown as Record<string, unknown>;
if (!w[GUARD]) {
  w[GUARD] = true;
  chrome.runtime.onMessage.addListener(
    (message: CaptureRequest, _sender, sendResponse: (r: CaptureResponse) => void) => {
      if (!message) return undefined;
      try {
        if (message.type === 'natively:extract') {
          sendResponse({ ok: true, result: runExtraction() });
          return undefined;
        }
        if (message.type === 'natively:smart-extract') {
          const smart = runSmartCapture(
            message.contextId,
            message.capturedAt,
            message.mode || 'auto',
            message.fullPage === true,
          );
          sendResponse({ ok: true, smart });
          return undefined;
        }
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
      return undefined;
    },
  );
}
