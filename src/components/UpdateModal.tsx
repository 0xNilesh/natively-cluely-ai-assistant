import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface ReleaseNoteSection {
    title: string;
    items: string[];
}

interface ParsedReleaseNotes {
    version: string;
    summary: string;
    sections: ReleaseNoteSection[];
    fullBody?: string;
    url?: string;
}

interface UpdateModalProps {
    isOpen: boolean;
    updateInfo: any;
    parsedNotes: ParsedReleaseNotes | null;
    onDismiss: () => void;
    onInstall: () => void;
    downloadProgress: number;
    status: 'idle' | 'downloading' | 'ready' | 'error';
    errorMessage?: string | null;
}

const UpdateModal: React.FC<UpdateModalProps> = ({
    isOpen,
    updateInfo,
    parsedNotes,
    onDismiss,
    onInstall,
    downloadProgress,
    status,
    errorMessage
}) => {
    // Helper to format version string
    const formatVersion = (v: string) => {
        if (!v) return 'Unknown';
        if (v === 'latest') return 'Latest';
        if (v === 'vlatest') return 'Latest';
        return v.startsWith('v') ? v : `v${v}`;
    };

    const displayVersion = formatVersion(updateInfo?.version);

    const showFallback = !parsedNotes || (!parsedNotes.summary && (!parsedNotes.sections || parsedNotes.sections.length === 0));

    // State to control which view is shown (Info vs Progress)
    const [showProgress, setShowProgress] = React.useState(false);
    const [copied, setCopied] = React.useState(false);

    // Auto-switch to progress view if status changes to downloading AND it was user-initiated
    const handleUpdateClick = () => {
        onInstall();
        setShowProgress(true);
    };

    const handleCopyCommand = () => {
        navigator.clipboard.writeText('xattr -cr /Applications/Natively.app');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Auto-scroll logic
    const scrollContainerRef = React.useRef<HTMLDivElement>(null);
    const isUserInteractionRef = React.useRef(false);
    const animationFrameRef = React.useRef<number>();

    React.useEffect(() => {
        // Only run if not downloading and we have notes
        if (status === 'downloading' || showFallback || !isOpen) return;

        const scroll = () => {
            if (isUserInteractionRef.current || !scrollContainerRef.current) return;

            const el = scrollContainerRef.current;
            // Smooth scroll speed
            el.scrollTop += 0.5;

            // Check if reached bottom (with small buffer)
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
                el.scrollTop = 0; // Cycle to top
            }

            animationFrameRef.current = requestAnimationFrame(scroll);
        };

        // Start scrolling after a small delay to let render finish
        const timeoutId = setTimeout(() => {
            animationFrameRef.current = requestAnimationFrame(scroll);
        }, 1000);

        return () => {
            clearTimeout(timeoutId);
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        };
    }, [status, showFallback, isOpen]);

    const handleUserScrollInteraction = () => {
        isUserInteractionRef.current = true;
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[9999] flex items-center justify-center font-sans antialiased">
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                        onClick={onDismiss}
                    />

                    {/* Modal - Apple Style: Premium, Deep Shadow, Subtle Border */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.96, y: 8 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: 8 }}
                        transition={{
                            type: "spring",
                            stiffness: 350,
                            damping: 30
                        }}
                        className="relative w-[510px] h-[380px] bg-[#1E1E1E]/90 backdrop-blur-2xl rounded-xl shadow-[0_50px_100px_-20px_rgba(0,0,0,0.5)] border border-white/[0.08] overflow-hidden flex flex-col"
                    >
                        {/* Content Container */}
                        {status === 'downloading' ? (
                            <div className="p-8 flex flex-col items-center justify-center h-full text-center relative">

                                {/* 1. Header Text */}
                                <div className="space-y-1.5 mb-8">
                                    <h2 className="text-[17px] font-semibold text-white tracking-tight">
                                        Downloading Update...
                                    </h2>
                                    <p className="text-[13px] text-white/40 font-medium">
                                        {downloadProgress < 100 ? 'Please wait while we prepare the update.' : 'Finalizing package...'}
                                    </p>
                                </div>

                                {/* 2. Premium Troubleshooting Card */}
                                <div
                                    tabIndex={-1}
                                    className="w-full max-w-[360px] bg-white/[0.03] rounded-xl border border-white/[0.06] p-3.5 flex flex-col gap-2.5 text-left mb-8 outline-none focus:outline-none focus:ring-0"
                                >
                                    <div className="flex items-start gap-2.5">
                                        <div className="w-5 h-5 rounded-full bg-amber-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                                            <span className="text-[10px] text-amber-500">!</span>
                                        </div>
                                        <div className="space-y-0.5">
                                            <p className="text-[12px] font-medium text-white/80 leading-tight">
                                                If macOS says "App is damaged"
                                            </p>
                                            <p className="text-[11px] text-white/40 leading-snug">
                                                Move app to Applications folder, then run:
                                            </p>
                                        </div>
                                    </div>

                                    {/* Code Block with Copy */}
                                    <div className="flex items-center justify-between bg-black/20 rounded-lg pl-3 pr-1.5 py-1.5 border border-white/[0.03] group hover:border-white/10 transition-colors">
                                        <code className="text-[10px] font-mono text-blue-400 truncate mr-2 select-all">
                                            xattr -cr /Applications/Natively.app
                                        </code>
                                        <button
                                            onClick={handleCopyCommand}
                                            className="h-6 px-2.5 rounded-md bg-white/5 hover:bg-white/10 active:bg-white/15 flex items-center justify-center transition-colors border border-white/5"
                                            title="Copy to clipboard"
                                        >
                                            {copied ? (
                                                <span className="text-[10px] font-semibold text-green-400">Copied</span>
                                            ) : (
                                                <span className="text-[10px] font-medium text-white/50 group-hover:text-white/80">Copy</span>
                                            )}
                                        </button>
                                    </div>
                                </div>

                                {/* 3. Progress Bar */}
                                <div className="w-full max-w-[260px] space-y-2.5 mb-2">
                                    <div className="h-[5px] w-full bg-white/10 rounded-full overflow-hidden">
                                        <motion.div
                                            initial={{ width: 0 }}
                                            animate={{ width: `${downloadProgress}%` }}
                                            transition={{ ease: "linear", duration: 0.2 }}
                                            className="h-full bg-[#007AFF] rounded-full shadow-[0_0_10px_rgba(0,122,255,0.5)]"
                                        />
                                    </div>
                                    <p className="text-[11px] font-medium text-white/30 tabular-nums">
                                        {Math.round(downloadProgress)}% Complete
                                    </p>
                                </div>

                                <button
                                    onClick={onDismiss}
                                    className="text-[13px] font-medium text-white/30 hover:text-white/60 transition-colors mt-auto mb-1"
                                >
                                    Hide
                                </button>
                            </div>
                        ) : status === 'error' ? (
                            <div className="p-8 flex flex-col items-center justify-center h-full text-center relative">
                                <div className="space-y-1.5 mb-6">
                                    <h2 className="text-[17px] font-semibold text-white tracking-tight">
                                        Update Failed
                                    </h2>
                                    <p className="text-[13px] text-red-400 font-medium">
                                        {errorMessage || 'An error occurred while downloading the update.'}
                                    </p>
                                </div>
                                <div className="bg-white/[0.03] rounded-xl border border-white/[0.06] p-4 max-w-[360px]">
                                    <p className="text-[12px] text-white/60 leading-relaxed">
                                        Please check your internet connection and try again. 
                                        You can also download the latest version manually from GitHub.
                                    </p>
                                </div>
                                <button
                                    onClick={onDismiss}
                                    className="px-5 py-[6px] bg-white/10 hover:bg-white/15 text-white text-[13px] font-medium rounded-lg mt-6 transition-colors"
                                >
                                    Close
                                </button>
                            </div>
                        ) : (
                            <div className="p-7 pb-4 flex flex-col gap-2 h-full min-h-0">
                                {/* Header Group */}
                                <div className="flex flex-col gap-0.5 text-center relative flex-shrink-0 pt-1">
                                    <h2 className="text-[19px] font-semibold text-white tracking-tight">
                                        Update Available
                                    </h2>
                                    <p className="text-[13px] text-white/50 font-medium tracking-wide">
                                        Version {displayVersion} is ready to install.
                                    </p>
                                </div>

                                {/* Minimal List - Scrollable area */}
                                <div
                                    ref={scrollContainerRef}
                                    onWheel={handleUserScrollInteraction}
                                    onTouchMove={handleUserScrollInteraction}
                                    onMouseDown={handleUserScrollInteraction}
                                    className="py-2 flex-1 overflow-y-auto custom-scrollbar min-h-[120px] pr-2 -mr-2"
                                >
                                    {showFallback ? (
                                        <p className="text-[13px] text-white/60 text-center leading-relaxed mt-8">
                                            Includes performance improvements and bug fixes.
                                        </p>
                                    ) : (
                                        <div className="space-y-5 px-1">
                                            {parsedNotes?.sections?.map((section, idx) => {
                                                if (section.items.length === 0) return null;
                                                if (section.title === 'Summary') return null;

                                                return (
                                                    <div key={idx} className="space-y-2.5">
                                                        {/* Section Header: Refined, Medium Weight */}
                                                        <h3 className="text-[13px] font-medium text-white/90 pl-1">
                                                            {section.title}
                                                        </h3>
                                                        <ul className="space-y-2">
                                                            {section.items.map((item, i) => (
                                                                <li key={i} className="text-[13px] text-white/70 leading-[1.5] flex items-start gap-3 pl-1">
                                                                    <span className="text-white/30 mt-[6px] text-[10px] transform scale-75 flex-shrink-0">
                                                                        —
                                                                    </span>
                                                                    <span>{item}</span>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                {/* Footer Actions */}
                                <div className="flex items-center justify-between flex-shrink-0">
                                    {/* Secondary Action - Left Aligned, Plain Text */}
                                    <button
                                        onClick={onDismiss}
                                        className="text-[13px] font-medium text-white/40 hover:text-white/70 transition-colors"
                                    >
                                        Not Now
                                    </button>

                                    {/* Primary Action - Right Aligned, System Blue */}
                                    {status === 'ready' ? (
                                        <button
                                            onClick={() => window.electronAPI.restartAndInstall()}
                                            className="px-5 py-[6px] bg-[#007AFF] hover:bg-[#0062CC] text-white text-[13px] font-medium rounded-lg shadow-sm transition-colors"
                                        >
                                            Restart & Install
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleUpdateClick}
                                            className="px-5 py-[6px] bg-[#007AFF] hover:bg-[#0062CC] text-white text-[13px] font-medium rounded-lg shadow-sm transition-colors"
                                        >
                                            Update Now
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};

export default UpdateModal;
