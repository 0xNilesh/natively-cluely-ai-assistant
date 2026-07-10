// src/components/HindsightStatusBanner.tsx
//
// Persistent top-of-overlay banner that surfaces Hindsight server lifecycle events. Without
// this, a spawn failure only logs to console + `<userData>/hindsight-server.log` and the user
// has no UI signal that the long-term-memory feature isn't working. We subscribe to the
// `hindsight-status` IPC once on mount and render an amber dismissible banner for the failure
// states ('spawn-failed', 'unreachable'); success states are no-ops (the Settings panel
// chip already covers them).
//
// The banner sits above NativelyInterface in the overlay tree with a high z-index so it's
// visible during meetings too — a silently-broken memory server during a meeting would
// otherwise be invisible until the user opens Settings.

import React, { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, ExternalLink, X } from 'lucide-react';

type HindsightStatus =
  | { state: 'spawning'; reason?: string; logPath?: string }
  | { state: 'ready'; reason?: string; logPath?: string }
  | { state: 'unreachable'; reason?: string; logPath?: string }
  | { state: 'spawn-failed'; reason?: string; logPath?: string }
  | { state: 'auth-failed'; reason?: string; logPath?: string };

// Per-state copy. Kept short — the banner has limited horizontal space inside the overlay.
const STATUS_BODY: Record<'spawn-failed' | 'unreachable' | 'spawning' | 'auth-failed', { title: string; body: string }> = {
  'spawn-failed':   { title: 'Long-term memory server failed to start', body: 'The companion app couldn’t boot. Long-term memory is disabled this session.' },
  'unreachable':    { title: 'Long-term memory server didn’t respond',  body: 'The companion started but didn’t answer the health check. Check the log.' },
  'spawning':       { title: 'Starting long-term memory…',              body: 'First boot can take 2–3 minutes (downloading embedding models).' },
  'auth-failed':    { title: 'Hindsight Cloud key was rejected',       body: 'The endpoint answered but your Cloud account key is invalid. Update the key below.' },
};

export const HindsightStatusBanner: React.FC<{ variant?: 'top-strip' | 'floating-card' }> = ({ variant = 'top-strip' }) => {
  const [status, setStatus] = useState<HindsightStatus | null>(null);
  // Per-session dismissal — once the user clicks X the banner stays hidden until a NEW
  // failure occurs (state goes null → failure again). Avoids re-showing the same nudge
  // for every poll cycle.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handler = (data: HindsightStatus) => {
      // Success state → hide banner, reset dismissal so the NEXT failure can re-show.
      if (data.state === 'ready') {
        setStatus(null);
        setDismissed(false);
        return;
      }
      // Failure state → show (or re-show after a previous dismissal).
      setStatus(data);
      setDismissed(false);
    };
    const off = window.electronAPI?.onHindsightStatus?.(handler);
    return () => { try { off?.(); } catch { /* unmount */ } };
  }, []);

  const openLog = useCallback(async () => {
    try {
      const res = await window.electronAPI?.openHindsightLog?.();
      if (res && !res.ok && res.error) {
        console.warn('[HindsightStatusBanner] failed to open log:', res.error);
      }
    } catch (e: any) {
      console.warn('[HindsightStatusBanner] openHindsightLog threw:', e?.message);
    }
  }, []);

  // Don't render anything on success states or when dismissed.
  if (!status || status.state === 'ready' || dismissed) return null;
  const copy = STATUS_BODY[status.state];
  if (!copy) return null;

  // Spawning: neutral (working) — smaller, less alarming. Failures: amber, with action.
  const isFailing = status.state === 'spawn-failed' || status.state === 'unreachable' || status.state === 'auth-failed';

  if (variant === 'floating-card') {
    return (
      <AnimatePresence>
        {!dismissed && (
          <motion.div
            key="hindsight-floating-card"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed bottom-6 right-6 z-50 pointer-events-auto"
          >
            <div className={`bg-[#1A1A1A] border ${isFailing ? 'border-amber-500/40' : 'border-white/10'} shadow-2xl rounded-2xl p-5 max-w-[340px] flex flex-col gap-3`}>
              <div className="flex items-start gap-3">
                <AlertTriangle className={`w-5 h-5 shrink-0 mt-0.5 ${isFailing ? 'text-amber-400' : 'text-[#A0A0A0]'}`} />
                <div className="flex-1 min-w-0">
                  <h3 className="text-[#E0E0E0] font-medium text-sm">{copy.title}</h3>
                  <p className="text-[#A0A0A0] text-xs mt-1 leading-relaxed">
                    {copy.body}
                    {status.reason ? <> — <span className="font-mono opacity-80">{status.reason}</span></> : null}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setDismissed(true)}
                  aria-label="Dismiss"
                  className="shrink-0 text-white/30 hover:text-white/70 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
              {isFailing && status.logPath ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={openLog}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-[#A0A0A0] hover:text-white hover:bg-white/5 transition-colors"
                    title={status.logPath}
                  >
                    View log
                  </button>
                </div>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  const borderClass = isFailing ? 'border-amber-500/40' : 'border-border-subtle';
  const bgClass = isFailing ? 'bg-amber-500/10' : 'bg-bg-item-surface';
  const textClass = isFailing ? 'text-amber-200' : 'text-text-secondary';
  const titleClass = isFailing ? 'text-amber-100' : 'text-text-primary';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`absolute top-0 left-0 right-0 z-50 flex items-start gap-2 border-b ${borderClass} ${bgClass} px-3 py-2 text-xs ${textClass} shadow-sm`}
    >
      <AlertTriangle size={14} className={`mt-0.5 shrink-0 ${isFailing ? 'text-amber-400' : 'text-text-tertiary'}`} />
      <div className="min-w-0 flex-1">
        <div className={`font-medium ${titleClass}`}>{copy.title}</div>
        <div className="mt-0.5 text-[11px] leading-relaxed">
          {copy.body}
          {status.reason ? <> — <span className="font-mono opacity-80">{status.reason}</span></> : null}
        </div>
      </div>
      {isFailing && status.logPath ? (
        <button
          type="button"
          onClick={openLog}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/20 active:scale-[0.97] motion-reduce:active:scale-100"
          title={status.logPath}
        >
          <ExternalLink size={11} />
          View log
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="inline-flex shrink-0 items-center rounded-md p-1 text-text-tertiary transition-colors hover:text-text-primary"
      >
        <X size={12} />
      </button>
    </div>
  );
};

export default HindsightStatusBanner;