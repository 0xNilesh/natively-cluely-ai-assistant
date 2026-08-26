// src/components/onboarding/PermissionsToaster.tsx
//
// Skills: ui-ux-pro-max · ui-design-system · canvas-designer · frontend-design
//
// Split-view permissions onboarding card.
// Shows once on first launch, after the launcher UI is visible.
// macOS: requests mic via system dialog, opens System Preferences for screen recording.
// Windows: Natively needs NO up-front grant — screen capture has no OS gate and the
// mic is granted by default — so the orchestrator no longer raises this card at
// startup there (stageCatalog `permissionsFirstRunEligible`). It appears on Windows
// only when the mic is genuinely blocked by the per-app or device privacy toggle, and
// every string, the guide artwork, and the primary button switch to that remedy:
// ms-settings:privacy-microphone. Nothing macOS-specific is rendered off darwin.
//

import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { X, Monitor, Mic, Settings } from 'lucide-react';
import nativelyIcon from '../../../assets/icon.png';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { classifyMicStatus, micSettingsUri } from '../../lib/micPermissionPolicy.mjs';
import { currentPlatform } from '../../utils/platformUtils';

const STORAGE_KEY  = 'natively_perms_shown_v1';

// ─── Design tokens ────────────────────────────────────────────
const T = {
  font:    '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif',
  blue:    '#007AFF',
  blueG:   'rgba(0,122,255,0.15)',
  green:   '#34D399',
  red:     '#F87171',
};

type PermStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' | 'loading';

interface Props {
  isOpen:    boolean;
  onDismiss: () => void;
}

// ─── Spring configs for Apple-like feel ───────────────────────
const SPRING = {
  gentle:  { type: 'spring' as const, stiffness: 180, damping: 22, mass: 0.9 },
  snappy:  { type: 'spring' as const, stiffness: 350, damping: 28, mass: 0.7 },
  smooth:  { duration: 0.35, ease: [0.22, 1, 0.36, 1] as [number,number,number,number] },
};

const FADE = { enter: { opacity: 0, y: 12, filter: 'blur(4px)' }, in: { opacity: 1, y: 0, filter: 'blur(0px)' }, exit: { opacity: 0, scale: 0.97, filter: 'blur(3px)' } };

export const PermissionsToaster: React.FC<Props> = ({ isOpen, onDismiss }) => {
  const [visible,    setVisible]    = useState(false);
  // Seeded from the statically-known platform, NOT a hardcoded 'darwin': if
  // checkPermissions fails, the old default rendered the whole macOS TCC
  // walkthrough on Windows.
  const [platform,   setPlatform]   = useState<string>(currentPlatform);
  const [micStatus,  setMicStatus]  = useState<PermStatus>('loading');
  const [scrStatus,  setScrStatus]  = useState<PermStatus>('loading');
  const [requesting, setRequesting] = useState(false);
  const reduced = useReducedMotion() ?? false;

  const [mockToggleActive, setMockToggleActive] = useState(true);
  useEffect(() => {
    const interval = setInterval(() => {
      setMockToggleActive(prev => !prev);
    }, 2200);
    return () => clearInterval(interval);
  }, []);

  const theme = useResolvedTheme();
  const isLight = theme === 'light';
  const isMac = platform === 'darwin';
  // Every platform-specific string below branches on isMac/isWin, never on
  // `!isMac` — an else-branch that says "Windows is blocking the microphone"
  // renders that literal text on Linux, which is the same wrong-platform-copy
  // bug in the other direction.
  const isWin = platform === 'win32';
  // Is there actually an OS panel to send this user to? null on Linux, where
  // the primary button would otherwise call an IPC that returns
  // {ok:false,'no-settings-panel'} and silently do nothing.
  const micPanelUri = micSettingsUri(platform);

  // Dynamic style tokens based on light/dark mode
  const colors = {
    cardBg: isLight 
      ? 'linear-gradient(160deg, #FFFFFF 0%, #FAFAFC 100%)' 
      : 'linear-gradient(160deg, rgba(24,24,32,0.98) 0%, rgba(16,16,22,0.99) 100%)',
    boxShadow: isLight
      ? '0 32px 80px rgba(0,0,0,0.12), 0 0 1px rgba(0,0,0,0.12)'
      : '0 40px 100px rgba(0,0,0,0.9), 0 0 1px rgba(255,255,255,0.08)',
    overlayBg: isLight ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.6)',
    rightBg: isLight ? '#F5F5F7' : 'rgba(0,0,0,0.3)',
    rightBorderLeft: isLight ? '1px solid rgba(0,0,0,0.07)' : `1px solid rgba(255,255,255,0.1)`,
    gridOpacity: isLight ? 0.08 : 0.04,
    gridLineColor: isLight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.5)',
    
    // Close button
    closeBtnColor: isLight ? '#1C1C1E' : '#FFFFFF',
    closeBtnOpacityDefault: isLight ? 0.45 : 0.4,
    closeBtnOpacityHover: isLight ? 0.85 : 0.8,
    closeBtnBgHover: isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)',

    // Step 1: macOS System Dialog Prompt Mockup
    step1Bg: isLight ? '#FFFFFF' : 'rgba(28, 28, 36, 0.85)',
    step1Border: isLight ? '1px solid rgba(0,0,0,0.09)' : '1px solid rgba(255, 255, 255, 0.12)',
    step1BoxShadow: isLight 
      ? '0 16px 36px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)' 
      : '0 24px 50px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.1)',
    step1NativelyShadow: isLight ? '0 4px 10px rgba(0,0,0,0.12)' : '0 4px 12px rgba(0,0,0,0.4)',
    step1TextPrimary: isLight ? '#1C1C1E' : '#FFFFFF',
    step1TextMuted: isLight ? 'rgba(0,0,0,0.48)' : 'rgba(255,255,255,0.4)',
    step1BtnBg: isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)',
    step1BtnBorder: isLight ? '1px solid rgba(0,0,0,0.02)' : '1px solid rgba(255,255,255,0.06)',
    step1BtnText: isLight ? '#1C1C1E' : '#FFFFFF',

    // Step 2: macOS System Settings Toggle Mockup
    step2Bg: isLight ? '#FFFFFF' : 'rgba(36, 36, 46, 0.65)',
    step2Border: isLight ? '1px solid rgba(0,0,0,0.08)' : '1px solid rgba(255, 255, 255, 0.08)',
    step2BoxShadow: isLight 
      ? '0 10px 24px rgba(0,0,0,0.05)' 
      : '0 12px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)',
    step2IconBg: isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)',
    step2IconBorder: isLight ? '1px solid rgba(0,0,0,0.02)' : '1px solid rgba(255,255,255,0.04)',
    step2Text: isLight ? '#1C1C1E' : '#FFFFFF',

    // Connecting Arrow lines
    arrowBg: isLight 
      ? 'linear-gradient(to bottom, rgba(0,0,0,0.15), rgba(0,0,0,0.03))' 
      : 'linear-gradient(to bottom, rgba(255,255,255,0.8), rgba(255,255,255,0.1))',
  };

  const t1 = isLight ? '#1C1C1E' : '#FFFFFF';
  const t2 = isLight ? 'rgba(28, 28, 30, 0.72)' : 'rgba(255, 255, 255, 0.72)';
  const t3 = isLight ? 'rgba(28, 28, 30, 0.48)' : 'rgba(255, 255, 255, 0.44)';
  const rule = isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.1)';
  const glass = isLight ? 'rgba(0, 0, 0, 0.03)' : 'rgba(255, 255, 255, 0.06)';

  const refreshStatus = useCallback(async () => {
    try {
      const p = await window.electronAPI?.checkPermissions?.();
      if (!p) return;
      setPlatform(p.platform);
      setMicStatus(p.microphone as PermStatus);
      setScrStatus(p.screen     as PermStatus);
    } catch {
      setMicStatus('not-determined');
      setScrStatus('not-determined');
    }
  }, []);

  useEffect(() => {
    if (!isOpen) { setVisible(false); return; }
    // Pure presentational: orchestrator already gated on the homepage-mounted
    // duration predicate. We just refresh status and become visible.
    refreshStatus().then(() => setVisible(true));
  }, [isOpen, refreshStatus]);

  useEffect(() => {
    if (!visible) return;
    const onFocus = () => refreshStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [visible, refreshStatus]);

  const handleMicToggle = async () => {
    if (micStatus === 'granted') {
      setMicStatus('denied');
      return;
    }
    // CR-03: this used to assume the request SUCCEEDED and set 'granted'
    // unconditionally. Off darwin nothing was requested at all, so a Windows
    // user with the mic toggle off saw a green control over a denied device and
    // capture silently produced nothing. Route by platform and re-read the real
    // status instead of asserting one.
    setRequesting(true);
    try {
      const plan = classifyMicStatus(platform, micStatus);
      if (plan.remedy === 'request') {
        await window.electronAPI?.requestMicPermission?.();
      } else if (plan.remedy === 'settings') {
        await window.electronAPI?.openMicSettings?.();
      }
      await refreshStatus();
    } finally {
      setRequesting(false);
    }
  };

  const handleScrToggle = () => {
    if (scrStatus === 'granted') {
      setScrStatus('denied');
    } else {
      if (platform === 'darwin') {
        window.electronAPI?.openExternal?.('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
      setScrStatus('granted');
    }
  };

  const openScreenSettings = () => {
    if (platform !== 'darwin') return;
    window.electronAPI?.openExternal?.('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  };

  // Off darwin the primary button used to just dismiss while still reading
  // "Open Settings" — a label that did nothing. The only reason this card is
  // raised on Windows now is a blocked mic, so send the user to the one panel
  // that fixes it and re-read the status when they come back.
  const openMicSettings = async () => {
    await window.electronAPI?.openMicSettings?.();
    await refreshStatus();
  };

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    onDismiss();
  };

  // Ported from the now-deleted PermissionsOnboardingFull, which had this right:
  // gate on classifyMicStatus's `usable`, NOT on a literal 'granted'. 'unknown'
  // means the OS could not resolve the state, not that it is denied — the win32
  // API fails OPEN (see micPermissionPolicy) — and treating it as blocked
  // stranded such a machine in onboarding forever, the lockout F-706 said must
  // never happen.
  const micPlan = classifyMicStatus(platform, micStatus);
  // 'policy' = MDM or parental controls. No panel can change it, so offering one
  // is a dead end — the same false promise CR-03 removed on the Windows side.
  const micBlockedByPolicy = micPlan.remedy === 'policy';
  const allGranted = isMac
    ? micPlan.usable && scrStatus === 'granted'
    : micPlan.usable;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="perm-overlay"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          style={{
            position: 'fixed', inset: 0, zIndex: 9998,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: colors.overlayBg,
            backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          }}
          onClick={e => { if (e.target === e.currentTarget) handleDismiss(); }}
        >
          {/* Card */}
          <motion.div
            key="perm-card"
            initial={reduced ? FADE.enter : { opacity: 0, scale: 0.95, y: 16, filter: 'blur(12px)' }}
            animate={reduced ? FADE.in : { opacity: 1, scale: 1,    y: 0,  filter: 'blur(0px)' }}
            exit={   reduced ? FADE.exit : { opacity: 0, scale: 0.97, y: 8,  filter: 'blur(4px)' }}
            transition={SPRING.gentle}
            style={{
              width: '680px', maxWidth: '92vw',
              borderRadius: '20px', overflow: 'hidden',
              background: colors.cardBg,
              boxShadow: colors.boxShadow,
              fontFamily: T.font,
            }}
          >
            {/* Two-column layout */}
            <div style={{ display: 'flex', minHeight: '460px' }}>

              {/* ── LEFT: Permission controls ── */}
              <div style={{ flex: 1, padding: '32px 32px 28px', display: 'flex', flexDirection: 'column' }}>

                {/* Header row */}
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '24px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <img src={nativelyIcon} alt="Natively" style={{ width: '18px', height: '18px', borderRadius: '4px', flexShrink: 0 }} />
                    <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: t3 }}>
                      Permissions
                    </span>
                  </div>
                </div>

                {/* Title + subtitle */}
                <motion.div
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ ...SPRING.smooth, delay: 0.05 }}
                  style={{ marginBottom: '28px' }}
                >
                  <h2 style={{ fontSize: '24px', fontWeight: 700, letterSpacing: '-0.03em', color: t1, margin: '0 0 8px', lineHeight: 1.2 }}>
                    {isMac
                      ? "Let's get you set up"
                      : allGranted
                      ? 'You’re all set'
                      : micBlockedByPolicy
                      ? 'Microphone blocked by policy'
                      : 'Microphone access is off'}
                  </h2>
                  <p style={{ fontSize: '13px', lineHeight: 1.65, color: t3, margin: 0 }}>
                    {isMac
                      ? 'Natively needs a few permissions to capture meetings and transcribe speech.'
                      : allGranted
                      ? 'Microphone access is on. Natively can transcribe speech — you can close this.'
                      : micBlockedByPolicy
                      ? 'Your organization blocks microphone access for this device. Privacy settings cannot override it — ask your administrator to allow Natively.'
                      : isWin
                      ? 'Windows is blocking the microphone, so speech cannot be transcribed. Turn it back on in Privacy settings — nothing else is needed.'
                      : 'The microphone is blocked, so speech cannot be transcribed. Enable it for Natively in your system settings.'}
                  </p>
                </motion.div>

                {/* Permission items */}
                <motion.div
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  transition={{ delay: 0.12 }}
                  style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}
                >
                  {platform === 'darwin' && (
                    <PermItem
                      icon={Monitor}
                      label="Screen Recording"
                      description="Required to capture meeting content"
                      status={scrStatus}
                      platform={platform}
                      onToggle={handleScrToggle}
                      reduced={reduced}
                      isLight={isLight}
                      relaunchHintWhenDenied
                    />
                  )}
                  <PermItem
                    icon={Mic}
                    label="Microphone"
                    description={isMac
                      ? 'Required for speech transcription'
                      : isWin
                      ? 'Turn on Microphone access for Natively'
                      : 'Enable microphone access for Natively'}
                    status={micStatus}
                    platform={platform}
                    onToggle={handleMicToggle}
                    reduced={reduced}
                    isLight={isLight}
                  />
                </motion.div>

                {/* Open Settings button */}
                <motion.div
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ ...SPRING.smooth, delay: 0.2 }}
                >
                  <motion.button
                    onClick={
                      // Administrator policy: no control here can change it, so
                      // the button dismisses rather than promising a fix.
                      micBlockedByPolicy
                        ? handleDismiss
                        : isMac
                        ? openScreenSettings
                        : micPanelUri
                        ? openMicSettings
                        // No OS panel on this platform (Linux): the IPC would
                        // resolve {ok:false,'no-settings-panel'} and the button
                        // would do nothing at all. Dismiss instead of pretending.
                        : handleDismiss
                    }
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.98 }}
                    style={{
                      width: '100%', height: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                      padding: '0 20px', borderRadius: '11px', border: 'none', cursor: 'pointer',
                      background: 'linear-gradient(160deg, #5B8EF0 0%, #3B6FE8 50%, #2D5FD4 100%)',
                      boxShadow: isLight
                        ? '0 6px 18px rgba(37,99,235,0.25), inset 0 1px 0 rgba(255,255,255,0.2)'
                        : '0 8px 24px rgba(37,99,235,0.35), inset 0 1px 0 rgba(255,255,255,0.2)',
                      fontFamily: T.font, fontSize: '14px', fontWeight: 600, color: '#fff',
                      letterSpacing: '-0.01em',
                      position: 'relative',
                      overflow: 'hidden',
                    }}
                  >
                    {/* Gloss Highlight (3D Jelly Clay) */}
                    <span style={{ position: 'absolute', top: '2px', left: '8px', right: '8px', height: '40%', borderRadius: '9999px', background: 'linear-gradient(to bottom, rgba(255,255,255,0.7), rgba(255,255,255,0.05))', filter: 'blur(0.5px)', pointerEvents: 'none', zIndex: 1 }} />
                    
                    <span style={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Settings size={14} strokeWidth={2} />
                      {micBlockedByPolicy
                        ? 'Blocked by your organization'
                        : isMac
                        ? 'Open Settings'
                        : micPanelUri
                        ? 'Open Privacy Settings'
                        : 'Got It'}
                    </span>
                  </motion.button>

                </motion.div>
              </div>

              {/* ── RIGHT: Visual guide ── */}
              <motion.div
                initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                transition={{ ...SPRING.gentle, delay: 0.08 }}
                style={{
                  width: '260px', flexShrink: 0,
                  background: colors.rightBg,
                  borderLeft: colors.rightBorderLeft,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '32px 24px',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                {/* Close button in the top-right corner of graphics section */}
                <button onClick={handleDismiss} aria-label="Dismiss"
                  style={{
                    position: 'absolute',
                    top: '16px',
                    right: '16px',
                    zIndex: 10,
                    background: 'none', border: 'none', cursor: 'pointer',
                    width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: '50%', opacity: colors.closeBtnOpacityDefault, transition: 'opacity 200ms, background 200ms',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = String(colors.closeBtnOpacityHover); e.currentTarget.style.background = colors.closeBtnBgHover; }}
                  onMouseLeave={e => { e.currentTarget.style.opacity = String(colors.closeBtnOpacityDefault); e.currentTarget.style.background = 'transparent'; }}>
                  <X size={12} strokeWidth={2.5} color={colors.closeBtnColor} />
                </button>
                {/* Subtle grid pattern */}
                <div aria-hidden style={{
                  position: 'absolute', inset: 0, opacity: colors.gridOpacity,
                  backgroundImage: `linear-gradient(${colors.gridLineColor} 1px, transparent 1px),
                                   linear-gradient(90deg, ${colors.gridLineColor} 1px, transparent 1px)`,
                  backgroundSize: '24px 24px',
                }} />

                {/* Guide content */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', position: 'relative', zIndex: 1, width: '100%', perspective: '1000px' }}>
                  
                  <motion.div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '12px',
                      width: '100%',
                    }}
                    whileHover={{ scale: 1.015 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                  >
                    {/* Step 1: OS mockup — macOS consent dialog, or the Windows
                        "Microphone access" master switch. Windows never shows a
                        per-app consent dialog, so rendering one there taught the
                        user to look for something that does not exist. */}
                    <motion.div 
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.15, type: 'spring', stiffness: 180, damping: 18 }}
                      style={{
                        width: '218px',
                        backgroundColor: colors.step1Bg,
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        borderRadius: '12px',
                        padding: '12px',
                        border: colors.step1Border,
                        boxShadow: colors.step1BoxShadow,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                        {/* Natively Icon with subtle breath/float loop */}
                        <motion.div 
                          animate={{ y: [0, -2, 0] }}
                          transition={{ repeat: Infinity, duration: 2.8, ease: "easeInOut" }}
                          style={{ width: '32px', height: '32px', flexShrink: 0 }}
                        >
                          <img src={nativelyIcon} alt="Natively" style={{ width: '32px', height: '32px', borderRadius: '7px', boxShadow: colors.step1NativelyShadow }} />
                        </motion.div>
                        
                        {/* Prompt Text */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ fontSize: '10px', fontWeight: 600, color: colors.step1TextPrimary, lineHeight: 1.3, letterSpacing: '-0.01em' }}>
                            {isMac
                              ? '"Natively" wants to record the screen.'
                              : 'Microphone access'}
                          </div>
                          <div style={{ fontSize: '8.5px', color: colors.step1TextMuted, lineHeight: 1.25 }}>
                            {isMac
                              ? 'Enable access in Privacy & Security settings.'
                              : 'Let apps access your microphone — turn this on first.'}
                          </div>
                        </div>
                      </div>
                      
                      {/* Footer: macOS dialog buttons, or the Windows master switch */}
                      {isMac ? (
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '4px' }}>
                          {/* Pulsing button mockup */}
                          <motion.div 
                            animate={{ scale: [1, 1.04, 1] }}
                            transition={{ repeat: Infinity, duration: 2.2, ease: "easeInOut", repeatDelay: 0.5 }}
                            style={{ padding: '4px 8px', borderRadius: '5px', background: colors.step1BtnBg, border: colors.step1BtnBorder, fontSize: '8px', fontWeight: 600, color: colors.step1BtnText, letterSpacing: '-0.01em' }}
                          >
                            Open Settings
                          </motion.div>
                          <div style={{ padding: '4px 8px', borderRadius: '5px', background: '#007AFF', fontSize: '8px', fontWeight: 600, color: '#FFFFFF', letterSpacing: '-0.01em', boxShadow: '0 2px 6px rgba(0,122,255,0.3)' }}>
                            Deny
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', marginTop: '4px' }}>
                          <span style={{ fontSize: '8px', fontWeight: 600, color: colors.step1TextMuted, letterSpacing: '-0.01em' }}>On</span>
                          <div style={{ width: '24px', height: '14px', borderRadius: '7px', padding: '1.5px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', background: 'linear-gradient(160deg, #34D399 0%, #10B981 100%)', boxShadow: '0 0 10px rgba(52,211,153,0.35)' }}>
                            <div style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
                          </div>
                        </div>
                      )}
                    </motion.div>

                    {/* Connecting Arrow */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', opacity: 0.35 }}>
                      <div style={{ width: '2px', height: '8px', background: colors.arrowBg }} />
                    </div>

                    {/* Step 2: macOS System Settings Toggle Mockup */}
                    <motion.div 
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.25, type: 'spring', stiffness: 180, damping: 18 }}
                      style={{
                        width: '218px',
                        backgroundColor: colors.step2Bg,
                        backdropFilter: 'blur(12px)',
                        WebkitBackdropFilter: 'blur(12px)',
                        borderRadius: '10px',
                        padding: '8px 10px',
                        border: colors.step2Border,
                        boxShadow: colors.step2BoxShadow,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        textAlign: 'left',
                      }}
                    >
                      {/* Left app icon well — macOS only. Windows 11 governs
                          non-packaged desktop apps through a single switch; the
                          app list under it is informational, so drawing a
                          Natively row with a flippable toggle sends the user
                          hunting for a control that is not there. */}
                      {isMac && (
                        <div style={{ width: '22px', height: '22px', borderRadius: '5px', background: colors.step2IconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: colors.step2IconBorder }}>
                          <img src={nativelyIcon} alt="Natively" style={{ width: '14px', height: '14px', borderRadius: '3px' }} />
                        </div>
                      )}
                      {/* Label */}
                      <span style={{ fontSize: '10px', fontWeight: 550, color: colors.step2Text, flex: 1, letterSpacing: '-0.01em', lineHeight: 1.3 }}>
                        {isMac ? 'Natively' : 'Let desktop apps access your microphone'}
                      </span>
                      {/* Active Toggle Switch with premium gradient, looping animation, and manual tap override */}
                      <motion.div 
                        animate={{
                          background: mockToggleActive 
                            ? 'linear-gradient(160deg, #34D399 0%, #10B981 100%)' 
                            : (isLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)'),
                          boxShadow: mockToggleActive 
                            ? '0 0 10px rgba(52,211,153,0.35), 0 2px 4px rgba(0,0,0,0.1)' 
                            : '0 1px 2px rgba(0,0,0,0.05)',
                        }}
                        transition={{ duration: 0.3, ease: 'easeInOut' }}
                        style={{
                          width: '24px', height: '14px', borderRadius: '7px',
                          padding: '1.5px',
                          display: 'flex', alignItems: 'center',
                          flexShrink: 0,
                          position: 'relative',
                          cursor: 'pointer',
                        }}
                        onClick={() => setMockToggleActive(p => !p)}
                        whileTap={{ scale: 0.95 }}
                      >
                        <motion.div 
                          animate={{ x: mockToggleActive ? 10 : 0 }}
                          transition={{ type: 'spring', stiffness: 450, damping: 28 }}
                          style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} 
                        />
                      </motion.div>
                    </motion.div>
                  </motion.div>

                  {/* Breadcrumb Info text */}
                  <p style={{ fontSize: '9.5px', fontWeight: 500, color: t3, lineHeight: 1.4, margin: '4px 0 0', textAlign: 'center', opacity: 0.8, letterSpacing: '0.02em', textTransform: 'uppercase' }}>
                    {isMac
                      ? 'System Settings → Privacy & Security'
                      : 'Settings → Privacy & security → Microphone'}
                  </p>
                </div>
              </motion.div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// ─── Single permission item with toggle ───────────────────────
function PermItem({
  icon: Icon, label, description, status, platform, onToggle, reduced, isLight,
  relaunchHintWhenDenied,
}: {
  icon:        React.ElementType;
  label:       string;
  description: string;
  status:      PermStatus;
  platform:    string;
  onToggle?:   () => void;
  reduced:     boolean;
  isLight:     boolean;
  relaunchHintWhenDenied?: boolean;
}) {
  const isGranted = status === 'granted';
  const isDenied  = status === 'denied' || status === 'restricted';
  const isLoading = status === 'loading' || status === 'not-determined';
  // macOS reads the Screen Recording grant at process launch: re-enabling it in
  // System Settings does NOT apply to the running app, so a previously-denied
  // user must relaunch. The mic grant DOES take effect live, so no hint there.
  const deniedHint = relaunchHintWhenDenied && platform === 'darwin'
    ? 'Re-enable in Settings, then restart'
    : 'Re-enable in Settings';

  const t1 = isLight ? '#1C1C1E' : '#FFFFFF';
  const t3 = isLight ? 'rgba(28, 28, 30, 0.48)' : 'rgba(255, 255, 255, 0.44)';
  const rule = isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.1)';
  const glass = isLight ? 'rgba(0, 0, 0, 0.03)' : 'rgba(255, 255, 255, 0.06)';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 24 }}
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', gap: '14px',
        padding: '14px 16px', borderRadius: '12px',
        background: glass, border: `1px solid ${isGranted ? 'rgba(52,211,153,0.18)' : rule}`,
        transition: 'border-color 300ms, transform 150ms',
        cursor: onToggle ? 'pointer' : 'default',
      }}
      whileHover={onToggle ? { scale: 1.005 } : {}}
      whileTap={onToggle ? { scale: 0.995 } : {}}
    >
      {/* Icon well */}
      <div style={{
        width: '38px', height: '38px', borderRadius: '10px', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: isGranted ? 'rgba(52,211,153,0.12)' : isDenied ? 'rgba(248,113,113,0.1)' : 'rgba(0,122,255,0.1)',
        border: `1px solid ${isGranted ? 'rgba(52,211,153,0.2)' : isDenied ? 'rgba(248,113,113,0.15)' : 'rgba(0,122,255,0.15)'}`,
      }}>
        <Icon size={17} strokeWidth={1.75} color={isGranted ? T.green : isDenied ? T.red : '#007AFF'} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '13.5px', fontWeight: 580, color: t1, letterSpacing: '-0.01em' }}>{label}</div>
        <div style={{ fontSize: '11.5px', color: t3, marginTop: '2px' }}>
          {/*
            Status text is NOT macOS-only. It used to be gated to darwin, so a
            Windows user who flipped the privacy toggle and came back saw the
            row still reading "Turn on Microphone access" with no confirmation
            they had succeeded. getMediaAccessStatus('microphone') is real on
            win32 since F-706 and the focus listener re-reads it, so show the
            resolved state on every platform. Only the "restart" wording stays
            macOS-specific — see deniedHint.
          */}
          {isGranted ? 'Access granted' : isDenied ? deniedHint : description}
        </div>
      </div>

      {/* Toggle switch (iOS style) */}
      {platform === 'darwin' && (
        <motion.div
          animate={{
            background: isGranted 
              ? 'rgba(52,211,153,0.85)' 
              : isDenied 
                ? (isLight ? 'rgba(239, 68, 68, 0.2)' : 'rgba(248,113,113,0.5)')
                : (isLight ? 'rgba(120, 120, 128, 0.16)' : 'rgba(255,255,255,0.15)'),
          }}
          transition={reduced ? {} : { type: 'spring', stiffness: 400, damping: 28 }}
          style={{
            width: '42px', height: '26px', borderRadius: '13px',
            display: 'flex', alignItems: 'center', padding: '3px',
            transition: 'background 250ms',
            boxShadow: isGranted ? '0 0 12px rgba(52,211,153,0.3)' : 'none',
          }}
        >
          <motion.div
            animate={{ x: isGranted ? 16 : 0 }}
            transition={reduced ? {} : { type: 'spring', stiffness: 500, damping: 30 }}
            style={{
              width: '20px', height: '20px', borderRadius: '10px',
              background: '#fff',
              boxShadow: '0 2px 8px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.15)',
            }}
          />
        </motion.div>
      )}
    </motion.div>
  );
}