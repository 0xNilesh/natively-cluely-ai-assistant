import React, { useState, useEffect, useCallback } from 'react';
import {
    CheckCircle, AlertCircle,
    Mic, Brain, Search, Shield, Loader2,
    RefreshCw, CalendarClock, Trash2, ArrowUpRight, Info
} from 'lucide-react';
import { NativelyLogoMark } from '../NativelyLogoMark';

// ─── Types ───────────────────────────────────────────────────
interface QuotaBucket { used: number; limit: number; remaining: number; }
interface UsageData {
    plan: string;
    member_since: string;
    quota: {
        transcription: QuotaBucket;
        ai:            QuotaBucket;
        search:        QuotaBucket;
        resets_at:     string;
    };
}

const PLAN_URL = 'https://checkout.dodopayments.com/buy/pdt_0NbFixGmD8CSeawb5qvVl';

// ─── Quota bar ───────────────────────────────────────────────
function QuotaBar({ label, icon: Icon, bucket, barColor }: {
    label:    string;
    icon:     React.ElementType;
    bucket:   QuotaBucket;
    barColor: string;
}) {
    const pct    = bucket.limit > 0 ? Math.min(100, (bucket.used / bucket.limit) * 100) : 0;
    const isHigh = pct >= 80;
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Icon size={12} className={isHigh ? 'text-amber-400' : 'text-text-tertiary'} strokeWidth={1.75} />
                    <span className="text-[12px] text-text-secondary">{label}</span>
                </div>
                <span className={`text-[12px] tabular-nums font-medium ${isHigh ? 'text-amber-400' : 'text-text-tertiary'}`}>
                    {bucket.used.toLocaleString()}<span className="font-normal text-text-tertiary/60"> / {bucket.limit.toLocaleString()}</span>
                </span>
            </div>
            <div className="h-[5px] w-full bg-bg-input rounded-full overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${isHigh ? 'bg-amber-400' : barColor}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}

// ─── Card wrapper ────────────────────────────────────────────
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={`bg-bg-item-surface rounded-2xl border border-border-subtle overflow-hidden ${className}`}>
            {children}
        </div>
    );
}

// ─── Component ───────────────────────────────────────────────
export const NativelyApiSettings: React.FC = () => {
    const [apiKey,         setApiKey]         = useState('');
    const [isSaved,        setIsSaved]        = useState(false);
    const [isLoading,      setIsLoading]      = useState(true);
    const [isSaving,       setIsSaving]       = useState(false);
    const [error,          setError]          = useState<string | null>(null);
    const [justSaved,      setJustSaved]      = useState(false);
    const [usageData,      setUsageData]      = useState<UsageData | null>(null);
    const [usageError,     setUsageError]     = useState<string | null>(null);
    const [isLoadingUsage, setIsLoadingUsage] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const creds = await window.electronAPI.getStoredCredentials();
                if (creds.hasNativelyKey) { setApiKey('•'.repeat(24)); setIsSaved(true); }
            } catch (e) { console.error('[NativelyApi]', e); }
            finally { setIsLoading(false); }
        })();
    }, []);

    const fetchUsage = useCallback(async () => {
        setIsLoadingUsage(true);
        setUsageError(null);
        try {
            const r = await window.electronAPI.getNativelyUsage();
            if (r.ok && r.quota) {
                setUsageData(r as UsageData);
            } else {
                setUsageError(
                    r.error === 'subscription_inactive' ? 'Subscription inactive — renew to restore access.'
                    : r.error === 'key_not_found'       ? 'Key not recognised by server.'
                    : r.error === 'invalid_key_format'  ? 'Invalid key format.'
                    : r.error === 'network_error' || r.error?.includes('fetch')
                                                        ? 'Could not reach server.'
                    : `Server error: ${r.error ?? 'unknown'}`
                );
            }
        } catch { setUsageError('Failed to load usage.'); }
        finally  { setIsLoadingUsage(false); }
    }, []);

    useEffect(() => { if (isSaved && !isLoading) fetchUsage(); }, [isSaved, isLoading, fetchUsage]);

    const handleSave = async () => {
        if (!apiKey.trim() || apiKey.includes('•')) return;
        setIsSaving(true); setError(null);
        try {
            const r = await window.electronAPI.setNativelyApiKey(apiKey.trim());
            if (r.success) {
                setApiKey('•'.repeat(24)); setIsSaved(true); setJustSaved(true);
                setTimeout(() => setJustSaved(false), 2500);
                // @ts-ignore
                window.electronAPI?.setDefaultModel?.('natively').catch(console.error);
                // @ts-ignore
                window.electronAPI?.setSttProvider?.('natively').catch(console.error);
            } else { setError(r.error || 'Failed to save API key'); }
        } catch (e: any) { setError(e.message || 'Unexpected error'); }
        finally { setIsSaving(false); }
    };

    const handleClear = () => {
        setApiKey(''); setIsSaved(false); setError(null); setUsageData(null); setUsageError(null);
        window.electronAPI.setNativelyApiKey('').catch(() => {});
    };

    const openExternal = (url: string) => { (window.electronAPI as any)?.openExternal?.(url); };

    const isDirty   = apiKey.length > 0 && !apiKey.includes('•') && !isSaved;
    const planLabel = usageData?.plan ? usageData.plan.charAt(0).toUpperCase() + usageData.plan.slice(1) : null;
    const fmtDate   = (iso: string) => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return iso; } };

    return (
        <div className="space-y-4 animated fadeIn">

            {/* ── Page title ───────────────────────────────────── */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-[15px] font-semibold text-text-primary tracking-[-0.01em]">Natively API</h3>
                    <p className="text-[12px] text-text-tertiary mt-0.5 leading-snug">
                        Managed transcription, AI &amp; search
                    </p>
                </div>
                {!isLoading && isSaved && (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]" />
                        <span className="text-[10px] font-semibold text-emerald-500 tracking-wide">
                            {planLabel ?? 'Connected'}
                        </span>
                    </div>
                )}
            </div>

            {/* ── API Key card ─────────────────────────────────── */}
            <Card>
                {/* Card header */}
                <div className="flex items-center gap-3 px-5 pt-5 pb-4">
                    {/* Tinted icon well — Apple style */}
                    <div className="w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-500/20 flex items-center justify-center shrink-0">
                        <NativelyLogoMark size={18} className="text-blue-400" />
                    </div>
                    <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-text-primary">API Key</p>
                        <p className="text-[11px] text-text-tertiary leading-snug mt-0.5">
                            Your Natively API key from your subscription email
                        </p>
                    </div>
                </div>

                {/* Hairline divider */}
                <div className="h-px bg-border-subtle mx-5" />

                {/* Body */}
                <div className="px-5 pt-4 pb-5 space-y-3">
                    {/* Label row */}
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-text-tertiary uppercase tracking-widest">Secret key</span>
                        {isSaved && (
                            <button
                                onClick={handleClear}
                                className="flex items-center gap-1 text-[11px] text-red-400/80 hover:text-red-400 transition-colors duration-150 cursor-pointer"
                            >
                                <Trash2 size={11} strokeWidth={2} />
                                Remove
                            </button>
                        )}
                    </div>

                    {/* Input — with inset shadow for Apple depth */}
                    <input
                        type="text"
                        value={apiKey}
                        onChange={e => { setApiKey(e.target.value); setIsSaved(false); setError(null); }}
                        onKeyDown={e => e.key === 'Enter' && handleSave()}
                        placeholder="natively_api_..."
                        spellCheck={false}
                        autoComplete="off"
                        className={`w-full bg-bg-input border rounded-xl px-3.5 py-2.5 text-[13px] font-mono text-text-primary
                            placeholder:text-text-tertiary/50 placeholder:font-sans placeholder:text-[13px]
                            shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]
                            focus:outline-none transition-all duration-150
                            ${error
                                ? 'border-red-500/40 focus:border-red-500/60 focus:ring-1 focus:ring-red-500/20'
                                : 'border-border-subtle focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/15'
                            }`}
                    />

                    {/* Error */}
                    {error && (
                        <div className="flex items-center gap-2 px-3 py-2.5 bg-red-500/8 border border-red-500/15 rounded-xl text-[12px] text-red-400">
                            <AlertCircle size={13} className="shrink-0" />
                            {error}
                        </div>
                    )}

                    {/* Save button */}
                    <button
                        onClick={handleSave}
                        disabled={isSaving || !isDirty}
                        className={`w-full py-2.5 rounded-xl text-[13px] font-medium transition-all duration-150 select-none
                            ${isSaving         ? 'bg-blue-900/30 border border-blue-800/30 text-blue-400/40 cursor-wait'
                            : justSaved        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 cursor-pointer'
                            : !isDirty         ? 'bg-blue-900/30 border border-blue-800/30 text-blue-400/40 cursor-default'
                            :                   'bg-blue-600 hover:bg-blue-500 text-white shadow-sm shadow-blue-900/30 active:scale-[0.99] cursor-pointer'
                            }`}
                    >
                        {isSaving   ? <span className="flex items-center justify-center gap-2"><Loader2 size={13} className="animate-spin" />Saving…</span>
                        : justSaved ? <span className="flex items-center justify-center gap-2"><CheckCircle size={13} />Saved</span>
                        :             'Save key'}
                    </button>

                    {/* Hint */}
                    <p className="text-[11px] text-text-secondary leading-relaxed text-center">
                        Don't have a key?{' '}
                        <span
                            onClick={() => openExternal(PLAN_URL)}
                            className="text-blue-400 hover:text-blue-300 cursor-pointer transition-colors duration-150"
                        >
                            Subscribe to get one
                        </span>
                    </p>
                </div>
            </Card>

            {/* ── Usage card (connected state) ─────────────────── */}
            {isSaved && (
                <Card>
                    {/* Header */}
                    <div className="flex items-center justify-between px-5 pt-5 pb-4">
                        <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center shrink-0">
                                {isLoadingUsage && !usageData
                                    ? <Loader2 size={15} className="animate-spin text-violet-400" />
                                    : <CalendarClock size={15} className="text-violet-400" strokeWidth={1.75} />
                                }
                            </div>
                            <div>
                                <p className="text-[13px] font-semibold text-text-primary">Usage this month</p>
                                {usageData && (
                                    <p className="text-[11px] text-text-tertiary mt-0.5">
                                        Resets {fmtDate(usageData.quota.resets_at)}
                                    </p>
                                )}
                            </div>
                        </div>
                        <button
                            onClick={fetchUsage}
                            disabled={isLoadingUsage}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] text-text-tertiary
                                hover:text-text-secondary hover:bg-bg-input transition-all duration-150
                                disabled:opacity-40 cursor-pointer"
                        >
                            <RefreshCw size={11} className={isLoadingUsage ? 'animate-spin' : ''} strokeWidth={2} />
                            Refresh
                        </button>
                    </div>

                    {usageError && !usageData && (
                        <div className="mx-5 mb-5 flex items-center gap-2 px-3 py-2.5 bg-red-500/8 border border-red-500/15 rounded-xl text-[12px] text-red-400">
                            <AlertCircle size={13} className="shrink-0" /> {usageError}
                        </div>
                    )}

                    {usageData && (
                        <>
                            {/* Stat strip */}
                            <div className="mx-5 mb-4 grid grid-cols-3 bg-bg-input border border-border-subtle rounded-2xl overflow-hidden divide-x divide-border-subtle">
                                {[
                                    { label: 'STT mins',   value: usageData.quota.transcription.used, color: 'text-blue-400',    glow: 'rgba(59,130,246,0.5)'   },
                                    { label: 'AI calls',   value: usageData.quota.ai.used,            color: 'text-violet-400',  glow: 'rgba(139,92,246,0.5)'   },
                                    { label: 'Searches',   value: usageData.quota.search.used,        color: 'text-emerald-400', glow: 'rgba(16,185,129,0.5)'   },
                                ].map(({ label, value, color }) => (
                                    <div key={label} className="flex flex-col items-center py-4 px-3 gap-1">
                                        <span className={`text-[22px] font-semibold tabular-nums tracking-tight leading-none ${color}`}>
                                            {value.toLocaleString()}
                                        </span>
                                        <span className="text-[10px] text-text-tertiary font-medium tracking-wide">
                                            {label}
                                        </span>
                                    </div>
                                ))}
                            </div>

                            {/* Progress bars */}
                            <div className="px-5 pb-5 space-y-3.5">
                                <QuotaBar label="Transcription" icon={Mic}    bucket={usageData.quota.transcription} barColor="bg-blue-500"    />
                                <QuotaBar label="AI requests"   icon={Brain}  bucket={usageData.quota.ai}            barColor="bg-violet-500"  />
                                <QuotaBar label="Web searches"  icon={Search} bucket={usageData.quota.search}        barColor="bg-emerald-500" />
                            </div>
                        </>
                    )}
                </Card>
            )}

            {/* ── Plan card ────────────────────────────────────── */}
            <Card>
                <div className="px-5 pt-5 pb-4">
                    <div className="flex items-start justify-between mb-5">
                        <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center shrink-0">
                                <NativelyLogoMark size={18} className="text-amber-400" />
                            </div>
                            <div>
                                <p className="text-[13px] font-semibold text-text-primary">Natively Standard</p>
                                <p className="text-[11px] text-text-tertiary mt-0.5">Managed, no per-user key setup</p>
                            </div>
                        </div>
                        <div className="flex items-baseline gap-0.5 shrink-0 ml-4">
                            <span className="text-[14px] font-medium text-text-tertiary line-through opacity-70 mr-1">$15</span>
                            <span className="text-[22px] font-semibold text-text-primary tracking-tight">$7</span>
                            <span className="text-[12px] text-text-tertiary">/mo</span>
                        </div>
                    </div>

                    {/* Feature grid */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 mb-5">
                        {([
                            { icon: Mic,    label: '200 min transcription / mo' },
                            { icon: Brain,  label: '500 AI requests / mo'       },
                            { icon: Search, label: '20 web searches / mo'        },
                            { icon: Shield, label: 'No key management'           },
                        ] as const).map(({ icon: Icon, label }) => (
                            <div key={label} className="flex items-center gap-2">
                                <div className="w-5 h-5 rounded-md bg-bg-input border border-border-subtle flex items-center justify-center shrink-0">
                                    <Icon size={11} className="text-text-tertiary" strokeWidth={1.75} />
                                </div>
                                <span className="text-[11px] text-text-secondary leading-tight">{label}</span>
                            </div>
                        ))}
                    </div>

                    {/* AI quota note */}
                    <div className="flex items-start gap-2 mb-5 px-3 py-2.5 bg-bg-input rounded-xl border border-border-subtle">
                        <Info size={11} className="text-text-tertiary shrink-0 mt-[1px]" strokeWidth={2} />
                        <p className="text-[11px] text-text-tertiary leading-relaxed">
                            AI requests include chat replies, meeting title & summary generation, and embeddings — not just manual messages.
                        </p>
                    </div>

                    {isSaved ? (
                        <div className="w-full py-2.5 rounded-xl text-[13px] font-semibold
                            bg-emerald-500/10 border border-emerald-500/20 text-emerald-400
                            flex items-center justify-center gap-1.5">
                            <CheckCircle size={13} strokeWidth={2} />
                            Subscribed
                        </div>
                    ) : (
                        <button
                            onClick={() => openExternal(PLAN_URL)}
                            className="w-full py-2.5 rounded-xl text-[13px] font-semibold text-white
                                bg-blue-600 hover:bg-blue-500 active:scale-[0.99]
                                shadow-sm shadow-blue-900/30
                                transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                            Subscribe
                            <ArrowUpRight size={13} strokeWidth={2.5} />
                        </button>
                    )}
                </div>
            </Card>

            {/* ── How it works ─────────────────────────────────── */}
            <Card>
                <div className="px-5 py-4">
                    <div className="flex items-center justify-between mb-3.5">
                        <p className="text-[10px] font-semibold text-text-tertiary uppercase tracking-widest">
                            How it works
                        </p>
                        <button
                            onClick={() => openExternal('https://natively.software/pro')}
                            className="flex items-center gap-1 text-[10px] font-semibold text-blue-400 hover:text-blue-300 uppercase tracking-widest transition-colors cursor-pointer"
                        >
                            Watch Demo <ArrowUpRight size={10} strokeWidth={2} />
                        </button>
                    </div>
                    <div className="space-y-3">
                        {[
                            { step: '1', text: 'Subscribe above and complete checkout on Dodo Payments.' },
                            { step: '2', text: 'Your API key is emailed instantly to your inbox.'        },
                            { step: '3', text: 'Paste it here — Natively handles the rest automatically.' },
                        ].map(({ step, text }) => (
                            <div key={step} className="flex items-start gap-3">
                                <div className="w-5 h-5 rounded-full bg-bg-input border border-border-subtle flex items-center justify-center text-[10px] font-bold text-text-tertiary shrink-0 mt-[1px]">
                                    {step}
                                </div>
                                <p className="text-[12px] text-text-secondary leading-relaxed">{text}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </Card>

        </div>
    );
};
