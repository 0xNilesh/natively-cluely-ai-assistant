const fs = require('fs');
let content = fs.readFileSync('src/components/ProfileIntelligenceSettings.tsx', 'utf8');

// Chunk 1: Imports
content = content.replace(
    "import { useResolvedTheme } from '../hooks/useResolvedTheme';",
    "import { useResolvedTheme } from '../hooks/useResolvedTheme';\nimport { motion, AnimatePresence } from 'framer-motion';\n\nconst spring = { type: \"spring\", stiffness: 100, damping: 20 };\n\nconst BezelCard = ({ children, className = \"\", delay = 0, style = {} }: any) => {\n    const isLight = useResolvedTheme() === 'light';\n    return (\n        <motion.div \n            layout\n            initial={{ opacity: 0, y: 30, filter: 'blur(10px)' }}\n            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}\n            transition={{ ...spring, delay }}\n            style={style}\n            className={`p-[3px] md:p-1.5 rounded-[2.5rem] ${isLight ? 'bg-black/[0.03] ring-black/[0.05]' : 'bg-white/[0.03] ring-white/[0.05]'} ring-1 ${className}`}\n        >\n            <div className={`rounded-[calc(2.5rem-0.375rem)] bg-bg-item-surface h-full w-full ${isLight ? 'shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05)]' : 'shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]'} overflow-hidden relative`}>\n                {children}\n            </div>\n        </motion.div>\n    );\n};\n\nconst MagneticButton = ({ children, onClick, disabled, className = \"\", primary = false, style }: any) => {\n    return (\n        <motion.button\n            whileHover={!disabled ? { scale: 1.02, y: -1 } : {}}\n            whileTap={!disabled ? { scale: 0.98 } : {}}\n            transition={spring}\n            onClick={onClick}\n            disabled={disabled}\n            style={style}\n            className={`relative group px-6 py-3 text-[13px] tracking-tight font-bold rounded-full flex items-center justify-center gap-2 overflow-hidden ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className} ${primary ? 'bg-text-primary text-bg-main shadow-[0_10px_20px_-10px_rgba(0,0,0,0.2)]' : 'bg-bg-input text-text-primary hover:bg-bg-surface border border-border-subtle'}`}\n        >\n            {children}\n            {primary && (\n                <div className=\"absolute inset-0 rounded-full ring-1 ring-inset ring-white/20 pointer-events-none\" />\n            )}\n        </motion.button>\n    );\n};"
);

// Chunk 2: Header and Container
const oldHeader = `<div className="flex flex-col h-full bg-bg-main relative">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-border-subtle bg-bg-surface/50 shrink-0 backdrop-blur-md">
                <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-bg-input border border-border-subtle shadow-inner flex items-center justify-center text-text-primary">
                        <User size={20} strokeWidth={2.5} />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-[17px] font-bold text-text-primary tracking-tight">Profile Intelligence</h2>
                            <span className="bg-yellow-500/10 text-yellow-500 text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">BETA</span>
                            {isPremium && premiumPlan && (
                                <span className="bg-[#FACC15]/10 text-[#FACC15] border border-[#FACC15]/20 text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">
                                    {premiumPlan.toUpperCase()} PLAN
                                </span>
                            )}
                            {isTrialActive && !isPremium && (
                                <span className="bg-violet-500/10 text-violet-400 border border-violet-500/20 text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">
                                    FREE TRIAL
                                </span>
                            )}
                        </div>
                        <p className="text-[12px] text-text-secondary mt-0.5">Manage your persona, career history, and active job description</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setIsPremiumModalOpen(true)}
                        className={\`text-[11px] font-semibold flex items-center gap-1.5 transition-all duration-200 px-2.5 py-1 rounded-full border shadow-[0_0_10px_rgba(250,204,21,0.2)] hover:shadow-[0_0_15px_rgba(250,204,21,0.3)] \${isPremium
                            ? (isLight ? 'bg-bg-component text-text-primary border-border-subtle hover:bg-bg-item-surface' : 'bg-zinc-800 text-white border-white/10 hover:bg-zinc-700')
                            : isTrialActive
                            ? 'bg-violet-500/15 text-violet-300 border-violet-500/30 hover:bg-violet-500/25 active:scale-[0.98]'
                            : 'bg-[#FACC15] text-black border-transparent hover:bg-[#FDE047] active:scale-[0.98]'
                            }\`}
                    >
                        {isPremium ? <CheckCircle size={12} className="text-green-400" /> : isTrialActive ? <Sparkles size={12} className="text-violet-400" /> : <Sparkles size={12} className="text-black/80" />}
                        {isPremium ? 'Manage Pro' : isTrialActive ? 'Upgrade' : 'Unlock Pro'}
                    </button>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-input transition-colors border border-transparent hover:border-border-subtle"
                    >
                        <X size={18} />
                    </button>
                </div>
            </div>`;

const newHeader = `<div className="flex flex-col h-full bg-bg-main relative" style={{ fontFamily: '"Geist", "Satoshi", "Cabinet Grotesk", system-ui, sans-serif' }}>
            <motion.div 
                initial={{ y: -50, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ ...spring, delay: 0.1 }}
                className="flex items-center justify-between p-6 border-b border-white/5 bg-bg-surface/70 shrink-0 backdrop-blur-3xl sticky top-0 z-50"
            >
                <div className="flex items-center gap-5">
                    <div className="w-12 h-12 rounded-[1.25rem] bg-bg-input border border-border-subtle shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)] flex items-center justify-center text-text-primary">
                        <User size={22} strokeWidth={2} />
                    </div>
                    <div>
                        <div className="flex items-center gap-3 mb-1">
                            <h2 className="text-xl font-bold text-text-primary tracking-tighter leading-none">Profile Intelligence</h2>
                            <span className="bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 text-[9px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-widest shadow-sm">
                                BETA
                            </span>
                            {isPremium && premiumPlan && (
                                <span className="bg-[#FACC15]/10 text-[#FACC15] border border-[#FACC15]/20 text-[9px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-widest">
                                    {premiumPlan.toUpperCase()} PLAN
                                </span>
                            )}
                            {isTrialActive && !isPremium && (
                                <span className="bg-violet-500/10 text-violet-400 border border-violet-500/20 text-[9px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-widest">
                                    FREE TRIAL
                                </span>
                            )}
                        </div>
                        <p className="text-[13px] text-text-secondary tracking-tight">Manage your persona, career history, and active job description</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setIsPremiumModalOpen(true)}
                        className={\`text-[13px] font-bold tracking-tight flex items-center gap-2 transition-all duration-300 px-5 py-2.5 rounded-full border shadow-[0_0_15px_rgba(250,204,21,0.1)] hover:shadow-[0_0_20px_rgba(250,204,21,0.2)] \${isPremium
                            ? (isLight ? 'bg-bg-component text-text-primary border-border-subtle hover:bg-bg-item-surface' : 'bg-zinc-800 text-white border-white/10 hover:bg-zinc-700')
                            : isTrialActive
                            ? 'bg-violet-500/15 text-violet-300 border-violet-500/30 hover:bg-violet-500/25'
                            : 'bg-[#FACC15] text-black border-transparent hover:bg-[#FDE047]'
                            }\`}
                    >
                        {isPremium ? <CheckCircle size={14} className="text-green-500" /> : isTrialActive ? <Sparkles size={14} className="text-violet-500" /> : <Sparkles size={14} className="text-black/80" />}
                        {isPremium ? 'Manage Pro' : isTrialActive ? 'Upgrade' : 'Unlock Pro'}
                    </motion.button>
                    <motion.button
                        whileHover={{ scale: 1.05, rotate: 90 }}
                        whileTap={{ scale: 0.95 }}
                        transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                        onClick={onClose}
                        className="w-10 h-10 flex items-center justify-center rounded-full text-text-tertiary hover:text-text-primary hover:bg-bg-input transition-colors border border-transparent hover:border-border-subtle"
                    >
                        <X size={20} strokeWidth={2} />
                    </motion.button>
                </div>
            </motion.div>`;
content = content.replace(oldHeader, newHeader);

// Chunk 3: Layout Structure
const oldStruct = `<div className="max-w-3xl mx-auto p-5 pb-12">
                                <div className="space-y-6 animated fadeIn">
                                    {/* Introduction */}
                                    <div className="mb-5">
                                        <div className="flex items-center justify-between mb-1">
                                            <div className="flex items-center gap-2">
                                                <h3 className="text-sm font-bold text-text-primary">Professional Identity</h3>
                                            </div>
                                        </div>
                                        <p className="text-xs text-text-secondary mb-2">
                                            This engine constructs an intelligent representation of your career history.
                                        </p>
                                    </div>

                                    {/* Intelligence Graph Hero Card */}
                                    <div className="bg-bg-item-surface rounded-xl border border-border-subtle flex flex-col justify-between overflow-hidden">
                                        <div className="flex flex-col justify-between min-h-[160px]">`;

const newStruct = `<div className="max-w-[1400px] mx-auto p-8 pb-32">
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-10 items-start">
                        <div className="md:col-span-5 space-y-10">
                                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, ...spring }} className="mb-8">
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="px-3 py-1 rounded-full bg-black/5 dark:bg-white/10 text-[10px] font-bold tracking-[0.2em] uppercase text-text-secondary">
                                                Node 01
                                            </div>
                                            <h3 className="text-3xl font-bold text-text-primary tracking-tighter">Professional Identity</h3>
                                        </div>
                                        <p className="text-[15px] text-text-secondary leading-relaxed">
                                            This engine constructs an intelligent representation of your career history and skills graph.
                                        </p>
                                    </motion.div>

                                    <BezelCard delay={0.2}>
                                        <div className="flex flex-col justify-between min-h-[200px]">`;
content = content.replace(oldStruct, newStruct);

// Chunk 4: Profile Upload Wrapper
const oldProfileWrapper = `                                        </div>
                                    </div>

                                    {/* Upload Area */}
                                    <div className="mt-5">
                                        <div className={\`bg-bg-item-surface rounded-xl border transition-all \${profileUploading ? 'border-accent-primary/50 ring-1 ring-accent-primary/20' : 'border-border-subtle'}\`}>`;
const newProfileWrapper = `                                        </div>
                                    </BezelCard>

                                    <BezelCard delay={0.3} className={profileUploading ? 'ring-accent-primary/50' : ''}>
                                        <div className="transition-all">`;
content = content.replace(oldProfileWrapper, newProfileWrapper);

// Chunk 5: Profile Button
const oldProfileBtn = `<button
                                                    onClick={async () => {
                                                        setProfileError('');
                                                        try {
                                                            const fileResult = await window.electronAPI?.profileSelectFile?.();
                                                            if (fileResult?.cancelled || !fileResult?.filePath) return;

                                                            setProfileUploading(true);
                                                            const result = await window.electronAPI?.profileUploadResume?.(fileResult.filePath);
                                                            if (result?.success) {
                                                                const status = await window.electronAPI?.profileGetStatus?.();
                                                                if (status) setProfileStatus(status);
                                                                const data = await window.electronAPI?.profileGetProfile?.();
                                                                if (data) setProfileData(data);
                                                            } else {
                                                                setProfileError(result?.error || 'Upload failed');
                                                            }
                                                        } catch (e: any) {
                                                            setProfileError(e.message || 'Upload failed');
                                                        } finally {
                                                            setProfileUploading(false);
                                                        }
                                                    }}
                                                    disabled={profileUploading}
                                                    className={\`px-4 py-2 rounded-full text-xs font-medium transition-all whitespace-nowrap shrink-0 \${profileUploading ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-text-primary text-bg-main hover:opacity-90 shadow-sm'}\`}
                                                >
                                                    {profileUploading ? 'Ingesting...' : 'Select File'}
                                                </button>`;
const newProfileBtn = `<MagneticButton
                                                    onClick={async () => {
                                                        setProfileError('');
                                                        try {
                                                            const fileResult = await window.electronAPI?.profileSelectFile?.();
                                                            if (fileResult?.cancelled || !fileResult?.filePath) return;

                                                            setProfileUploading(true);
                                                            const result = await window.electronAPI?.profileUploadResume?.(fileResult.filePath);
                                                            if (result?.success) {
                                                                const status = await window.electronAPI?.profileGetStatus?.();
                                                                if (status) setProfileStatus(status);
                                                                const data = await window.electronAPI?.profileGetProfile?.();
                                                                if (data) setProfileData(data);
                                                            } else {
                                                                setProfileError(result?.error || 'Upload failed');
                                                            }
                                                        } catch (e: any) {
                                                            setProfileError(e.message || 'Upload failed');
                                                        } finally {
                                                            setProfileUploading(false);
                                                        }
                                                    }}
                                                    disabled={profileUploading}
                                                    primary={!profileStatus.hasProfile}
                                                >
                                                    {profileUploading ? 'Ingesting...' : 'Select File'}
                                                    {!profileUploading && (
                                                        <div className="w-6 h-6 rounded-full bg-black/10 dark:bg-white/10 flex items-center justify-center ml-1">
                                                            <Upload size={12} />
                                                        </div>
                                                    )}
                                                </MagneticButton>`;
content = content.replace(oldProfileBtn, newProfileBtn);

// Chunk 6: JD Upload Wrapper
const oldJdWrapper = `                                        </div>
                                    </div>

                                    {/* JD Upload Card */}
                                    <div className="mt-5">
                                        <div className={\`rounded-xl transition-all border \${jdUploading ? 'border-blue-500/50 ring-1 ring-blue-500/20 bg-bg-item-surface' : profileData?.hasActiveJD ? 'border-blue-500/30 bg-blue-500/5' : 'border-border-subtle bg-bg-item-surface'}\`}>`;
const newJdWrapper = `                                        </div>
                                    </BezelCard>

                                    <BezelCard delay={0.4} className={jdUploading ? 'ring-blue-500/50' : profileData?.hasActiveJD ? 'ring-blue-500/30' : ''}>
                                        <div className="transition-all">`;
content = content.replace(oldJdWrapper, newJdWrapper);

// Chunk 7: JD Button
const oldJdBtn = `<button
                                                        onClick={async () => {
                                                            setJdError('');
                                                            try {
                                                                const fileResult = await window.electronAPI?.profileSelectFile?.();
                                                                if (fileResult?.cancelled || !fileResult?.filePath) return;

                                                                setJdUploading(true);
                                                                const result = await window.electronAPI?.profileUploadJD?.(fileResult.filePath);
                                                                if (result?.success) {
                                                                    const data = await window.electronAPI?.profileGetProfile?.();
                                                                    if (data) setProfileData(data);
                                                                } else {
                                                                    setJdError(result?.error || 'JD upload failed');
                                                                }
                                                            } catch (e: any) {
                                                                setJdError(e.message || 'JD upload failed');
                                                            } finally {
                                                                setJdUploading(false);
                                                            }
                                                        }}
                                                        disabled={jdUploading}
                                                        className={\`px-4 py-2 rounded-full text-xs font-medium transition-all whitespace-nowrap shrink-0 \${jdUploading ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-blue-600 text-white hover:bg-blue-500 shadow-sm'}\`}
                                                    >
                                                        {jdUploading ? 'Parsing...' : profileData?.hasActiveJD ? 'Replace JD' : 'Upload JD'}
                                                    </button>`;
const newJdBtn = `<MagneticButton
                                                        onClick={async () => {
                                                            setJdError('');
                                                            try {
                                                                const fileResult = await window.electronAPI?.profileSelectFile?.();
                                                                if (fileResult?.cancelled || !fileResult?.filePath) return;

                                                                setJdUploading(true);
                                                                const result = await window.electronAPI?.profileUploadJD?.(fileResult.filePath);
                                                                if (result?.success) {
                                                                    const data = await window.electronAPI?.profileGetProfile?.();
                                                                    if (data) setProfileData(data);
                                                                } else {
                                                                    setJdError(result?.error || 'JD upload failed');
                                                                }
                                                            } catch (e: any) {
                                                                setJdError(e.message || 'JD upload failed');
                                                            } finally {
                                                                setJdUploading(false);
                                                            }
                                                        }}
                                                        disabled={jdUploading}
                                                        primary={true}
                                                    >
                                                        {jdUploading ? 'Parsing...' : profileData?.hasActiveJD ? 'Replace JD' : 'Upload JD'}
                                                        {!jdUploading && (
                                                            <div className="w-6 h-6 rounded-full bg-black/10 dark:bg-white/10 flex items-center justify-center ml-1">
                                                                <Briefcase size={12} />
                                                            </div>
                                                        )}
                                                    </MagneticButton>`;
content = content.replace(oldJdBtn, newJdBtn);

// Chunk 8: Transition to Right Column (Custom Context)
const oldRightCol = `                                        </div>
                                    </div>

                                    {/* Custom Context Card */}
                                    <div className="mt-5">
                                        <div className="bg-bg-item-surface rounded-xl border border-border-subtle">`;
const newRightCol = `                                        </div>
                                    </BezelCard>
                        </div>
                        
                        <div className="md:col-span-7 space-y-10">
                                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, ...spring }} className="mb-8">
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="px-3 py-1 rounded-full bg-black/5 dark:bg-white/10 text-[10px] font-bold tracking-[0.2em] uppercase text-text-secondary">
                                                Node 02
                                            </div>
                                            <h3 className="text-3xl font-bold text-text-primary tracking-tighter">Research & Context</h3>
                                        </div>
                                        <p className="text-[15px] text-text-secondary leading-relaxed">
                                            Manage your target company intelligence and negotiation strategy.
                                        </p>
                                    </motion.div>

                                    <BezelCard delay={0.3}>`;
content = content.replace(oldRightCol, newRightCol);

// Chunk 9: Google Search Card
const oldSearchCard = `                                            </div>
                                        </div>
                                    </div>

                                    {/* Google Search API Card */}
                                    <div className="mt-5">
                                        <div className="bg-bg-item-surface rounded-xl border border-border-subtle">`;
const newSearchCard = `                                            </div>
                                        </BezelCard>

                                    <BezelCard delay={0.4}>`;
content = content.replace(oldSearchCard, newSearchCard);

// Chunk 10: Tavily Button
const oldTavilyBtn = `<button
                                                        onClick={async () => {
                                                            if (!tavilyApiKey.trim()) return;
                                                            setTavilyError('');
                                                            setTavilySaving(true);
                                                            try {
                                                                const result = await window.electronAPI?.setTavilyApiKey?.(tavilyApiKey.trim());
                                                                if (result && !result.success) {
                                                                    setTavilyError(result.error ?? 'Failed to save API key.');
                                                                } else {
                                                                    setHasStoredTavilyKey(true);
                                                                    setTavilyApiKey('');
                                                                }
                                                            } catch (e: any) {
                                                                setTavilyError(e?.message ?? 'Unexpected error saving API key.');
                                                            } finally {
                                                                setTavilySaving(false);
                                                            }
                                                        }}
                                                        disabled={tavilySaving || !tavilyApiKey.trim()}
                                                        className={\`w-full px-4 py-2 rounded-lg text-xs font-medium transition-all \${tavilySaving ? 'bg-bg-input text-text-tertiary cursor-wait' : !tavilyApiKey.trim() ? 'bg-bg-input text-text-tertiary cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm'}\`}
                                                    >
                                                        {tavilySaving ? 'Saving...' : 'Save API Key'}
                                                    </button>`;
const newTavilyBtn = `<MagneticButton
                                                        onClick={async () => {
                                                            if (!tavilyApiKey.trim()) return;
                                                            setTavilyError('');
                                                            setTavilySaving(true);
                                                            try {
                                                                const result = await window.electronAPI?.setTavilyApiKey?.(tavilyApiKey.trim());
                                                                if (result && !result.success) {
                                                                    setTavilyError(result.error ?? 'Failed to save API key.');
                                                                } else {
                                                                    setHasStoredTavilyKey(true);
                                                                    setTavilyApiKey('');
                                                                }
                                                            } catch (e: any) {
                                                                setTavilyError(e?.message ?? 'Unexpected error saving API key.');
                                                            } finally {
                                                                setTavilySaving(false);
                                                            }
                                                        }}
                                                        disabled={tavilySaving || !tavilyApiKey.trim()}
                                                        primary={true}
                                                        className="w-full"
                                                    >
                                                        {tavilySaving ? 'Saving...' : 'Save API Key'}
                                                    </MagneticButton>`;
content = content.replace(oldTavilyBtn, newTavilyBtn);

// Chunk 11: Company Research Start
const oldCompCard = `                                            </div>
                                        </div>
                                    </div>

                                    {/* Company Research Section */}
                                    {profileData?.hasActiveJD && profileData?.activeJD?.company && (
                                        <div className="mt-5">
                                            <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5">`;
const newCompCard = `                                            </div>
                                        </BezelCard>

                                    {profileData?.hasActiveJD && profileData?.activeJD?.company && (
                                        <BezelCard delay={0.5}>
                                            <div className="p-5">`;
content = content.replace(oldCompCard, newCompCard);

// Chunk 12: Company Research Button
const oldCompBtn = `<button
                                                        onClick={async () => {
                                                            setCompanyResearching(true);
                                                            setCompanySearchQuotaExhausted(false);
                                                            try {
                                                                const result = await window.electronAPI?.profileResearchCompany?.(profileData.activeJD.company);
                                                                if (result?.success && result.dossier) {
                                                                    setCompanyDossier(result.dossier);
                                                                }
                                                                if (result?.searchQuotaExhausted) {
                                                                    setCompanySearchQuotaExhausted(true);
                                                                }
                                                            } catch (e) {
                                                                console.error('Research failed:', e);
                                                            } finally {
                                                                setCompanyResearching(false);
                                                            }
                                                        }}
                                                        disabled={companyResearching}
                                                        className={\`px-4 py-2 rounded-full text-xs font-medium transition-all flex items-center gap-2 \${companyResearching ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-purple-600/10 text-purple-500 hover:bg-purple-600/20 border border-purple-500/20'}\`}
                                                    >
                                                        {companyResearching ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
                                                        {companyResearching ? 'Researching...' : companyDossier ? 'Refresh' : 'Research Now'}
                                                    </button>`;
const newCompBtn = `<MagneticButton
                                                        onClick={async () => {
                                                            setCompanyResearching(true);
                                                            setCompanySearchQuotaExhausted(false);
                                                            try {
                                                                const result = await window.electronAPI?.profileResearchCompany?.(profileData.activeJD.company);
                                                                if (result?.success && result.dossier) {
                                                                    setCompanyDossier(result.dossier);
                                                                }
                                                                if (result?.searchQuotaExhausted) {
                                                                    setCompanySearchQuotaExhausted(true);
                                                                }
                                                            } catch (e) {
                                                                console.error('Research failed:', e);
                                                            } finally {
                                                                setCompanyResearching(false);
                                                            }
                                                        }}
                                                        disabled={companyResearching}
                                                    >
                                                        {companyResearching ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
                                                        {companyResearching ? 'Researching...' : companyDossier ? 'Refresh' : 'Research Now'}
                                                    </MagneticButton>`;
content = content.replace(oldCompBtn, newCompBtn);

// Chunk 13: Salary Script Start
const oldSalaryCard = `                                            </div>
                                        </div>
                                    )}
                                    <ProfileVisualizer profileData={profileData} />

                                    {/* Salary Negotiation Script */}
                                    {profileData?.hasActiveJD && (
                                        <div className="mt-6 animated fadeIn">
                                            <div className="relative rounded-xl border border-border-subtle overflow-hidden bg-bg-item-surface">`;
const newSalaryCard = `                                            </div>
                                        </BezelCard>
                                    )}
                                    <div className="pt-4">
                                        <ProfileVisualizer profileData={profileData} />
                                    </div>

                                    {profileData?.hasActiveJD && (
                                        <BezelCard delay={0.6}>`;
content = content.replace(oldSalaryCard, newSalaryCard);

// Chunk 14: Salary Script Generate Button
const oldSalaryBtn = `                                                            {!negotiationScript && (
                                                                <button
                                                                    onClick={async () => {
                                                                        setNegotiationGenerating(true);
                                                                        setNegotiationError('');
                                                                        try {
                                                                            const result = await window.electronAPI?.profileGenerateNegotiation?.(false);
                                                                            if (result?.success && result.script) {
                                                                                setNegotiationScript(result.script);
                                                                            } else {
                                                                                setNegotiationError(result?.error || 'Failed to generate');
                                                                            }
                                                                        } catch { setNegotiationError('Generation failed'); }
                                                                        finally { setNegotiationGenerating(false); }
                                                                    }}
                                                                    disabled={negotiationGenerating}
                                                                    className="px-4 py-1.5 rounded-full text-[11px] font-semibold transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-wait"
                                                                    style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.2) 0%, rgba(6,182,212,0.15) 100%)', border: '1px solid rgba(16,185,129,0.3)', color: '#34d399' }}
                                                                >
                                                                    {negotiationGenerating ? <RefreshCw size={11} className="animate-spin" /> : <Sparkles size={11} />}
                                                                    {negotiationGenerating ? 'Generating…' : 'Generate Script'}
                                                                </button>
                                                            )}`;
const newSalaryBtn = `                                                            {!negotiationScript && (
                                                                <MagneticButton
                                                                    onClick={async () => {
                                                                        setNegotiationGenerating(true);
                                                                        setNegotiationError('');
                                                                        try {
                                                                            const result = await window.electronAPI?.profileGenerateNegotiation?.(false);
                                                                            if (result?.success && result.script) {
                                                                                setNegotiationScript(result.script);
                                                                            } else {
                                                                                setNegotiationError(result?.error || 'Failed to generate');
                                                                            }
                                                                        } catch { setNegotiationError('Generation failed'); }
                                                                        finally { setNegotiationGenerating(false); }
                                                                    }}
                                                                    disabled={negotiationGenerating}
                                                                    primary={true}
                                                                    style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.2) 0%, rgba(6,182,212,0.15) 100%)', border: '1px solid rgba(16,185,129,0.3)', color: '#34d399' }}
                                                                >
                                                                    {negotiationGenerating ? <RefreshCw size={11} className="animate-spin" /> : <Sparkles size={11} />}
                                                                    {negotiationGenerating ? 'Generating…' : 'Generate Script'}
                                                                </MagneticButton>
                                                            )}`;
content = content.replace(oldSalaryBtn, newSalaryBtn);

// Chunk 15: Footer
const oldFooter = `                                        </div>
                                    )}

                                </div>
                </div>
            </div>

            <PremiumUpgradeModal`;
const newFooter = `                                        </BezelCard>
                                    )}

                        </div>
                    </div>
                </div>
            </div>

            <PremiumUpgradeModal`;
content = content.replace(oldFooter, newFooter);

fs.writeFileSync('src/components/ProfileIntelligenceSettings.tsx', content);
console.log('Refactor complete!');
