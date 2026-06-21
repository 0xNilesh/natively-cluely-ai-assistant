import { AlertTriangle, Brain, Check, ChevronDown, Loader2, Wifi, WifiOff } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

// Label + one-line description + group + TIER for each Intelligence OS flag. Keyed by flag
// key; an unknown key falls back to the raw key so a newly-added flag still renders.
//
// `tier` drives how much the user sees by default (so a non-technical job candidate isn't
// confronted with ~15 switches):
//   • 'core'     → bundled under the single "Smart features" master switch. These are the
//                  on-device, default-ON quality features the backend already ships live
//                  (see electron/intelligence/intelligenceFlags.ts — only these are both
//                  default:true AND live-wired). The master orchestrates exactly this set;
//                  the per-feature switches still live inside "Customize" for power users.
//   • 'advanced' → real opt-in features with a genuine tradeoff (extra LLM passes, search,
//                  lecture/diagram, full-session memory). Shown only inside "Customize".
//                  NOTE: the Hindsight long-term-memory flags are NOT here — they live in
//                  their own setup card above (privacy + external server), not the flag list.
//   • 'dev'      → shadow / observe-only / inert diagnostics. Hidden behind "Developer
//                  options". No visible effect on answers.
//
// Why not promote profileTreeV2 / answerDiversityGuard / meetingMemoryV2 / etc. into 'core'?
// They're default-OFF in the registry and not yet eval-promoted — the master must only
// orchestrate what actually ships on today, so it stays honest. They sit in 'advanced'.
type FlagTier = 'core' | 'advanced' | 'dev';
const FLAG_META: Record<string, { label: string; desc: string; group: string; tier: FlagTier }> = {
  // ── Core: on-device, default-ON, live-wired → governed by the master switch ──────────
  meetingSummaryV3: { label: 'Better meeting notes', desc: 'Pulls decisions, action items, open questions, and risks into clean notes after a meeting ends.', group: 'Meeting notes', tier: 'core' },
  meetingModeAutoDetect: { label: 'Auto-detect meeting type', desc: 'Detects whether a meeting was a sales call, interview, standup, or lecture, and uses the best notes template.', group: 'Meeting notes', tier: 'core' },
  followUpDraftV2: { label: 'Smart follow-up drafts', desc: 'Writes a short, copy-ready follow-up message from the meeting’s decisions and action items.', group: 'Meeting notes', tier: 'core' },
  speakerLabelsV1: { label: 'Speaker labels', desc: 'Lets you rename speakers (e.g. “John from Client”) and uses those names in notes and action items.', group: 'Meeting notes', tier: 'core' },
  // ── Advanced: real opt-in tradeoffs (cost / scope / niche) → inside "Customize" ──────
  meetingMemoryV2: { label: 'Capture key points', desc: 'Automatically pulls out the topics, decisions, and action items from each meeting so you can recall and search them later.', group: 'Memory', tier: 'advanced' },
  durableMemoryWindow: { label: 'Full-session memory', desc: 'Remembers everything said earlier in your session, not just the last few exchanges — useful for long interviews or lectures.', group: 'Memory', tier: 'advanced' },
  conversationMemoryV2: { label: 'Conversation follow-ups', desc: 'Understands short follow-ups like "make that shorter" by looking back at what was just said.', group: 'Memory', tier: 'advanced' },
  profileTreeV2: { label: 'Stronger candidate voice', desc: 'Keeps answers sounding like you — first person, your own experience, no generic AI phrasing.', group: 'Answer quality', tier: 'advanced' },
  answerDiversityGuard: { label: 'Polished phrasing', desc: 'Reduces repeated or templated wording so answers sound more natural.', group: 'Answer quality', tier: 'advanced' },
  globalSearchV2: { label: 'Search past meetings', desc: 'Search by keyword across all your saved meetings and jump to relevant moments.', group: 'Search', tier: 'advanced' },
  inMeetingSearchV2: { label: 'Search current meeting', desc: 'Search the live transcript of the meeting you’re in, with timestamps.', group: 'Search', tier: 'advanced' },
  lectureIntelligenceV2: { label: 'Lecture notes', desc: 'Turns a lecture into structured notes, flashcards, and practice questions.', group: 'Lecture & diagrams', tier: 'advanced' },
  diagramIntelligence: { label: 'Diagrams', desc: 'Draws a diagram to explain a concept during a lecture.', group: 'Lecture & diagrams', tier: 'advanced' },
  // ── Developer options: shadow / observe-only / inert → "Developer options" disclosure ─
  trace: { label: 'Diagnostics trace', desc: 'Records a per-answer routing trace (no transcript content). For troubleshooting only.', group: 'Developer options', tier: 'dev' },
  contextRouterV2: { label: 'Next-gen routing (preview)', desc: 'Evaluates a new routing engine in the background. No visible effect on answers yet.', group: 'Developer options', tier: 'dev' },
  liveTranscriptBrain: { label: 'Live context engine (preview)', desc: 'Evaluates a new live-transcript engine in the background. No visible effect on answers yet.', group: 'Developer options', tier: 'dev' },
  promptAssemblerV2: { label: 'Improved prompt builder (preview)', desc: 'Evaluates a new prompt builder in the background. No visible effect on answers yet.', group: 'Developer options', tier: 'dev' },
  intelligenceOsEnabled: { label: 'Intelligence OS (reserved)', desc: 'Reserved flag with no effect on its own — toggle the specific features instead.', group: 'Developer options', tier: 'dev' },
};

// The Hindsight long-term-memory flags are rendered by the dedicated setup card above (not
// the generic flag list), so they're intentionally absent from FLAG_META. List them here so
// the grouping logic can skip them rather than dump them into an "unknown" bucket.
const HINDSIGHT_FLAG_KEYS = new Set(['hindsightMemory', 'hindsightPostMeetingRetain', 'hindsightLiveRecall']);

// Order for the per-group rendering inside the "Customize" disclosure (advanced tier).
const ADVANCED_GROUP_ORDER = ['Memory', 'Answer quality', 'Search', 'Lecture & diagrams'];

// Single source of truth for what the master "Smart features" switch controls: every
// core-tier flag. Derived from FLAG_META so it can't drift.
const CORE_FLAG_KEYS = Object.entries(FLAG_META).filter(([, m]) => m.tier === 'core').map(([k]) => k);

// Map a "Try it" runner to the flag that controls it. The off-state message points the user
// at "Customize" (where these advanced toggles now live), not a top-level group.
const TRY_IT_TOGGLE: Record<'lecture' | 'diagram' | 'search', { flag: string; label: string }> = {
  lecture: { flag: 'lectureIntelligenceV2', label: 'Lecture notes' },
  diagram: { flag: 'diagramIntelligence', label: 'Diagrams' },
  search: { flag: 'inMeetingSearchV2', label: 'Search current meeting' },
};

interface FlagRow { key: string; enabled: boolean; setting: string; env: string; default: boolean }

// One feature row: label + plain-language description + its toggle. Shared by the
// user-facing groups and the collapsed developer group.
const FlagRowView: React.FC<{ row: FlagRow; onToggle: (row: FlagRow) => void }> = ({ row, onToggle }) => {
  const meta = FLAG_META[row.key];
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-bg-item-active">
      <div className="min-w-0">
        <div className="text-xs font-medium text-text-primary">{meta?.label || row.key}</div>
        {meta?.desc ? <div className="mt-0.5 text-[11px] leading-relaxed text-text-secondary">{meta.desc}</div> : null}
      </div>
      <Toggle on={row.enabled} onClick={() => onToggle(row)} />
    </div>
  );
};
// The "Try it" output. Fades and slides up as a result lands instead of popping into place;
// keyed by content so a fresh run re-animates. Reduced motion → it simply appears.
const TryResult: React.FC<{ out: { kind: string; text: string } | null }> = ({ out }) => {
  const reduce = useReducedMotion();
  if (!out) return null;
  const pre = (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-bg-main p-3 font-mono text-[11px] leading-relaxed text-text-secondary">{out.text}</pre>
  );
  if (reduce) return pre;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={out.text}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      >
        {pre}
      </motion.div>
    </AnimatePresence>
  );
};

interface HindsightCfg { baseUrl: string; hasApiKey: boolean; autoStart: boolean; serverCommand: string; llmProvider: string; available: boolean }

// Render a millisecond transcript offset as m:ss (e.g. 83400 → "1:23").
const formatStamp = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const Toggle: React.FC<{ on: boolean; disabled?: boolean; onClick: () => void }> = ({ on, disabled, onClick }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    aria-pressed={on}
    className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${on ? 'bg-accent-primary' : 'bg-bg-toggle-switch border border-border-muted'} ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
  >
    <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-spring motion-reduce:transition-none ${on ? 'translate-x-5' : 'translate-x-0'}`} />
  </button>
);

// Smooth height+opacity expand/collapse for the disclosures (Set up / Customize / Developer
// options), matching the HelpSettings AccordionSection idiom. Height-auto is measured by
// framer-motion; under prefers-reduced-motion we drop the height/opacity tween so nothing
// slides or reflows — the content just appears.
const Disclosure: React.FC<{ open: boolean; children: React.ReactNode }> = ({ open, children }) => {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="disclosure"
          initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          style={{ overflow: 'hidden' }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};

// A chevron that rotates between collapsed (▸) and expanded (▾) instead of swapping glyphs,
// so the disclosure indicator turns smoothly with the panel.
const DisclosureChevron: React.FC<{ open: boolean }> = ({ open }) => (
  <ChevronDown size={14} className={`shrink-0 transition-transform duration-200 ease-apple-ease motion-reduce:transition-none ${open ? 'rotate-0' : '-rotate-90'}`} />
);

// One-shot fade-up for a row as it first mounts, with a short per-index delay so the core
// feature rows cascade in when "Customize" opens — reinforcing that these are the switches the
// master fans out to. Only the initial mount animates; flipping a toggle later mutates the
// child's props (the element persists), so this never replays on click. Reduced motion → no-op.
const StaggerRow: React.FC<{ index: number; children: React.ReactNode }> = ({ index, children }) => {
  const reduce = useReducedMotion();
  if (reduce) return <>{children}</>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1], delay: Math.min(index, 5) * 0.04 }}
    >
      {children}
    </motion.div>
  );
};

// Connection status pill with four distinct states, so the user can tell "I haven't set
// this up" apart from "I set it up but it's offline" — the old single chip showed the same
// "Not running" for both. The unreachable state offers an inline Retry.
type ConnStatus = 'not-configured' | 'checking' | 'connected' | 'unreachable';
const StatusChip: React.FC<{ status: ConnStatus; testing: boolean; onRetry: () => void }> = ({ status, testing, onRetry }) => {
  const reduce = useReducedMotion();
  // Resolve the chip to a single keyed visual state. The 4-state derivation (status + testing)
  // is unchanged — only the presentation is keyed so AnimatePresence can transition between
  // states instead of hard-swapping them.
  const visual: ConnStatus = status === 'connected' ? 'connected' : (status === 'checking' || testing) ? 'checking' : status;

  let body: React.ReactNode;
  if (visual === 'connected') {
    body = (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/15 px-2.5 py-0.5 text-[11px] font-medium text-green-400">
        <Wifi size={12} /> Connected
      </span>
    );
  } else if (visual === 'checking') {
    body = (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle bg-bg-input px-2.5 py-0.5 text-[11px] font-medium text-text-secondary">
        <Loader2 size={12} className="animate-spin" /> Checking…
      </span>
    );
  } else if (visual === 'unreachable') {
    body = (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-400">
        <WifiOff size={12} /> Can’t connect
        <button type="button" onClick={onRetry} className="ml-0.5 underline hover:no-underline">Retry</button>
      </span>
    );
  } else {
    body = (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle bg-bg-input px-2.5 py-0.5 text-[11px] font-medium text-text-tertiary">
        Not set up
      </span>
    );
  }

  if (reduce) return <div className="shrink-0">{body}</div>;

  // "Connected" pops in with the spring easing (a connection just established earns a little
  // life); the other states cross-fade calmly. mode="wait" so the outgoing chip clears before
  // the incoming one settles — reads as a transition, not a jump.
  const isConnected = visual === 'connected';
  return (
    <div className="relative shrink-0">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={visual}
          initial={{ opacity: 0, scale: isConnected ? 0.85 : 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: isConnected ? 0.26 : 0.16, ease: isConnected ? [0.34, 1.56, 0.64, 1] : [0.25, 1, 0.5, 1] }}
        >
          {body}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};

export const IntelligenceSettings: React.FC = () => {
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [cfg, setCfg] = useState<HindsightCfg | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [autoStart, setAutoStart] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [savedAt, setSavedAt] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [showDev, setShowDev] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const [masterBusy, setMasterBusy] = useState(false);
  // "Try it" feature runners (lecture notes / diagram / in-meeting search). These call the
  // real IPCs against the CURRENT meeting transcript, so they need an active meeting + the
  // matching flag; the handlers return { enabled:false } when the flag is off.
  const [tryBusy, setTryBusy] = useState<null | 'lecture' | 'diagram' | 'search'>(null);
  const [tryOut, setTryOut] = useState<{ kind: string; text: string } | null>(null);
  const [searchQ, setSearchQ] = useState('');

  const flagOn = useCallback((key: string) => flags.find((f) => f.key === key)?.enabled ?? false, [flags]);

  const runTry = useCallback(async (kind: 'lecture' | 'diagram' | 'search', fn: () => Promise<any>) => {
    setTryBusy(kind); setTryOut(null);
    try {
      const res = await fn();
      if (res && res.enabled === false) {
        // Point the user at the EXACT toggle. These advanced toggles live inside the
        // "Customize individual features" disclosure under Smart features.
        const t = TRY_IT_TOGGLE[kind];
        setTryOut({ kind, text: `“${t.label}” is off. Open “Customize individual features” under Smart features, turn it on, then try again.` });
        return;
      }
      // Search returns structured rows — render them as readable timestamped quotes
      // instead of dumping raw JSON at the user.
      if (kind === 'search') {
        const rows: Array<{ snippet?: string; timestampMs?: number; speaker?: string }> = Array.isArray(res?.results) ? res.results : [];
        if (!rows.length) {
          setTryOut({ kind, text: 'No matches — is a meeting active with a transcript?' });
          return;
        }
        const text = rows.slice(0, 20).map((r) => {
          const stamp = typeof r.timestampMs === 'number' ? formatStamp(r.timestampMs) : '—';
          const who = r.speaker ? `${r.speaker}: ` : '';
          return `${stamp}  ${who}${(r.snippet || '').trim()}`;
        }).join('\n');
        setTryOut({ kind, text });
        return;
      }
      const payload = res?.notes ?? res?.diagram ?? res;
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
      setTryOut({ kind, text: text && text !== 'null' ? text : 'No result — is a meeting active with a transcript?' });
    } catch (e: any) {
      setTryOut({ kind, text: `Failed: ${e?.message || 'error'}` });
    } finally { setTryBusy(null); }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [f, c] = await Promise.all([
        window.electronAPI.getIntelligenceFlags?.(),
        window.electronAPI.getHindsightConfig?.(),
      ]);
      if (Array.isArray(f)) setFlags(f);
      if (c) {
        setCfg(c);
        setBaseUrl(c.baseUrl || '');
        setAutoStart(c.autoStart !== false);
        setHealthy(c.available);
      }
    } catch { /* settings panel never throws */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onToggleFlag = useCallback(async (row: FlagRow) => {
    // Optimistic flip; reconcile from the round-trip.
    setFlags((prev) => prev.map((r) => (r.key === row.key ? { ...r, enabled: !r.enabled } : r)));
    try {
      const res = await window.electronAPI.setIntelligenceFlag?.(row.key, !row.enabled);
      if (res && typeof res.enabled === 'boolean') {
        setFlags((prev) => prev.map((r) => (r.key === row.key ? { ...r, enabled: res.enabled! } : r)));
      }
    } catch { await refresh(); }
  }, [refresh]);

  const onSaveHindsight = useCallback(async () => {
    setSaving(true); setSavedAt(false);
    try {
      const res = await window.electronAPI.setHindsightConfig?.({ baseUrl, apiKey, autoStart });
      setApiKey(''); // never keep the raw key in component state after save
      if (res && typeof res.healthy === 'boolean') setHealthy(res.healthy);
      setSavedAt(true);
      setTimeout(() => setSavedAt(false), 2000);
      await refresh();
    } catch { /* noop */ } finally { setSaving(false); }
  }, [baseUrl, apiKey, autoStart, refresh]);

  const onTest = useCallback(async () => {
    setTesting(true);
    try {
      const res = await window.electronAPI.testHindsightConnection?.();
      setHealthy(Boolean(res?.healthy));
    } catch { setHealthy(false); } finally { setTesting(false); }
  }, []);

  // Bucket the flag rows by TIER (not group). Hindsight flags are skipped — they're owned by
  // the setup card above. Within the advanced tier we keep the human group labels so the
  // Customize disclosure stays organized.
  const byTier = useMemo(() => {
    const core: FlagRow[] = [];
    const advancedByGroup: Record<string, FlagRow[]> = {};
    const dev: FlagRow[] = [];
    for (const row of flags) {
      if (HINDSIGHT_FLAG_KEYS.has(row.key)) continue;
      const meta = FLAG_META[row.key];
      const tier: FlagTier = meta?.tier || 'dev'; // unknown/new flags hide in dev until classified
      if (tier === 'core') core.push(row);
      else if (tier === 'dev') dev.push(row);
      else (advancedByGroup[meta?.group || 'Other'] ||= []).push(row);
    }
    return { core, advancedByGroup, dev };
  }, [flags]);

  // Master "Smart features" state, derived (not stored) so it can never lie:
  //   on    → every core flag is on
  //   off   → every core flag is off
  //   mixed → a power user customized one in the disclosure (master shows "Customized")
  const masterState: 'on' | 'off' | 'mixed' = useMemo(() => {
    const vals = byTier.core.map((r) => r.enabled);
    if (!vals.length || vals.every(Boolean)) return 'on';
    if (vals.every((v) => !v)) return 'off';
    return 'mixed';
  }, [byTier.core]);

  // One click fans out to every core flag via the existing per-flag IPC (no backend change).
  // off/mixed → turn all on; on → turn all off. Optimistic, then reconcile from the server.
  const onToggleMaster = useCallback(async () => {
    const next = masterState !== 'on';
    setMasterBusy(true);
    setFlags((prev) => prev.map((r) => (CORE_FLAG_KEYS.includes(r.key) ? { ...r, enabled: next } : r)));
    try {
      await Promise.allSettled(CORE_FLAG_KEYS.map((k) => window.electronAPI.setIntelligenceFlag?.(k, next)));
      await refresh();
    } catch { await refresh(); } finally { setMasterBusy(false); }
  }, [masterState, refresh]);

  // Connection status as a discrete state, so "never set up" reads differently from
  // "set up but unreachable" (the old single chip showed "Not running" for both).
  //   not-configured → no server URL saved yet (the common first-run case)
  //   checking       → a URL exists but health hasn't resolved this load
  //   connected      → last health check passed
  //   unreachable    → a URL exists but the server didn't answer
  const status: 'not-configured' | 'checking' | 'connected' | 'unreachable' = useMemo(() => {
    if (healthy === true) return 'connected';
    if (!baseUrl.trim()) return 'not-configured';
    return healthy === null ? 'checking' : 'unreachable';
  }, [healthy, baseUrl]);

  const openExternal = useCallback((url: string) => {
    try { window.electronAPI.openExternal?.(url); } catch { /* noop */ }
  }, []);

  // A flag is forced by env when a NATIVELY_* env var is set — we can't tell the raw env
  // value from the renderer, but the get payload's `setting` is the SettingsManager key;
  // when present we allow toggling. (Env-forced detection is best-effort: if a future
  // payload exposes an `envForced` field, honor it; for now toggles are always enabled.)

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-2">
        <Brain size={18} className="text-accent-primary" />
        <h2 className="text-base font-semibold text-text-primary">Intelligence</h2>
      </div>

      {/* ── Long-term memory (Hindsight) ─────────────────────────── */}
      <section className="rounded-xl border border-border-subtle bg-bg-item-surface p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-text-primary">Long-term memory</h3>
              <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-400">Beta</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">Remember what was discussed in past meetings and surface it automatically. Needs a free companion app — about 5 minutes to set up.</p>
          </div>
          <StatusChip status={status} onRetry={onTest} testing={testing} />
        </div>

        <button
          type="button"
          onClick={() => setShowSetup((v) => !v)}
          className="text-xs font-medium text-accent-primary transition-colors hover:text-accent-secondary active:scale-[0.98]"
        >
          {showSetup ? 'Hide setup' : (status === 'connected' ? 'Edit setup' : 'Set up long-term memory →')}
        </button>

        <Disclosure open={showSetup}>
          <div className="space-y-3 rounded-lg border border-border-subtle bg-bg-main/40 p-4">
            {/* Step-by-step install — the companion server is a separate app the user installs. */}
            <ol className="space-y-2 text-xs leading-relaxed text-text-secondary">
              <li>
                <span className="font-medium text-text-primary">1. Install the companion app.</span> In your Terminal, run:
                <code className="mt-1 block rounded-md border border-border-subtle bg-bg-main px-2.5 py-2 font-mono text-[11px] text-text-primary">pip install hindsight-all</code>
                Requires Python 3.11 or later. Your AI provider key (from the AI Providers screen) is used automatically — no extra key needed.
              </li>
              <li>
                <span className="font-medium text-text-primary">2. Start it.</span> Keep this running while you use the app:
                <code className="mt-1 block rounded-md border border-border-subtle bg-bg-main px-2.5 py-2 font-mono text-[11px] text-text-primary">hindsight serve --port 8888</code>
              </li>
              <li><span className="font-medium text-text-primary">3. Paste the address below</span> (the local default is already filled in), then press Save.</li>
            </ol>
            <button type="button" onClick={() => openExternal('https://hindsight.vectorize.io/developer/installation')} className="text-[11px] font-medium text-accent-primary transition-colors hover:text-accent-secondary">
              Full setup guide &amp; troubleshooting →
            </button>

            <label className="block space-y-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">Server address</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:8888"
                className="w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary transition-colors focus:outline-none focus:border-accent-primary"
              />
            </label>

            {/* Cloud is the alternative to running local software. The API key here is the
                Hindsight Cloud ACCOUNT key — explicitly NOT the user's AI provider key, which
                already lives in the AI Providers screen and is forwarded automatically. */}
            <label className="block space-y-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                Hindsight Cloud account key <span className="normal-case text-text-tertiary">(not your AI key)</span>
                {cfg?.hasApiKey ? ' — saved, leave blank to keep' : ''}
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={cfg?.hasApiKey ? '••••••••  saved' : 'Only if you use Hindsight Cloud instead of local'}
                className="w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary transition-colors focus:outline-none focus:border-accent-primary"
              />
              <span className="block text-[11px] leading-relaxed text-text-secondary">
                Only needed for Hindsight Cloud. Your AI provider key stays on this device and is used separately.
              </span>
            </label>

            <label className="flex items-center justify-between gap-3">
              <span className="text-xs text-text-primary">
                Start memory server automatically at launch
                <span className="mt-0.5 block text-[11px] leading-relaxed text-text-secondary">Only works after setup is complete. No effect if the companion app isn’t installed.</span>
              </span>
              <Toggle on={autoStart} onClick={() => setAutoStart((v) => !v)} />
            </label>

            {/* Privacy disclosure ABOVE the Save action so it's seen before any data is sent. */}
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-300/90">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-400" />
              <span>Local keeps memory on this device. Choosing Cloud sends meeting summaries to Hindsight’s servers — a privacy trade-off for an otherwise local-first app.</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onSaveHindsight}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-3 py-1.5 text-xs font-medium text-white transition-[opacity,transform] active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100 motion-reduce:active:scale-100"
              >
                <AnimatePresence mode="wait" initial={false}>
                  {saving ? (
                    <motion.span key="saving" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="inline-flex">
                      <Loader2 size={14} className="animate-spin" />
                    </motion.span>
                  ) : savedAt ? (
                    <motion.span key="saved" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.24, ease: [0.34, 1.56, 0.64, 1] }} className="inline-flex">
                      <Check size={14} />
                    </motion.span>
                  ) : null}
                </AnimatePresence>
                {savedAt ? 'Saved' : 'Save'}
              </button>
              <button
                type="button"
                onClick={onTest}
                disabled={testing || !baseUrl.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100 motion-reduce:active:scale-100"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : null}
                Test connection
              </button>
            </div>
          </div>
        </Disclosure>
      </section>

      {/* ── Smart features (master switch + Customize) ───────────── */}
      <section className="space-y-3">
        {/* One low-stakes lever for the normal user: turn the on-device quality features on
            or off. The ~12 granular toggles live behind "Customize" for power users. */}
        <div className="rounded-xl border border-border-subtle bg-bg-item-surface p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Brain size={15} className="shrink-0 text-accent-primary" />
                <div className="text-sm font-semibold text-text-primary">Smart features</div>
              </div>
              <div className="mt-1 text-xs leading-relaxed text-text-secondary">
                Better answers, meeting notes, and follow-ups — all running on your device.
                {masterState === 'mixed' ? <span className="ml-1 font-medium text-accent-primary">Customized.</span> : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <AnimatePresence initial={false}>
                {masterBusy ? (
                  <motion.span
                    key="master-busy"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.15 }}
                    className="inline-flex"
                  >
                    <Loader2 size={14} className="animate-spin text-text-secondary" />
                  </motion.span>
                ) : null}
              </AnimatePresence>
              <Toggle on={masterState !== 'off'} disabled={masterBusy} onClick={onToggleMaster} />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowCustomize((v) => !v)}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent-primary transition-colors hover:text-accent-secondary active:scale-[0.98]"
          >
            <DisclosureChevron open={showCustomize} />
            {showCustomize ? 'Hide individual features' : 'Customize individual features'}
          </button>

          <Disclosure open={showCustomize}>
            <div className="mt-3 space-y-4 border-t border-border-subtle pt-3">
              {/* Core features individually — same switches the master fans out to. */}
              {byTier.core.length ? (
                <div className="space-y-1.5">
                  <div className="px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">Meeting notes</div>
                  {byTier.core.map((row, i) => (
                    <StaggerRow key={row.key} index={i}><FlagRowView row={row} onToggle={onToggleFlag} /></StaggerRow>
                  ))}
                </div>
              ) : null}

              {/* Advanced opt-in features (extra cost / niche / scope tradeoffs). */}
              {ADVANCED_GROUP_ORDER.filter((g) => byTier.advancedByGroup[g]?.length).map((group) => (
                <div key={group} className="space-y-1.5">
                  <div className="px-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">{group}</div>
                  {byTier.advancedByGroup[group].map((row) => (
                    <FlagRowView key={row.key} row={row} onToggle={onToggleFlag} />
                  ))}
                </div>
              ))}

              {/* Developer options — shadow / diagnostics, no visible effect. */}
              {byTier.dev.length ? (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowDev((v) => !v)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary active:scale-[0.98]"
                  >
                    <DisclosureChevron open={showDev} />
                    {showDev ? 'Hide developer options' : 'Developer options (for testing only)'}
                  </button>
                  <Disclosure open={showDev}>
                    <div className="mt-2 space-y-1.5">
                      {byTier.dev.map((row) => (
                        <FlagRowView key={row.key} row={row} onToggle={onToggleFlag} />
                      ))}
                    </div>
                  </Disclosure>
                </div>
              ) : null}
            </div>
          </Disclosure>
        </div>
      </section>

      {/* ── Try it (runs against the current meeting) ────────────── */}
      <section className="rounded-xl border border-border-subtle bg-bg-item-surface p-5 space-y-3">
        <div>
          <div className="text-sm font-semibold text-text-primary">Try it</div>
          <div className="mt-1 text-xs leading-relaxed text-text-secondary">These run on the meeting you’re currently in — not a saved recording. Turn the feature on under “Customize individual features” above, then join an active meeting.</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={tryBusy !== null || !flagOn('lectureIntelligenceV2')}
            onClick={() => runTry('lecture', () => window.electronAPI.generateLectureNotes?.())}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-text-secondary transition-[colors,transform] hover:text-text-primary active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 motion-reduce:active:scale-100"
          >
            {tryBusy === 'lecture' ? <Loader2 size={14} className="animate-spin" /> : null} Lecture notes
          </button>
          <button
            type="button"
            disabled={tryBusy !== null || !flagOn('diagramIntelligence')}
            onClick={() => runTry('diagram', () => window.electronAPI.generateDiagram?.())}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-text-secondary transition-[colors,transform] hover:text-text-primary active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 motion-reduce:active:scale-100"
          >
            {tryBusy === 'diagram' ? <Loader2 size={14} className="animate-spin" /> : null} Diagram
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="Search the current meeting…"
            disabled={!flagOn('inMeetingSearchV2')}
            className="flex-1 rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary transition-colors focus:outline-none focus:border-accent-primary disabled:opacity-40"
          />
          <button
            type="button"
            disabled={tryBusy !== null || !flagOn('inMeetingSearchV2') || !searchQ.trim()}
            onClick={() => runTry('search', () => window.electronAPI.searchInMeeting?.(searchQ.trim()))}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-3 py-1.5 text-xs font-medium text-white transition-[opacity,transform] active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100 motion-reduce:active:scale-100"
          >
            {tryBusy === 'search' ? <Loader2 size={14} className="animate-spin" /> : null} Search
          </button>
        </div>
        <TryResult out={tryOut} />
      </section>
    </div>
  );
};

export default IntelligenceSettings;
