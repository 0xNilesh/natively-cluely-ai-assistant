import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, Sparkles, Info } from 'lucide-react';
import { cn } from '../../src/lib/utils';
import { RemoteCampaign } from './useAdCampaigns';
import { useResolvedTheme } from '../../src/hooks/useResolvedTheme';

interface RemoteCampaignToasterProps {
    className?: string;
    isOpen: boolean;
    campaign: RemoteCampaign;
    onDismiss: (id?: string) => void;
}

export const RemoteCampaignToaster: React.FC<RemoteCampaignToasterProps> = ({
    className,
    isOpen,
    campaign,
    onDismiss
}) => {
    const isLight = useResolvedTheme() === 'light';

    // Dev override shortcut logic to dismiss
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!import.meta.env.DEV) return;
            if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
                e.preventDefault();
                if (isOpen) onDismiss(campaign?.id);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onDismiss]);

    const handlePrimaryAction = async () => {
        if (!campaign) return;

        if (campaign.url && window.electronAPI && window.electronAPI.openExternal) {
            try {
                await window.electronAPI.openExternal(campaign.url);
            } catch (err) {
                console.error("Failed to open external url:", err);
            }
        } else if (campaign.url) {
            // Fallback for web mode testing if external API is missing
            window.open(campaign.url, '_blank');
        }

        onDismiss(campaign.id);
    };

    const renderIcon = () => {
        if (!campaign) return null;

        const iconSize = 24;
        const iconClass = isLight
            ? "text-[#1C1C1E] relative z-10"
            : "text-white relative z-10 drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]";

        switch (campaign.icon) {
            case 'alert':
                return <AlertCircle size={iconSize} className={iconClass} fill={isLight ? '#1C1C1E' : 'white'} />;
            case 'sparkles':
                return <Sparkles size={iconSize} className={iconClass} fill={isLight ? '#1C1C1E' : 'white'} />;
            case 'info':
            default:
                return <Info size={iconSize} className={iconClass} fill={isLight ? '#1C1C1E' : 'white'} />;
        }
    };

    if (!campaign) return null;

    return (
        <AnimatePresence>
            {isOpen && (
                <div className={`fixed inset-0 z-[9998] flex items-center justify-center ${isLight ? 'bg-black/30 backdrop-blur-[2px]' : 'bg-black/60 backdrop-blur-[2px]'}`}>
                    <motion.div
                        initial={{ opacity: 0, scale: 0.94, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15, ease: [0.32, 0, 0.67, 0] } }}
                        transition={{ type: "spring", stiffness: 450, damping: 35 }}
                        className={cn(
                            "relative w-[480px] overflow-hidden",
                            "rounded-[24px]",
                            isLight
                                ? "bg-[#F8F8FA] border border-black/[0.08] shadow-[0_32px_64px_-16px_rgba(0,0,0,0.15),0_8px_32px_-8px_rgba(0,0,0,0.08)]"
                                : "bg-[#0B0F14] border border-white/[0.08] shadow-[0_32px_64px_-16px_rgba(0,0,0,0.8),0_8px_32px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.06)]",
                            "flex flex-col items-center pb-[24px]",
                            className
                        )}
                    >
                        {/* Background Structure */}
                        <div className={`absolute inset-0 ${isLight ? 'bg-[#F8F8FA]' : 'bg-[#121826]'}`} />
                        <div className={`absolute top-0 left-0 right-0 h-[300px] bg-gradient-to-b pointer-events-none ${isLight ? 'from-black/[0.02] to-transparent' : 'from-white/[0.03] to-transparent'}`} />

                        {/* Top Sparkle Border */}
                        <div className={`absolute top-0 left-[20%] right-[20%] h-px bg-gradient-to-r from-transparent to-transparent ${isLight ? 'via-black/[0.1]' : 'via-white/[0.15]'}`} />

                        {/* Content Container */}
                        <div className="relative z-10 w-full flex flex-col items-center pt-[48px]">

                            {/* Prism Visual */}
                            <div className="relative w-[64px] h-[64px] mb-[32px]">
                                <motion.div
                                    animate={{
                                        rotate: [0, 10, 0, -10, 0],
                                        scale: [1, 1.05, 1]
                                    }}
                                    transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
                                    className="absolute inset-0 flex items-center justify-center"
                                >
                                    {/* Layered Glass Triangles for a 'Prism' effect */}
                                    <div className={`absolute w-full h-full border rotate-45 rounded-[12px] backdrop-blur-sm ${isLight ? 'border-black/20 bg-black/[0.03]' : 'border-white/20 bg-white/[0.02]'}`} />
                                    <div className={`absolute w-[80%] h-[80%] border -rotate-12 rounded-[8px] ${isLight ? 'border-black/10' : 'border-white/10'}`} />
                                    {renderIcon()}
                                </motion.div>
                                {/* Glow */}
                                <div className={`absolute inset-0 blur-[20px] rounded-full scale-150 ${isLight ? 'bg-black/5' : 'bg-white/5'}`} />
                            </div>

                            {/* Typography */}
                            <div className="text-center px-[40px] mb-[40px]">
                                <h3 className={`text-[32px] font-[700] leading-[1.1] tracking-[-0.04em] mb-[12px] antialiased ${isLight ? 'text-[#1C1C1E]' : 'text-white'}`}>
                                    {campaign.title}
                                </h3>
                                <p className={`text-[15px] leading-[1.6] mx-auto font-medium antialiased ${isLight ? 'text-black/50' : 'text-white/50'}`}>
                                    {campaign.message}
                                </p>
                            </div>

                            {/* Promotional "Urgency" Block */}
                            {campaign.type === 'promo' && (
                                <motion.div
                                    animate={{ y: [0, -4, 0] }}
                                    transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                                    className={`w-[380px] rounded-[20px] border p-[24px] mb-[40px] relative overflow-hidden group ${isLight ? 'bg-gradient-to-b from-[#4DA3FF]/[0.06] to-transparent border-[#4DA3FF]/[0.2] shadow-[0_8px_32px_-8px_rgba(77,163,255,0.1)]' : 'bg-gradient-to-b from-[#4DA3FF]/[0.08] to-transparent border-[#4DA3FF]/[0.15] shadow-[0_8px_32px_-8px_rgba(77,163,255,0.15)]'}`}
                                >
                                    <div className="absolute top-0 right-[-10px] p-4 opacity-[0.05] group-hover:opacity-10 transition-opacity">
                                        <Sparkles size={80} className="text-[#4DA3FF]" />
                                    </div>

                                    <div className="flex items-center justify-between mb-3 relative z-10">
                                        <div className="flex flex-col">
                                            <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#4DA3FF]/80">Spring Sale Bonus</span>
                                            <span className={`text-[14px] font-[900] tracking-widest font-mono mt-0.5 animate-pulse ${isLight ? 'text-[#1C1C1E]/90' : 'text-white/90'}`}>SAVE30</span>
                                        </div>
                                        <div className="px-2.5 py-1 rounded-full bg-[#4DA3FF] text-black text-[10px] font-black tracking-tighter shadow-[0_0_12px_rgba(77,163,255,0.5)] animate-pulse">
                                            LIMITED TIME
                                        </div>
                                    </div>

                                    <div className="flex items-end gap-3 leading-none relative z-10 mt-5">
                                        <div className="flex items-baseline gap-1.5">
                                            <span className={`text-[48px] font-[700] leading-none tracking-[-0.02em] ${isLight ? 'text-[#1C1C1E]' : 'text-white'}`}>$10</span>
                                            <span className="text-[14px] font-bold text-[#4DA3FF]/80 mb-1.5">$5 OFF</span>
                                        </div>
                                        <div className={`h-[24px] w-px mx-1 mb-2 ${isLight ? 'bg-black/10' : 'bg-white/10'}`} />
                                        <div className="mb-2">
                                            <span className={`text-[13px] font-semibold block leading-tight ${isLight ? 'text-black/70' : 'text-white/80'}`}>Lifetime Access</span>
                                            <span className={`text-[11px] font-medium line-through tracking-wide ${isLight ? 'text-black/30' : 'text-white/40'}`}>Regularly $15.00</span>
                                        </div>
                                    </div>
                                </motion.div>
                            )}

                            {/* Actions & Social Proof */}
                            <div className="w-full px-[48px] flex flex-col gap-4 relative">

                                {/* Pulse Glow behind button */}
                                <div className="absolute left-[48px] right-[48px] h-[54px] bg-[#4DA3FF]/40 blur-xl rounded-[18px] animate-[pulse_4s_ease-in-out_infinite] scale-105" />

                                <button
                                    onClick={handlePrimaryAction}
                                    className="relative w-full h-[54px] rounded-[18px] bg-gradient-to-r from-[#3B82F6] to-[#2563EB] text-white font-semibold text-[17px] tracking-wide transition-all hover:scale-[1.02] active:scale-[0.98] shadow-[0_20px_40px_-12px_rgba(59,130,246,0.4)] overflow-hidden group/btn"
                                >
                                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover/btn:animate-[shimmer_1.5s_infinite]" />
                                    <style>{`
                                        @keyframes shimmer {
                                            100% { transform: translateX(100%); }
                                        }
                                    `}</style>
                                    <span className="relative z-10 tracking-wide drop-shadow-sm">{campaign.cta_text}</span>
                                </button>

                                {/* Social Proof & Dismiss */}
                                <div className="flex flex-col items-center gap-3 mt-1">
                                    <div className={`flex items-center gap-1.5 ${isLight ? 'text-black/40' : 'text-white/40'}`}>
                                        <span className="text-[12px] font-medium">3000+ people are already using Natively</span>
                                    </div>
                                    <button
                                        onClick={() => onDismiss(campaign.id)}
                                        className={`text-[12px] font-bold uppercase tracking-[0.15em] mt-1 transition-colors duration-200 ${isLight ? 'text-black/20 hover:text-black/40' : 'text-white/20 hover:text-white/40'}`}
                                    >
                                        Maybe later
                                    </button>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
