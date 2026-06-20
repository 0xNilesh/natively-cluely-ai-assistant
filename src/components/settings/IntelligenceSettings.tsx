import { AlertTriangle, Brain, Check, Loader2, Wifi, WifiOff } from 'lucide-react';
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
    <div className="flex items-start justify-between gap-4 rounded-lg px-3 py-2 hover:bg-bg-item-active/40">
      <div className="min-w-0">
        <div className="text-sm text-text-primary">{meta?.label || row.key}</div>
        {meta?.desc ? <div className="text-xs text-text-secondary">{meta.desc}</div> : null}
      </div>
      <Toggle on={row.enabled} onClick={() => onToggle(row)} />
    </div>
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
    <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`} />
  </button>
);

// Connection status pill with four distinct states, so the user can tell "I haven't set
// this up" apart from "I set it up but it's offline" — the old single chip showed the same
// "Not running" for both. The unreachable state offers an inline Retry.
type ConnStatus = 'not-configured' | 'checking' | 'connected' | 'unreachable';
const StatusChip: React.FC<{ status: ConnStatus; testing: boolean; onRetry: () => void }> = ({ status, testing, onRetry }) => {
  if (status === 'connected') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-400">
        <Wifi size={12} /> Connected
      </span>
    );
  }
  if (status === 'checking' || testing) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-item-active px-2 py-0.5 text-xs text-text-secondary">
        <Loader2 size={12} className="animate-spin" /> Checking…
      </span>
    );
  }
  if (status === 'unreachable') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-400">
        <WifiOff size={12} /> Can’t connect
        <button type="button" onClick={onRetry} className="ml-1 underline hover:no-underline">Retry</button>
      </span>
    );
  }
  // not-configured
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-item-active px-2 py-0.5 text-xs text-text-secondary">
      Not set up
    </span>
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
      <section className="rounded-xl border border-border-subtle bg-bg-item-active/30 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-primary">Long-term memory <span className="ml-1 rounded bg-accent-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-primary">Beta</span></div>
            <div className="text-xs text-text-secondary">Remember what was discussed in past meetings and surface it automatically. Needs a free companion app — about 5 minutes to set up.</div>
          </div>
          <StatusChip status={status} onRetry={onTest} testing={testing} />
        </div>

        <button
          type="button"
          onClick={() => setShowSetup((v) => !v)}
          className="text-xs font-medium text-accent-primary hover:underline"
        >
          {showSetup ? 'Hide setup' : (status === 'connected' ? 'Edit setup' : 'Set up long-term memory →')}
        </button>

        {showSetup ? (
          <div className="space-y-3 rounded-lg border border-border-subtle bg-bg-input/40 p-3">
            {/* Step-by-step install — the companion server is a separate app the user installs. */}
            <ol className="space-y-2 text-xs text-text-secondary">
              <li>
                <span className="font-medium text-text-primary">1. Install the companion app.</span> In your Terminal, run:
                <code className="mt-1 block rounded bg-bg-input px-2 py-1 font-mono text-[11px] text-text-primary">pip install hindsight-all</code>
                Requires Python 3.11 or later. Your AI provider key (from the AI Providers screen) is used automatically — no extra key needed.
              </li>
              <li>
                <span className="font-medium text-text-primary">2. Start it.</span> Keep this running while you use the app:
                <code className="mt-1 block rounded bg-bg-input px-2 py-1 font-mono text-[11px] text-text-primary">hindsight serve --port 8888</code>
              </li>
              <li><span className="font-medium text-text-primary">3. Paste the address below</span> (the local default is already filled in), then press Save.</li>
            </ol>
            <button type="button" onClick={() => openExternal('https://hindsight.vectorize.io/developer/installation')} className="text-[11px] text-accent-primary hover:underline">
              Full setup guide &amp; troubleshooting →
            </button>

            <label className="block">
              <span className="text-xs text-text-secondary">Server address</span>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:8888"
                className="mt-1 w-full rounded-lg bg-bg-input px-3 py-2 text-sm text-text-primary outline-none ring-1 ring-border-subtle focus:ring-accent-primary"
              />
            </label>

            {/* Cloud is the alternative to running local software. The API key here is the
                Hindsight Cloud ACCOUNT key — explicitly NOT the user's AI provider key, which
                already lives in the AI Providers screen and is forwarded automatically. */}
            <label className="block">
              <span className="text-xs text-text-secondary">
                Hindsight Cloud account key <span className="text-text-secondary/70">(not your AI key)</span>
                {cfg?.hasApiKey ? ' — saved, leave blank to keep' : ''}
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={cfg?.hasApiKey ? '••••••••  saved' : 'Only if you use Hindsight Cloud instead of local'}
                className="mt-1 w-full rounded-lg bg-bg-input px-3 py-2 text-sm text-text-primary outline-none ring-1 ring-border-subtle focus:ring-accent-primary"
              />
              <span className="mt-1 block text-[11px] text-text-secondary">
                Only needed for Hindsight Cloud. Your AI provider key stays on this device and is used separately.
              </span>
            </label>

            <label className="flex items-center justify-between gap-3">
              <span className="text-sm text-text-primary">
                Start memory server automatically at launch
                <span className="block text-[11px] text-text-secondary">Only works after setup is complete. No effect if the companion app isn’t installed.</span>
              </span>
              <Toggle on={autoStart} onClick={() => setAutoStart((v) => !v)} />
            </label>

            {/* Privacy disclosure ABOVE the Save action so it's seen before any data is sent. */}
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-text-secondary">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-400" />
              <span>Local keeps memory on this device. Choosing Cloud sends meeting summaries to Hindsight’s servers — a privacy trade-off for an otherwise local-first app.</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onSaveHindsight}
                disabled={saving}
                className="rounded-lg bg-accent-primary px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : savedAt ? <Check size={14} /> : null}
                {savedAt ? 'Saved' : 'Save'}
              </button>
              <button
                type="button"
                onClick={onTest}
                disabled={testing || !baseUrl.trim()}
                className="rounded-lg bg-bg-item-active px-3 py-1.5 text-sm text-text-primary hover:bg-bg-item-active/70 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : null}
                Test connection
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* ── Smart features (master switch + Customize) ───────────── */}
      <section className="space-y-3">
        {/* One low-stakes lever for the normal user: turn the on-device quality features on
            or off. The ~12 granular toggles live behind "Customize" for power users. */}
        <div className="rounded-xl border border-border-subtle bg-bg-item-active/30 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-primary">Smart features</div>
              <div className="text-xs text-text-secondary">
                Better answers, meeting notes, and follow-ups — all running on your device.
                {masterState === 'mixed' ? <span className="ml-1 text-accent-primary">Customized.</span> : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {masterBusy ? <Loader2 size={14} className="animate-spin text-text-secondary" /> : null}
              <Toggle on={masterState !== 'off'} disabled={masterBusy} onClick={onToggleMaster} />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowCustomize((v) => !v)}
            className="mt-3 text-xs font-medium text-accent-primary hover:underline"
          >
            {showCustomize ? '▾ Hide individual features' : '▸ Customize individual features'}
          </button>

          {showCustomize ? (
            <div className="mt-3 space-y-4 border-t border-border-subtle pt-3">
              {/* Core features individually — same switches the master fans out to. */}
              {byTier.core.length ? (
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Meeting notes</div>
                  {byTier.core.map((row) => (
                    <FlagRowView key={row.key} row={row} onToggle={onToggleFlag} />
                  ))}
                </div>
              ) : null}

              {/* Advanced opt-in features (extra cost / niche / scope tradeoffs). */}
              {ADVANCED_GROUP_ORDER.filter((g) => byTier.advancedByGroup[g]?.length).map((group) => (
                <div key={group} className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{group}</div>
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
                    className="text-xs font-medium text-text-secondary hover:text-text-primary"
                  >
                    {showDev ? '▾ Hide developer options' : '▸ Developer options (for testing only)'}
                  </button>
                  {showDev ? (
                    <div className="mt-2 space-y-2">
                      {byTier.dev.map((row) => (
                        <FlagRowView key={row.key} row={row} onToggle={onToggleFlag} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {/* ── Try it (runs against the current meeting) ────────────── */}
      <section className="rounded-xl border border-border-subtle bg-bg-item-active/30 p-4 space-y-3">
        <div>
          <div className="text-sm font-medium text-text-primary">Try it</div>
          <div className="text-xs text-text-secondary">These run on the meeting you’re currently in — not a saved recording. Turn the feature on under “Customize individual features” above, then join an active meeting.</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={tryBusy !== null || !flagOn('lectureIntelligenceV2')}
            onClick={() => runTry('lecture', () => window.electronAPI.generateLectureNotes?.())}
            className="rounded-lg bg-bg-item-active px-3 py-1.5 text-sm text-text-primary hover:bg-bg-item-active/70 disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            {tryBusy === 'lecture' ? <Loader2 size={14} className="animate-spin" /> : null} Lecture notes
          </button>
          <button
            type="button"
            disabled={tryBusy !== null || !flagOn('diagramIntelligence')}
            onClick={() => runTry('diagram', () => window.electronAPI.generateDiagram?.())}
            className="rounded-lg bg-bg-item-active px-3 py-1.5 text-sm text-text-primary hover:bg-bg-item-active/70 disabled:opacity-40 inline-flex items-center gap-1.5"
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
            className="flex-1 rounded-lg bg-bg-input px-3 py-2 text-sm text-text-primary outline-none ring-1 ring-border-subtle focus:ring-accent-primary disabled:opacity-40"
          />
          <button
            type="button"
            disabled={tryBusy !== null || !flagOn('inMeetingSearchV2') || !searchQ.trim()}
            onClick={() => runTry('search', () => window.electronAPI.searchInMeeting?.(searchQ.trim()))}
            className="rounded-lg bg-bg-item-active px-3 py-1.5 text-sm text-text-primary hover:bg-bg-item-active/70 disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            {tryBusy === 'search' ? <Loader2 size={14} className="animate-spin" /> : null} Search
          </button>
        </div>
        {tryOut ? (
          <pre className="max-h-48 overflow-auto rounded-lg bg-bg-input p-3 text-[11px] text-text-secondary whitespace-pre-wrap">{tryOut.text}</pre>
        ) : null}
      </section>
    </div>
  );
};

export default IntelligenceSettings;
