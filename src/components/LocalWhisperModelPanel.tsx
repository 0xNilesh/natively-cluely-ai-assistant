import React, { useState, useEffect, useRef, useCallback } from 'react';

/* ──────────────────────────────────────────────────────────────────────────
 *  LocalWhisperModelPanel — "Studio Console" treatment.
 *
 *  Conceptual direction: a piece of pro audio gear. The active model is the
 *  loaded engine (hero module with signal-flow). Other models are an
 *  alternates rack underneath. Hardware capability and privacy posture sit
 *  in a single chip strip at the top — no competing banners.
 * ────────────────────────────────────────────────────────────────────────── */

interface ModelInfo {
    id: string;
    name: string;
    sizeMb: number;
    speed: 'very-fast' | 'fast' | 'medium' | 'slow';
    accuracy: 'decent' | 'good' | 'high' | 'very-high';
    multilingual: boolean;
    status: 'available' | 'missing' | 'downloading' | 'error';
    errorMessage?: string;
    requiresAppleSilicon?: boolean;
}

interface HardwareInfo {
    arch: string;
    platform: string;
    isAppleSilicon: boolean;
    totalRamGb: number;
    tier: 'excellent' | 'good' | 'limited';
    recommendation: string;
    recommendedModel: string;
}

const SPEED_LABEL: Record<string, string> = {
    'very-fast': 'V·FAST', fast: 'FAST', medium: 'MED', slow: 'SLOW',
};
const ACCURACY_LABEL: Record<string, string> = {
    decent: 'DECENT', good: 'GOOD', high: 'HIGH', 'very-high': 'V·HIGH',
};

const formatSize = (mb: number) =>
    mb >= 1000 ? `${(mb / 1000).toFixed(1)}GB` : `${mb}MB`;

const electronAPI = (window as any).electronAPI;
const FONT_MONO = 'ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace';

/* ──────────────────────────────────────────────────────────────────────────
 *  Sub-components
 * ────────────────────────────────────────────────────────────────────────── */

function HardwareStrip({ hardware }: { hardware: HardwareInfo | null }) {
    if (!hardware) return null;
    const accel = hardware.isAppleSilicon
        ? { label: 'METAL · CoreML', tone: 'bg-violet-500/10 text-violet-400 dark:text-violet-300 ring-violet-500/20' }
        : hardware.platform === 'win32'
        ? { label: 'DIRECTML', tone: 'bg-sky-500/10 text-sky-400 dark:text-sky-300 ring-sky-500/20' }
        : { label: 'CPU · INT8', tone: 'bg-black/5 dark:bg-white/5 text-text-tertiary ring-black/10 dark:ring-white/10' };

    return (
        <div className="flex items-center gap-2 flex-wrap">
            <Chip
                tone="bg-emerald-500/10 text-emerald-500 dark:text-emerald-300 ring-emerald-500/20 shadow-[0_0_10px_rgba(52,211,153,0.1)]"
                icon={<LockIcon />}
                label="ON-DEVICE"
                hint="No API key. Audio never leaves this machine."
            />
            <Chip tone={accel.tone} label={accel.label} />
            <Chip
                tone="bg-black/5 dark:bg-white/5 text-text-secondary ring-black/10 dark:ring-white/10"
                label={`${hardware.totalRamGb}GB RAM`}
            />
            <Chip
                tone="bg-black/5 dark:bg-white/5 text-text-secondary ring-black/10 dark:ring-white/10"
                label={hardware.arch.toUpperCase()}
            />
        </div>
    );
}

function Chip({
    tone, label, icon, hint,
}: { tone: string; label: string; icon?: React.ReactNode; hint?: string }) {
    return (
        <span
            title={hint}
            style={{ fontFamily: FONT_MONO, letterSpacing: '0.06em' }}
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[9px] font-medium ring-1 ring-inset ${tone}`}
        >
            {icon}
            {label}
        </span>
    );
}

function LockIcon() {
    return (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 1 1 8 0v4" />
        </svg>
    );
}

function SignalFlow({ live, isAppleSilicon }: { live: boolean; isAppleSilicon: boolean }) {
    return (
        <div
            style={{ fontFamily: FONT_MONO, letterSpacing: '0.04em' }}
            className="flex items-center gap-1.5 text-[9.5px] text-text-tertiary uppercase select-none opacity-80"
        >
            <span>mic</span>
            <Arrow live={live} />
            <span>vad</span>
            <Arrow live={live} />
            <span className="text-text-secondary font-medium">whisper</span>
            <Arrow live={live} />
            <span>text</span>
            <span className="ml-1 text-[8.5px] text-text-tertiary/70 hidden sm:inline">
                · {isAppleSilicon ? 'NEURAL ENGINE' : 'CPU'}
            </span>
        </div>
    );
}

function Arrow({ live }: { live: boolean }) {
    return (
        <span className={`inline-block w-2.5 h-px ${live ? 'bg-accent-primary' : 'bg-border-subtle'}`} />
    );
}

function ActiveEngineHero({
    model,
    isRecommended,
    preloadStatus,
    onDeselect,
    isAppleSilicon,
}: {
    model: ModelInfo | null;
    isRecommended: boolean;
    preloadStatus: 'idle' | 'warming' | 'ready';
    onDeselect: () => void;
    isAppleSilicon: boolean;
}) {
    if (!model) {
        return (
            <div className="relative p-1.5 rounded-[2rem] bg-black/5 dark:bg-white/[0.02] ring-1 ring-inset ring-black/5 dark:ring-white/[0.05]">
                <div className="rounded-[calc(2rem-0.375rem)] border border-dashed border-border-subtle bg-bg-input/50 px-4 py-8 text-center space-y-2">
                    <p className="text-sm font-medium text-text-secondary">No engine loaded</p>
                    <p className="text-[11px] text-text-tertiary">
                        Install one below — the recommended choice is highlighted for your hardware.
                    </p>
                </div>
            </div>
        );
    }

    const statusDot =
        preloadStatus === 'ready'
            ? { color: 'bg-emerald-400', ring: 'ring-emerald-400/30', label: 'READY', pulse: false }
            : preloadStatus === 'warming'
            ? { color: 'bg-amber-400', ring: 'ring-amber-400/30', label: 'WARMING', pulse: true }
            : { color: 'bg-accent-primary', ring: 'ring-accent-primary/30', label: 'LOADED', pulse: false };

    return (
        <div className="relative p-1.5 rounded-[2rem] bg-accent-primary/[0.03] ring-1 ring-inset ring-accent-primary/10">
            <div className="relative rounded-[calc(2rem-0.375rem)] bg-bg-card shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)] dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)] p-5 overflow-hidden">
                {/* Decorative glowing orb behind */}
                <div className="absolute -top-10 -right-10 w-40 h-40 bg-accent-primary/20 rounded-full blur-3xl pointer-events-none" />
                
                {/* Decorative corner ticks — subtle "instrument panel" cue */}
                <CornerTicks />

                <div className="flex items-start justify-between gap-3 mb-4 relative z-10">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                           <span className="w-1.5 h-1.5 rounded-full bg-accent-primary/80" />
                           <p style={{ fontFamily: FONT_MONO, letterSpacing: '0.14em' }} className="text-[9px] text-text-tertiary uppercase font-medium">Active Engine</p>
                        </div>
                        <h3
                            style={{ fontFamily: 'CelebMF, sans-serif', letterSpacing: '-0.01em' }}
                            className="text-[28px] leading-tight text-text-primary truncate"
                        >
                            {model.name}
                        </h3>
                    </div>
                    
                    {/* Status badge */}
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/5 dark:bg-white/5 ring-1 ring-inset ring-black/10 dark:ring-white/10 backdrop-blur-md flex-shrink-0">
                        <span className={`relative inline-flex w-1.5 h-1.5 rounded-full ${statusDot.color} ring-2 ${statusDot.ring}`} aria-hidden>
                            {statusDot.pulse && <span className={`absolute inset-0 rounded-full ${statusDot.color} animate-ping opacity-60`} />}
                        </span>
                        <span style={{ fontFamily: FONT_MONO, letterSpacing: '0.1em' }} className="text-[9.5px] font-medium text-text-secondary uppercase">
                            {statusDot.label}
                        </span>
                    </div>
                </div>

                {/* Spec strip */}
                <div style={{ fontFamily: FONT_MONO }} className="flex items-center gap-3 text-[11px] text-text-secondary mb-5 relative z-10 opacity-80">
                    <SpecCell label="SIZE" value={formatSize(model.sizeMb)} />
                    <Divider />
                    <SpecCell label="SPEED" value={SPEED_LABEL[model.speed]} />
                    <Divider />
                    <SpecCell label="ACCURACY" value={ACCURACY_LABEL[model.accuracy]} />
                    <Divider />
                    <SpecCell label="LANG" value={model.multilingual ? 'MULTI' : 'EN'} />
                    {isRecommended && (
                        <>
                            <Divider />
                            <span className="text-emerald-500 dark:text-emerald-300/90 font-medium tracking-wide">RECOMMENDED</span>
                        </>
                    )}
                </div>

                {/* Signal flow + deselect */}
                <div className="flex items-center justify-between gap-3 pt-4 border-t border-border-subtle/50 relative z-10">
                    <SignalFlow live={preloadStatus !== 'idle'} isAppleSilicon={isAppleSilicon} />
                    <button
                        onClick={onDeselect}
                        className="group relative flex items-center justify-center h-7 px-3 rounded-full bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 ring-1 ring-inset ring-black/10 dark:ring-white/10 transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97]"
                        aria-label={`Switch away from ${model.name}`}
                    >
                        <span style={{ fontFamily: FONT_MONO, letterSpacing: '0.08em' }} className="text-[9.5px] text-text-secondary font-medium uppercase">SWITCH</span>
                    </button>
                </div>
            </div>
        </div>
    );
}

function SpecCell({ label, value }: { label: string; value: string }) {
    return (
        <span className="inline-flex items-baseline gap-1">
            <span className="text-text-tertiary text-[8.5px] tracking-wider">{label}</span>
            <span className="text-text-primary tabular-nums font-medium">{value}</span>
        </span>
    );
}

function Divider() {
    return <span className="text-border-muted dark:text-text-tertiary/40">·</span>;
}

function CornerTicks() {
    const tick = 'absolute w-2 h-px bg-accent-primary/30';
    const tickV = 'absolute w-px h-2 bg-accent-primary/30';
    return (
        <div className="pointer-events-none">
            <span className={`${tick} top-3 left-3`} />
            <span className={`${tickV} top-3 left-3`} />
            <span className={`${tick} top-3 right-3`} />
            <span className={`${tickV} top-3 right-3`} />
            <span className={`${tick} bottom-3 left-3`} />
            <span className={`${tickV} bottom-3 left-3`} />
            <span className={`${tick} bottom-3 right-3`} />
            <span className={`${tickV} bottom-3 right-3`} />
        </div>
    );
}

function EngineRow({
    model, isRecommended, isDownloading, onUse, onDownload, onDelete,
}: {
    model: ModelInfo;
    isRecommended: boolean;
    isDownloading: boolean;
    onUse: () => void;
    onDownload: () => void;
    onDelete: () => void;
}) {
    const isAvailable = model.status === 'available';
    const isError = model.status === 'error';

    return (
        <div className="group relative flex items-center gap-4 p-2 pr-3 rounded-[20px] bg-transparent hover:bg-black/[0.03] dark:hover:bg-bg-elevated/50 transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ring-1 ring-transparent hover:ring-border-subtle/50">
            {/* Minimal line indicator */}
            <span
                className={`w-1 h-8 rounded-full ml-1 ${
                    isAvailable ? 'bg-emerald-400/50'
                    : isDownloading ? 'bg-accent-primary/50'
                    : isError ? 'bg-red-400/50'
                    : 'bg-border-subtle/50'
                }`}
                aria-hidden
            />

            <div className="flex-1 min-w-0 py-1">
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-[14px] font-medium text-text-primary tracking-tight truncate">
                        {model.name}
                    </span>
                    {isRecommended && (
                        <span style={{ fontFamily: FONT_MONO, letterSpacing: '0.08em' }} className="text-[8.5px] px-1.5 py-0.5 rounded text-emerald-600 dark:text-emerald-300 bg-emerald-500/10 uppercase font-medium">
                            ★ recommended
                        </span>
                    )}
                    {model.requiresAppleSilicon && (
                        <span style={{ fontFamily: FONT_MONO, letterSpacing: '0.08em' }} className="text-[8.5px] px-1.5 py-0.5 rounded text-violet-600 dark:text-violet-300 bg-violet-500/10 uppercase font-medium">
                            metal
                        </span>
                    )}
                </div>
                <div style={{ fontFamily: FONT_MONO }} className="flex items-center gap-2 text-[10px] text-text-tertiary tabular-nums opacity-80">
                    <span>{formatSize(model.sizeMb)}</span>
                    <Divider />
                    <span>{SPEED_LABEL[model.speed]}</span>
                    <Divider />
                    <span>{ACCURACY_LABEL[model.accuracy]}</span>
                    <Divider />
                    <span>{model.multilingual ? 'MULTI' : 'EN'}</span>
                </div>
                {isDownloading && (
                    <div className="mt-2.5 h-[3px] bg-black/10 dark:bg-white/10 rounded-full overflow-hidden w-48 relative" aria-label="Downloading">
                        <div className="absolute top-0 left-0 h-full w-1/3 bg-accent-primary rounded-full animate-whisper-dl" />
                    </div>
                )}
                {isError && (
                    <p className="text-[10px] text-red-500 dark:text-red-400 mt-1.5 font-medium">
                        {model.errorMessage ?? 'Download failed — try again'}
                    </p>
                )}
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
                {isAvailable && (
                    <button
                        onClick={onUse}
                        aria-label={`Load ${model.name}`}
                        className="group/btn relative flex items-center justify-center h-8 px-4 rounded-full bg-accent-primary text-white transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent-primary/90 active:scale-[0.96] shadow-md shadow-accent-primary/20"
                    >
                        <span style={{ fontFamily: FONT_MONO, letterSpacing: '0.06em' }} className="text-[10px] font-semibold uppercase">Load</span>
                    </button>
                )}
                {model.status === 'missing' && (
                    <button
                        onClick={onDownload}
                        disabled={isDownloading}
                        aria-label={`Download ${model.name}`}
                        className="group/btn relative flex items-center justify-center h-8 pl-4 pr-1.5 rounded-full bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 ring-1 ring-inset ring-black/10 dark:ring-white/10 transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96] disabled:opacity-50 disabled:active:scale-100"
                    >
                        <span style={{ fontFamily: FONT_MONO, letterSpacing: '0.06em' }} className="text-[10px] text-text-primary uppercase font-medium mr-2">Install</span>
                        <div className="w-[22px] h-[22px] rounded-full bg-black/5 dark:bg-white/10 flex items-center justify-center group-hover/btn:bg-black/10 dark:group-hover/btn:bg-white/20 transition-colors">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-text-primary"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        </div>
                    </button>
                )}
                {isError && (
                    <button
                        onClick={onDownload}
                        disabled={isDownloading}
                        aria-label={`Retry download for ${model.name}`}
                        className="group/btn relative flex items-center justify-center h-8 px-4 rounded-full bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96] disabled:opacity-50"
                    >
                        <span style={{ fontFamily: FONT_MONO, letterSpacing: '0.06em' }} className="text-[10px] uppercase font-medium">Retry</span>
                    </button>
                )}
                {isAvailable && (
                    <button
                        onClick={onDelete}
                        aria-label={`Delete ${model.name}`}
                        className="w-8 h-8 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-red-500/10 text-text-tertiary hover:text-red-500 transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.90]"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                    </button>
                )}
            </div>
        </div>
    );
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Main component
 * ────────────────────────────────────────────────────────────────────────── */

export function LocalWhisperModelPanel() {
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [hardware, setHardware] = useState<HardwareInfo | null>(null);
    const [activeModel, setActiveModel] = useState<string>('');
    const [downloadingSet, setDownloadingSet] = useState<Set<string>>(new Set());
    const [preloadStatus, setPreloadStatus] = useState<'idle' | 'warming' | 'ready'>('idle');
    const [loading, setLoading] = useState(true);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const preloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const loadModels = useCallback(async () => {
        const res = await electronAPI?.localWhisperGetModels?.();
        if (res) setModels(res.models ?? []);
    }, []);

    useEffect(() => {
        let mounted = true;
        Promise.all([
            electronAPI?.localWhisperGetModels?.().then((res: { models: ModelInfo[]; activeModelId: string }) => {
                if (!mounted) return;
                const list = res?.models ?? [];
                setModels(list);
                const saved = res?.activeModelId ?? '';
                const savedIsAvailable = list.find(m => m.id === saved)?.status === 'available';
                if (saved && savedIsAvailable) {
                    setActiveModel(saved);
                    electronAPI?.localWhisperPreload?.(saved);
                } else {
                    const first = list.find(m => m.status === 'available');
                    if (first) {
                        setActiveModel(first.id);
                        electronAPI?.localWhisperSetModel?.(first.id);
                        electronAPI?.localWhisperPreload?.(first.id);
                    }
                }
            }),
            electronAPI?.localWhisperGetHardware?.().then((hw: HardwareInfo) => {
                if (mounted) setHardware(hw);
            }),
        ]).finally(() => { if (mounted) setLoading(false); });
        return () => { mounted = false; };
    }, []);

    useEffect(() => {
        const hasPending = downloadingSet.size > 0;
        if (hasPending && !pollRef.current) {
            pollRef.current = setInterval(loadModels, 1500);
        } else if (!hasPending && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
        return () => {
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        };
    }, [downloadingSet, loadModels]);

    useEffect(() => () => {
        if (preloadTimerRef.current) clearTimeout(preloadTimerRef.current);
    }, []);

    useEffect(() => {
        const unsubProgress = electronAPI?.onLocalWhisperDownloadProgress?.((_d: { modelId: string; progress: number }) => {
            // Per-file progress — UI uses indeterminate animation
        });
        const unsubComplete = electronAPI?.onLocalWhisperDownloadComplete?.((data: { modelId: string }) => {
            setDownloadingSet(prev => { const s = new Set(prev); s.delete(data.modelId); return s; });
            setModels(prev => prev.map(m => m.id === data.modelId ? { ...m, status: 'available' as const } : m));
            setActiveModel(cur => {
                if (!cur) {
                    electronAPI?.localWhisperSetModel?.(data.modelId);
                    electronAPI?.localWhisperPreload?.(data.modelId);
                    return data.modelId;
                }
                return cur;
            });
        });
        const unsubError = electronAPI?.onLocalWhisperDownloadError?.((data: { modelId: string; error: string }) => {
            setModels(prev => prev.map(m => m.id === data.modelId ? { ...m, status: 'error' as const, errorMessage: data.error } : m));
            setDownloadingSet(prev => { const s = new Set(prev); s.delete(data.modelId); return s; });
        });
        return () => { unsubProgress?.(); unsubComplete?.(); unsubError?.(); };
    }, []);

    const handleDownload = async (modelId: string) => {
        let alreadyQueued = false;
        setDownloadingSet(prev => {
            if (prev.has(modelId)) { alreadyQueued = true; return prev; }
            return new Set([...prev, modelId]);
        });
        if (alreadyQueued) return;

        setModels(prev => prev.map(m => m.id === modelId ? { ...m, status: 'downloading' } : m));
        const result = await electronAPI?.localWhisperStartDownload?.(modelId);
        if (result?.error === 'already-downloading') return;
        if (!result?.success) {
            setDownloadingSet(prev => { const s = new Set(prev); s.delete(modelId); return s; });
            setModels(prev => prev.map(m => m.id === modelId
                ? { ...m, status: 'error', errorMessage: result?.error ?? 'Failed to start download' }
                : m
            ));
        }
    };

    const handleSelect = async (modelId: string) => {
        setActiveModel(modelId);
        await electronAPI?.localWhisperSetModel?.(modelId);
        setPreloadStatus('warming');
        const result = await electronAPI?.localWhisperPreload?.(modelId);
        if (result?.success) {
            setPreloadStatus('ready');
            if (preloadTimerRef.current) clearTimeout(preloadTimerRef.current);
            preloadTimerRef.current = setTimeout(() => setPreloadStatus('idle'), 4000);
        } else {
            setPreloadStatus('idle');
        }
    };

    const handleDelete = async (modelId: string) => {
        await electronAPI?.localWhisperDeleteModel?.(modelId);
        if (activeModel === modelId) {
            await electronAPI?.localWhisperSetModel?.('');
            setActiveModel('');
        }
        await loadModels();
    };

    const handleDeselectActive = () => {
        setActiveModel('');
        electronAPI?.localWhisperSetModel?.('');
    };

    if (loading) {
        return (
            <div className="relative p-1.5 rounded-[2rem] bg-black/5 dark:bg-white/[0.02] ring-1 ring-inset ring-black/5 dark:ring-white/[0.05]">
                <div className="relative bg-bg-card shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)] rounded-[calc(2rem-0.375rem)] p-6 space-y-6 overflow-hidden">
                    <div className="animate-pulse space-y-5">
                        <div className="space-y-2">
                            <div className="h-6 w-1/3 bg-black/5 dark:bg-white/5 rounded-md" />
                            <div className="h-4 w-1/2 bg-black/5 dark:bg-white/5 rounded-md" />
                        </div>
                        <div className="h-32 bg-black/5 dark:bg-white/5 rounded-[20px]" />
                        <div className="space-y-2">
                            <div className="h-14 bg-black/5 dark:bg-white/5 rounded-xl" />
                            <div className="h-14 bg-black/5 dark:bg-white/5 rounded-xl" />
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const visibleModels = models.filter(m => !m.requiresAppleSilicon || hardware?.isAppleSilicon);
    const active = visibleModels.find(m => m.id === activeModel) ?? null;
    const alternates = visibleModels.filter(m => m.id !== activeModel);

    return (
        <div className="relative p-1.5 rounded-[2rem] bg-black/5 dark:bg-white/[0.02] ring-1 ring-inset ring-black/5 dark:ring-white/[0.05]">
            <div className="relative bg-bg-card shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)] dark:shadow-[inset_0_1px_1px_rgba(255,255,255,0.15)] rounded-[calc(2rem-0.375rem)] p-6 sm:p-7 space-y-8 overflow-hidden">
                {/* ── Hardware identification strip ── */}
                <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                            <h2
                                style={{ fontFamily: 'CelebMF, sans-serif', letterSpacing: '-0.01em' }}
                                className="text-[22px] text-text-primary leading-tight"
                            >
                                Local Inference
                            </h2>
                            <p
                                style={{ fontFamily: FONT_MONO, letterSpacing: '0.08em' }}
                                className="text-[10px] text-text-tertiary uppercase mt-1.5 opacity-80"
                            >
                                Whisper · Dual-Channel · Mic = You · System = Them
                            </p>
                        </div>
                    </div>
                    <HardwareStrip hardware={hardware} />
                </div>

                {/* ── Active engine hero ── */}
                <ActiveEngineHero
                    model={active}
                    isRecommended={hardware?.recommendedModel === active?.id}
                    preloadStatus={preloadStatus}
                    onDeselect={handleDeselectActive}
                    isAppleSilicon={!!hardware?.isAppleSilicon}
                />

                {/* ── Alternate engines ── */}
                {alternates.length > 0 && (
                    <div className="space-y-4 relative z-10">
                        <div className="flex items-center gap-3">
                            <span
                                style={{ fontFamily: FONT_MONO, letterSpacing: '0.14em' }}
                                className="text-[10px] text-text-tertiary uppercase font-medium"
                            >
                                {active ? 'Alternates' : 'Available Engines'}
                            </span>
                            <div className="flex-1 h-px bg-border-subtle/50" />
                        </div>
                        <div className="space-y-1">
                            {alternates.map(model => (
                                <EngineRow
                                    key={model.id}
                                    model={model}
                                    isRecommended={hardware?.recommendedModel === model.id}
                                    isDownloading={model.status === 'downloading' || downloadingSet.has(model.id)}
                                    onUse={() => handleSelect(model.id)}
                                    onDownload={() => handleDownload(model.id)}
                                    onDelete={() => handleDelete(model.id)}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {/* ── Footer note ── */}
                {hardware?.tier === 'limited' && (
                    <div className="pt-2">
                        <p
                            style={{ fontFamily: FONT_MONO, letterSpacing: '0.04em' }}
                            className="text-[9.5px] text-amber-500 dark:text-amber-300/80 uppercase"
                        >
                            ⓘ Limited hardware — cloud STT (Groq / Deepgram) recommended for long sessions.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

