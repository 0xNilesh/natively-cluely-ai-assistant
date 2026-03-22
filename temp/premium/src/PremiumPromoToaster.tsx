import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, Sparkles, CheckCircle } from 'lucide-react';
import { cn } from '../../src/lib/utils';
import { useShortcuts } from '../../src/hooks/useShortcuts';
import { useResolvedTheme } from '../../src/hooks/useResolvedTheme';

interface PremiumPromoToasterProps {
    className?: string;
    isOpen: boolean;
    onDismiss: () => void;
    onUpgrade: () => void;
}

export const PremiumPromoToaster: React.FC<PremiumPromoToasterProps> = ({ className, isOpen, onDismiss, onUpgrade }) => {
    const isLight = useResolvedTheme() === 'light';
    const [isButtonHovered, setIsButtonHovered] = useState(false);

        // DEV OVERRIDE: For testing, press Ctrl/Cmd + B
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!import.meta.env.DEV) return;
            if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
                e.preventDefault();
                if (isOpen) onDismiss();
                // We can't easily trigger the hook's dev override from here cleanly without global state,
                // but we'll leave this empty or let the hook handle dev triggers.
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onDismiss]);

    const handleDismiss = () => {
        localStorage.setItem('natively_promo_toaster_dismissed', Date.now().toString());
        onDismiss();
    };

    const handlePrimaryAction = () => {
        localStorage.setItem('natively_promo_toaster_dismissed', Date.now().toString());
        onDismiss();
        onUpgrade();
    };

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
                                : "bg-[#09090B] border border-white/[0.08] shadow-[0_32px_64px_-16px_rgba(0,0,0,0.8),0_8px_32px_-8px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.06)]",
                            "flex flex-col items-center pb-[24px]",
                            className
                        )}
                    >
                        {/* Sophisticated Background Structure */}
                        <div className={`absolute inset-0 ${isLight ? 'bg-[#F8F8FA]' : 'bg-[#0A0A0C]'}`} />
                        <div className={`absolute top-0 left-0 right-0 h-[300px] bg-gradient-to-b pointer-events-none ${isLight ? 'from-black/[0.02] to-transparent' : 'from-white/[0.03] to-transparent'}`} />

                        {/* Refined Border Sparkle (Top Only) */}
                        <div className={`absolute top-0 left-[20%] right-[20%] h-px bg-gradient-to-r from-transparent to-transparent ${isLight ? 'via-black/[0.1]' : 'via-white/[0.15]'}`} />

                        {/* Content Container */}
                        <div className="relative z-10 w-full flex flex-col items-center pt-[48px]">

                            {/* The "Prism" - A custom, human-feeling visual */}
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
                                    <Zap size={24} className={`relative z-10 ${isLight ? 'text-[#1C1C1E] drop-shadow-none' : 'text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]'}`} fill={isLight ? '#1C1C1E' : 'white'} />
                                </motion.div>
                                {/* Subtle Glow beneath the Prism */}
                                <div className={`absolute inset-0 blur-[20px] rounded-full scale-150 ${isLight ? 'bg-black/5' : 'bg-white/5'}`} />
                            </div>

                            {/* Typography - Bold, Impactful, Human */}
                            <div className="text-center px-[40px] mb-[40px]">
                                <h3 className={`text-[32px] font-[700] leading-[1.1] tracking-[-0.04em] mb-[12px] antialiased ${isLight ? 'text-[#1C1C1E]' : 'text-white'}`}>
                                    The Unfair Advantage.
                                </h3>
                                <p className={`text-[15px] leading-[1.6] max-w-[320px] mx-auto font-medium antialiased ${isLight ? 'text-black/50' : 'text-white/50'}`}>
                                    Combined <span className={isLight ? 'text-black/80' : 'text-white/80'}>Resume Context</span> & <span className={isLight ? 'text-black/80' : 'text-white/80'}>JD Intelligence</span>. One lifetime unlock.
                                </p>
                            </div>

                            {/* The "Membership Card" - Pricing Section */}
                            <div className={`w-[380px] rounded-[20px] border p-[24px] mb-[40px] relative overflow-hidden group ${isLight ? 'bg-gradient-to-b from-black/[0.03] to-transparent border-black/[0.08]' : 'bg-gradient-to-b from-white/[0.04] to-transparent border-white/[0.06]'}`}>
                                <div className={`absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity ${isLight ? 'text-black' : 'text-white'}`}>
                                    <Sparkles size={48} />
                                </div>

                                <div className="flex items-center justify-between mb-2">
                                    <span className={`text-[11px] font-bold uppercase tracking-[0.2em] ${isLight ? 'text-black/30' : 'text-white/30'}`}>Early Adopter Offer</span>
                                    <div className={`px-2 py-0.5 rounded-full text-[9px] font-black tracking-tighter ${isLight ? 'bg-[#1C1C1E] text-white' : 'bg-white text-black'}`}>
                                        40% OFF
                                    </div>
                                </div>

                                <div className="flex items-end gap-3 leading-none">
                                    <div className="flex items-baseline gap-1.5">
                                        <span className={`text-[48px] font-[700] leading-none tracking-[-0.02em] ${isLight ? 'text-[#1C1C1E]' : 'text-white'}`}>$9</span>
                                        <span className={`text-[14px] font-bold mb-1.5 ${isLight ? 'text-black/40' : 'text-white/40'}`}>USD</span>
                                    </div>
                                    <div className={`h-[24px] w-px mx-1 mb-2 ${isLight ? 'bg-black/10' : 'bg-white/10'}`} />
                                    <div className="mb-2">
                                        <span className={`text-[13px] font-semibold block leading-tight ${isLight ? 'text-black/60' : 'text-white/60'}`}>Lifetime Access</span>
                                        <span className={`text-[11px] font-medium line-through tracking-wide ${isLight ? 'text-black/25' : 'text-white/20'}`}>Regularly $15.00</span>
                                    </div>
                                </div>
                            </div>

                            {/* Actions */}
                            <div className="w-full px-[48px] flex flex-col gap-5">
                                <button
                                    onClick={handlePrimaryAction}
                                    className={`relative w-full h-[54px] rounded-[18px] font-[700] text-[16px] transition-all hover:scale-[1.02] active:scale-[0.98] overflow-hidden group/btn ${isLight ? 'bg-[#1C1C1E] text-white shadow-[0_20px_40px_-12px_rgba(0,0,0,0.2)]' : 'bg-white text-black shadow-[0_20px_40px_-12px_rgba(255,255,255,0.2)]'}`}
                                >
                                    <div className={`absolute inset-0 bg-gradient-to-r from-transparent to-transparent -translate-x-full group-hover/btn:animate-[shimmer_1.5s_infinite] ${isLight ? 'via-white/20' : 'via-white/40'}`} />
                                    <style>{`
                                        @keyframes shimmer {
                                            100% { transform: translateX(100%); }
                                        }
                                    `}</style>
                                    <span className="relative z-10">Claim the Advantage</span>
                                </button>

                                <button
                                    onClick={handleDismiss}
                                    className={`text-[13px] font-bold uppercase tracking-[0.15em] transition-colors duration-200 ${isLight ? 'text-black/20 hover:text-black/40' : 'text-white/20 hover:text-white/40'}`}
                                >
                                    Maybe later
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
