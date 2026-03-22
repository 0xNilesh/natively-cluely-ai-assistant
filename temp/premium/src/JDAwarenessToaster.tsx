import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Briefcase, Sparkles } from 'lucide-react';
import { cn } from '../../src/lib/utils';
import { useResolvedTheme } from '../../src/hooks/useResolvedTheme';

interface JDAwarenessToasterProps {
    className?: string;
    isOpen: boolean;
    onDismiss: () => void;
    onSetupJD: () => void;
}

export const JDAwarenessToaster: React.FC<JDAwarenessToasterProps> = ({ className, isOpen, onDismiss, onSetupJD }) => {
    const isLight = useResolvedTheme() === 'light';
    const [isButtonHovered, setIsButtonHovered] = useState(false);

    useEffect(() => {
        // DEV OVERRIDE: For testing, press Ctrl/Cmd + T
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!import.meta.env.DEV) return;
            if ((e.metaKey || e.ctrlKey) && e.key === 't') {
                e.preventDefault();
                if (isOpen) onDismiss();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onDismiss]);

    const handleDismiss = () => {
        localStorage.setItem('natively_jd_toaster_dismissed', Date.now().toString());
        onDismiss();
    };

    const handlePrimaryAction = () => {
        localStorage.setItem('natively_jd_toaster_dismissed', Date.now().toString());
        onDismiss();
        onSetupJD();
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <div className={`fixed inset-0 z-[9998] flex items-center justify-center ${isLight ? 'bg-black/30 backdrop-blur-[2px]' : 'bg-black/60 backdrop-blur-[2px]'}`}>
                    <motion.div
                        initial={{ opacity: 0, scale: 0.98, y: 4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: 4 }}
                        transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                        className={cn(
                            "relative w-[520px] overflow-hidden",
                            "rounded-[28px]",
                            isLight
                                ? "bg-white border border-black/[0.08] shadow-[0_32px_64px_-16px_rgba(0,0,0,0.15),0_8px_24px_-8px_rgba(0,0,0,0.1)]"
                                : "bg-gradient-to-b from-[#16171A] to-[#111214] border border-white/[0.08] shadow-[0_32px_64px_-16px_rgba(0,0,0,0.6),0_8px_24px_-8px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.08)]",
                            "flex flex-col items-center pb-[32px]",
                            className
                        )}
                    >
                        {/* Header Section */}
                        <div className="pt-[36px] flex flex-col items-center w-full px-[40px]">
                            {/* Icon Container */}
                            <div className={`relative mb-[20px] flex items-center justify-center w-[48px] h-[48px] rounded-full shadow-inner ${isLight ? 'bg-[#A07CFE]/10 border border-[#A07CFE]/20' : 'bg-white/5 border border-white/10'}`}>
                                <div className="absolute inset-0 bg-[#A07CFE] blur-[24px] opacity-20 rounded-full" />
                                <Briefcase size={24} className="text-[#A07CFE] relative z-10" strokeWidth={1.5} />
                            </div>

                            {/* Typography Stack */}
                            <div className="flex flex-col items-center text-center">
                                <h3 className={`text-[24px] font-[600] leading-[1.2] tracking-[-0.01em] mb-[10px] antialiased ${isLight ? 'text-[#1C1C1E]' : 'text-[#F3F3F3]'}`}>
                                    Nail the "Why this role?" questions.
                                </h3>
                                <p className={`text-[14px] leading-[1.6] max-w-[420px] font-medium antialiased ${isLight ? 'text-black/50' : 'text-white/60'}`}>
                                    Upload the Job Description. <strong>JD Awareness</strong> ensures AI aligns your answers perfectly with the exact skills and keywords the interviewer is looking for.
                                </p>
                            </div>
                        </div>

                        {/* Visual Comparison Demo */}
                        <div className="w-full px-[32px] mt-6 mb-8 flex flex-col gap-3">
                            <div className="text-center mb-1">
                                <span className={`text-[11px] font-medium tracking-wider uppercase ${isLight ? 'text-black/40' : 'text-white/40'}`}>
                                    Interviewer: <span className="text-accent-primary/90">"Why do you think you're a good fit for this position?"</span>
                                </span>
                            </div>

                            {/* JD OFF Demo */}
                            <div className={`border rounded-[16px] rounded-tl-sm p-4 w-[90%] self-start relative shadow-sm opacity-60 hover:opacity-100 transition-opacity ${isLight ? 'bg-black/[0.03] border-black/[0.06]' : 'bg-white/5 border-white/5'}`}>
                                <span className={`absolute -top-[10px] left-4 border text-[9px] uppercase font-bold px-2 py-0.5 rounded-full tracking-wider ${isLight ? 'bg-[#F0F0F2] border-black/10 text-black/50' : 'bg-[#2A2B2E] border-white/10 text-white/50'}`}>Without JD Awareness</span>
                                <p className={`text-[13px] leading-relaxed mt-1 ${isLight ? 'text-black/50' : 'text-white/60'}`}>"I have a strong background in software engineering and I'm a quick learner. I enjoy solving complex problems and working in a fast-paced team environment."</p>
                            </div>

                            {/* JD ON Demo */}
                            <div className="bg-[#A07CFE]/10 border border-[#A07CFE]/30 rounded-[16px] rounded-tr-sm p-4 w-[90%] self-end relative shadow-[0_4px_24px_rgba(160,124,254,0.15)]">
                                <span className="absolute -top-[10px] right-4 bg-[#A07CFE] text-white text-[9px] uppercase font-bold px-2 py-0.5 rounded-full tracking-wider shadow-[0_2px_8px_rgba(160,124,254,0.4)] flex items-center gap-1">
                                    With JD Awareness
                                </span>
                                <p className="text-[13px] text-[#A07CFE]/90 font-medium leading-[1.5] mt-1">"I noticed the core focus for this Senior role is scaling the Python microservices. Having spent the last two years optimizing high-throughput distributed architectures, I'm confident I can drive those backend improvements."</p>
                            </div>
                        </div>

                        {/* Actions Footer */}
                        <div className="mt-auto w-full flex flex-col items-center">
                            {/* Primary Button */}
                            <button
                                onClick={handlePrimaryAction}
                                onMouseEnter={() => setIsButtonHovered(true)}
                                onMouseLeave={() => setIsButtonHovered(false)}
                                className="group relative w-[320px] h-[48px] rounded-[16px] overflow-hidden transition-all duration-300 hover:scale-[1.01] active:scale-[0.99] shadow-[0_4px_16px_rgba(160,124,254,0.15)] hover:shadow-[0_8px_24px_rgba(160,124,254,0.25)] mb-[16px] border border-white/5"
                            >
                                <div className="absolute inset-0 bg-gradient-to-b from-[#A07CFE] to-[#8C62F8] opacity-100 transition-all" />
                                <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                                <span className="relative z-10 text-[15px] font-[600] text-white/95 group-hover:text-white flex items-center justify-center gap-2 tracking-wide">
                                    Upload Job Description
                                </span>
                            </button>

                            {/* Secondary Button */}
                            <button
                                onClick={handleDismiss}
                                className={`text-[13px] font-medium transition-colors duration-200 ${isLight ? 'text-black/30 hover:text-black/60' : 'text-white/30 hover:text-white/60'}`}
                            >
                                Not now
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
