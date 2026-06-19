/**
 * Smart Browser Context v2 — local tab classifier.
 *
 * Combines the registry, the additive signal scorer, and the sensitive-page
 * detector into a single TabCandidate. Pure + dependency-injected: it takes a
 * host/url/title and an optional bag of just-in-time page signals; it never
 * reads the DOM or the network itself, and the BACKGROUND path passes only
 * metadata (no signals), so no page body is ever read in the background.
 *
 * It also builds the SafeWebsiteMetadata that — and only that — is what the
 * desktop AI metadata classifier receives (coarse tokens, host, boolean signals;
 * never raw body/code/screenshots or raw private URLs).
 */

import type {
  AutoPolicy,
  BrowserContextCategory,
  SafeWebsiteMetadata,
  TabCandidate,
} from '../types';
import type { CaptureRegistry } from '../registry/registry-types';
import { findCategory, findCategoryByHostUrl, findPlatform, normalizeHost } from '../registry/registry';
import { detectSensitive, type PageSignals } from './sensitive-page-detector';
import { scoreSignals, type ScoreSignals } from './signal-scorer';

/** Coding categories that are eligible to AUTO-attach when high-confidence. */
const CODING_CATEGORIES: ReadonlySet<BrowserContextCategory> = new Set([
  'coding_problem',
  'coding_editor',
  'interview_assessment',
]);

/** Restrictiveness order; the final policy is the most-restrictive of inputs. */
const POLICY_RANK: Record<AutoPolicy, number> = {
  auto: 0,
  auto_if_high_confidence: 1,
  ask: 2,
  manual: 3,
  blocked: 4,
};

function moreRestrictive(a: AutoPolicy, b: AutoPolicy): AutoPolicy {
  return POLICY_RANK[a] >= POLICY_RANK[b] ? a : b;
}

/** URL path tokens that indicate a coding problem/assessment page. */
const PROBLEM_URL_TOKENS = ['/problem', '/problems', '/challenge', '/assessment', '/contest', '/kata', '/task'];
/** Title keywords that indicate a coding/interview problem. */
const PROBLEM_TITLE_KEYWORDS = ['problem', 'coding', 'interview', 'challenge', 'assessment', 'kata', 'leetcode', 'hackerrank'];

/* ──────────────────────────── tokenizer ───────────────────────────── */

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'www', 'com', 'http', 'https']);

/** Split a string into coarse lowercase word tokens (≥2 chars, deduped, capped). */
export function tokenize(input: string | undefined, cap = 24): string[] {
  if (!input) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= cap) break;
  }
  return out;
}

/** Best-effort path extraction from a URL string (never throws). */
export function pathOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).pathname || '';
  } catch {
    // Fall back to a manual slice after the host.
    const m = url.match(/^[a-z]+:\/\/[^/]+(\/[^?#]*)/i);
    return m ? m[1] : '';
  }
}

/** Lightweight non-cryptographic host hash (djb2) for cache-keying continuity. */
export function hashHost(host: string): string {
  let h = 5381;
  for (let i = 0; i < host.length; i++) h = ((h << 5) + h + host.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// A path segment is redacted when it looks like an opaque identifier or PII —
// keeping descriptive slugs (problems, two-sum, challenge) but dropping the
// genuinely-sensitive bits so the sanitized URL is safe to show the AI.
//
// Keep this redaction logic IDENTICAL to reSanitizeUrl() in
// electron/services/browser-context/BrowserMetadataClassifierService.ts — they
// are the extension-primary + desktop-defense-in-depth copies of the same guard.
// A parity test feeds the same fixtures through both and asserts equal output.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_NUMERIC_RE = /^\d{6,}$/; // long numeric ids
// JWT-shaped segment: base64url.base64url.base64url (a token embedded in one
// path part). The `.` keeps it out of OPAQUE_RUN_RE, so match it explicitly.
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
// A single continuous 20+ char run of token chars WITH NO `-`/`_` separator:
// session ids, API keys, hashes, base64 blobs. A descriptive slug like
// `longest-substring-without-repeating` is hyphen-separated words, so it is NOT a
// continuous run and survives. An all-letter or mixed continuous run of this
// length is opaque, not a word — redact it. (No digit requirement, fixing the
// review gap where all-alpha tokens slipped through.)
const OPAQUE_RUN_RE = /^[A-Za-z0-9]{20,}$/;
// Looks like a slug: hyphen/underscore-separated lowercase-ish words. Kept verbatim.
const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i;
function redactSegment(seg: string): string {
  if (!seg) return seg;
  if (seg.includes('@') && seg.includes('.')) return ':email';
  if (UUID_RE.test(seg)) return ':id';
  if (LONG_NUMERIC_RE.test(seg)) return ':id';
  if (JWT_RE.test(seg)) return ':token';
  // A long CONTINUOUS run (no word separators) is an opaque token; a hyphen/
  // underscore slug of the same length is descriptive and kept.
  if (OPAQUE_RUN_RE.test(seg) && !SLUG_RE.test(seg)) return ':token';
  return seg;
}

/**
 * Produce a privacy-safe URL for the AI classifier: `scheme://host/path` only.
 * The query string and fragment are dropped entirely (that's where session
 * tokens / candidate PII live), and path segments that look like secrets (UUIDs,
 * emails, long opaque tokens, long numeric ids) are redacted. This gives the
 * model near-full site recognition (host + descriptive path) without ever
 * exposing the sensitive parts of an unknown page's URL. Returns '' on bad input.
 */
export function sanitizeUrl(url: string | undefined): string {
  if (!url) return '';
  let scheme = 'https';
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    scheme = (u.protocol || 'https:').replace(/:$/, '');
    host = u.hostname.replace(/^www\./, '');
    path = u.pathname || '';
  } catch {
    const m = url.match(/^([a-z]+):\/\/([^/?#]+)([^?#]*)/i);
    if (!m) return '';
    scheme = m[1];
    host = m[2].replace(/^www\./, '');
    path = m[3] || '';
  }
  if (!host) return '';
  if (scheme !== 'http' && scheme !== 'https') scheme = 'https';
  const cleanPath =
    path
      .split('/')
      .map(redactSegment)
      .join('/')
      .replace(/\/{2,}/g, '/') || '';
  return `${scheme}://${host}${cleanPath}`;
}

/* ─────────────────────── safe metadata builder ─────────────────────── */

export interface ClassifyInput {
  registry: CaptureRegistry;
  host: string;
  url: string;
  title?: string;
  metaDescription?: string;
  h1Text?: string;
  /** Just-in-time page signals; OMIT in the background (metadata-only) path. */
  signals?: PageSignals & {
    codeEditorPresent?: boolean;
    ioConstraintSignals?: boolean;
    runSubmitSignals?: boolean;
    hasSelection?: boolean;
  };
}

/**
 * Build the sanitized metadata bundle that may be sent to the AI classifier.
 * Contains coarse tokens + host + boolean signals only — no raw page body, code,
 * screenshots, or raw private URLs.
 */
export function buildSafeMetadata(input: ClassifyInput): SafeWebsiteMetadata {
  const host = normalizeHost(input.host);
  const platform = findPlatform(input.registry, host, input.url);
  const sig = input.signals ?? {};
  const sensitive = detectSensitive(input.registry, host, input.url, sig);
  const tld = host.includes('.') ? host.slice(host.lastIndexOf('.') + 1) : undefined;

  const titleTokens = tokenize(input.title);
  return {
    host,
    hostHash: host ? hashHost(host) : undefined,
    tld,
    sanitizedUrl: sanitizeUrl(input.url) || undefined,
    pathTokens: tokenize(pathOf(input.url)),
    titleTokens,
    metaDescriptionTokens: input.metaDescription ? tokenize(input.metaDescription) : undefined,
    h1Tokens: input.h1Text ? tokenize(input.h1Text) : undefined,
    knownPlatformMatch: platform?.id,
    hasCodeEditorSignal: Boolean(sig.codeEditorPresent),
    hasProblemKeywordSignal: titleTokens.some((t) => PROBLEM_TITLE_KEYWORDS.includes(t)),
    hasLoginOrPaymentSignal: Boolean(sig.hasPasswordField || sig.hasCardInput || sig.hasPaymentWords || sig.hasLoginForm),
    hasSensitiveSignals: sensitive.sensitive,
  };
}

/* ────────────────────────── tab classifier ────────────────────────── */

/**
 * Classify a tab into a TabCandidate using the registry + scorer + sensitive
 * detector. With no `signals` (background path) it scores from metadata only.
 */
export function classifyTab(input: ClassifyInput): TabCandidate {
  const host = normalizeHost(input.host);
  const url = input.url || '';
  const title = input.title || '';
  const sig = input.signals ?? {};
  const reasons: string[] = [];

  // 1. Sensitive floor — wins outright.
  const sensitive = detectSensitive(input.registry, host, url, sig);
  if (sensitive.sensitive) {
    return {
      tabId: -1,
      title,
      url,
      host,
      pathTokens: tokenize(pathOf(url)),
      matchedCategory: sensitive.category,
      confidenceScore: 0,
      autoPolicy: 'blocked',
      lastSeenAt: 0,
      reasons: ['sensitive page → blocked', ...sensitive.reasons],
    };
  }

  // 2. Registry platform → category. When no specific platform matches, fall
  // back to a category rule keyed by host/URL (covers job_description /
  // developer_docs pages on generic hosts, e.g. linkedin.com/jobs).
  const platform = findPlatform(input.registry, host, url);
  let category: BrowserContextCategory = platform?.category ?? 'unknown';
  if (platform) {
    reasons.push(`platform: ${platform.id} (${category})`);
  } else {
    const catRule = findCategoryByHostUrl(input.registry, host, url);
    if (catRule) {
      category = catRule.id;
      reasons.push(`category rule: ${catRule.id}`);
    }
  }

  // 3. Build score signals from metadata + optional JIT page signals.
  const titleLower = title.toLowerCase();
  const scoreSig: ScoreSignals = {
    knownCodingHost: Boolean(platform) && CODING_CATEGORIES.has(category),
    problemUrlToken: PROBLEM_URL_TOKENS.some((t) => url.toLowerCase().includes(t)),
    problemKeywordInTitle: PROBLEM_TITLE_KEYWORDS.some((k) => titleLower.includes(k)),
    ioConstraintSignals: Boolean(sig.ioConstraintSignals),
    codeEditorPresent: Boolean(sig.codeEditorPresent),
    runSubmitSignals: Boolean(sig.runSubmitSignals),
    hasSelection: Boolean(sig.hasSelection),
    blockedHost: false,
    passwordField: Boolean(sig.hasPasswordField),
    paymentWords: Boolean(sig.hasPaymentWords),
    loginPage: Boolean(sig.hasLoginForm),
  };
  const scored = scoreSignals(scoreSig, false);
  reasons.push(...scored.reasons);

  // 4. Band → policy, then constrain by category.
  const bandPolicy: AutoPolicy =
    scored.band === 'auto' ? 'auto'
      : scored.band === 'ask' ? 'ask'
        : scored.band === 'blocked' ? 'blocked'
          : 'manual';

  // The registry category rule is the policy ceiling for known categories; an
  // unknown page can never auto-attach locally (it must go through the AI
  // classifier), so its floor is 'ask'.
  const categoryRule = findCategory(input.registry, category);
  const categoryPolicy: AutoPolicy =
    category === 'unknown' ? 'ask' : (categoryRule?.autoPolicy ?? 'manual');

  // Only coding/interview categories may actually AUTO-attach; otherwise the
  // band's 'auto' is downgraded to 'ask'.
  let finalPolicy = moreRestrictive(bandPolicy, categoryPolicy);
  if ((finalPolicy === 'auto' || finalPolicy === 'auto_if_high_confidence') && !CODING_CATEGORIES.has(category)) {
    finalPolicy = 'ask';
    reasons.push('non-coding category cannot auto-attach → ask');
  }

  return {
    tabId: -1,
    title,
    url,
    host,
    pathTokens: tokenize(pathOf(url)),
    matchedCategory: category,
    matchedPlatform: platform?.id,
    confidenceScore: scored.score,
    autoPolicy: finalPolicy,
    lastSeenAt: 0,
    reasons,
  };
}
