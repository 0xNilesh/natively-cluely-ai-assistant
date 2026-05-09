const fs = require('fs');
let content = fs.readFileSync('src/components/ProfileIntelligenceSettings.tsx', 'utf8');

const oldProfileCard = `<div className="p-5 flex items-center justify-between">
                                                <div className="flex items-center gap-4 min-w-0">
                                                    <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0">
                                                        {profileUploading ? <RefreshCw size={20} className="animate-spin text-accent-primary" /> : <Upload size={20} />}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <h4 className="text-sm font-bold text-text-primary mb-0.5 truncate pr-4">
                                                            {profileStatus.hasProfile ? 'Overwrite Source Document' : 'Initialize Knowledge Base'}
                                                        </h4>
                                                        {profileUploading ? (
                                                            <div className="flex items-center gap-2">
                                                                <div className="h-[4px] w-[100px] bg-bg-input rounded-full overflow-hidden">
                                                                    <div className="h-full bg-accent-primary rounded-full animate-pulse" style={{ width: '50%' }} />
                                                                </div>
                                                                <span className="text-[10px] text-text-secondary tracking-wide">Processing structural semantics...</span>
                                                            </div>
                                                        ) : (
                                                            <p className="text-xs text-text-secondary truncate pr-4">
                                                                Provide a resume file to seed the intelligence engine.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <MagneticButton`;

const newProfileCard = `<div className="p-5 flex flex-col gap-5">
                                                <div className="flex items-start gap-4 min-w-0">
                                                    <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0 mt-0.5 shadow-sm">
                                                        {profileUploading ? <RefreshCw size={20} className="animate-spin text-accent-primary" /> : <Upload size={20} />}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <h4 className="text-[15px] font-bold text-text-primary mb-1 tracking-tight">
                                                            {profileStatus.hasProfile ? 'Overwrite Source Document' : 'Initialize Knowledge Base'}
                                                        </h4>
                                                        {profileUploading ? (
                                                            <div className="flex items-center gap-2 mt-2">
                                                                <div className="h-[4px] w-[100px] bg-bg-input rounded-full overflow-hidden">
                                                                    <div className="h-full bg-accent-primary rounded-full animate-pulse" style={{ width: '50%' }} />
                                                                </div>
                                                                <span className="text-[10px] text-text-secondary tracking-wide">Processing structural semantics...</span>
                                                            </div>
                                                        ) : (
                                                            <p className="text-xs text-text-secondary leading-relaxed pr-2">
                                                                Provide a resume file to seed the intelligence engine.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex justify-end pt-4 border-t border-border-subtle/50 mt-1">
                                                    <MagneticButton`;

const oldProfileCardEnd = `                                                </MagneticButton>
                                            </div>`;

const newProfileCardEnd = `                                                </MagneticButton>
                                                </div>
                                            </div>`;


const oldJdCard = `<div className="p-5 flex items-center justify-between">
                                                <div className="flex items-center gap-4 min-w-0">
                                                    <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0">
                                                        {jdUploading ? <RefreshCw size={20} className="animate-spin text-blue-500" /> : <Briefcase size={20} />}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <h4 className="text-sm font-bold text-text-primary mb-0.5 truncate pr-4">
                                                            {profileData?.hasActiveJD ? \`\${profileData.activeJD?.title} @ \${profileData.activeJD?.company}\` : 'Upload Job Description'}
                                                        </h4>
                                                        {jdUploading ? (
                                                            <div className="flex items-center gap-2">
                                                                <div className="h-[4px] w-[100px] bg-bg-input rounded-full overflow-hidden">
                                                                    <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: '50%' }} />
                                                                </div>
                                                                <span className="text-[10px] text-text-secondary tracking-wide">Parsing JD structure...</span>
                                                            </div>
                                                        ) : profileData?.hasActiveJD ? (
                                                            <div className="flex items-center gap-3">
                                                                <span className="text-[9px] font-bold text-blue-500 px-1.5 py-0.5 bg-blue-500/10 rounded uppercase tracking-wide border border-blue-500/20">
                                                                    {profileData.activeJD?.level || 'mid'}-level
                                                                </span>
                                                                <div className="flex gap-1.5">
                                                                    {profileData.activeJD?.technologies?.slice(0, 3).map((t: string, i: number) => (
                                                                        <span key={i} className="text-[10px] text-text-secondary">{t}</span>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <p className="text-xs text-text-secondary">
                                                                Upload a JD to enable persona tuning and company research.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2 shrink-0">`;


const newJdCard = `<div className="p-5 flex flex-col gap-5">
                                                <div className="flex items-start gap-4 min-w-0">
                                                    <div className="w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0 mt-0.5 shadow-sm">
                                                        {jdUploading ? <RefreshCw size={20} className="animate-spin text-blue-500" /> : <Briefcase size={20} />}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <h4 className="text-[15px] font-bold text-text-primary mb-1 tracking-tight">
                                                            {profileData?.hasActiveJD ? \`\${profileData.activeJD?.title} @ \${profileData.activeJD?.company}\` : 'Upload Job Description'}
                                                        </h4>
                                                        {jdUploading ? (
                                                            <div className="flex items-center gap-2 mt-2">
                                                                <div className="h-[4px] w-[100px] bg-bg-input rounded-full overflow-hidden">
                                                                    <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: '50%' }} />
                                                                </div>
                                                                <span className="text-[10px] text-text-secondary tracking-wide">Parsing JD structure...</span>
                                                            </div>
                                                        ) : profileData?.hasActiveJD ? (
                                                            <div className="flex items-center gap-3 mt-1 flex-wrap">
                                                                <span className="text-[9px] font-bold text-blue-500 px-1.5 py-0.5 bg-blue-500/10 rounded uppercase tracking-wide border border-blue-500/20">
                                                                    {profileData.activeJD?.level || 'mid'}-level
                                                                </span>
                                                                <div className="flex gap-1.5 flex-wrap">
                                                                    {profileData.activeJD?.technologies?.slice(0, 3).map((t: string, i: number) => (
                                                                        <span key={i} className="text-[10px] text-text-secondary">{t}</span>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <p className="text-xs text-text-secondary leading-relaxed pr-2">
                                                                Upload a JD to enable persona tuning and company research.
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="flex items-center justify-end gap-2 pt-4 border-t border-border-subtle/50 mt-1">`;


content = content.replace(oldProfileCard, newProfileCard);
content = content.replace(oldProfileCardEnd, newProfileCardEnd);
content = content.replace(oldJdCard, newJdCard);

// Let's also do Tavily Search API card to ensure it looks consistent
const oldTavilyCard = `<div className="flex items-start gap-4 mb-5">
                                                    <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                                                        <Globe size={20} className="text-emerald-500" />
                                                    </div>
                                                    <div>
                                                        <h3 className="text-sm font-bold text-text-primary mb-1">Tavily Search API</h3>
                                                        <p className="text-xs text-text-secondary">Powers live web search for company research.</p>
                                                    </div>
                                                </div>`;
const newTavilyCard = `<div className="flex items-start gap-4 mb-5">
                                                    <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0 shadow-sm">
                                                        <Globe size={20} className="text-emerald-500" />
                                                    </div>
                                                    <div>
                                                        <h3 className="text-[15px] font-bold text-text-primary mb-1 tracking-tight">Tavily Search API</h3>
                                                        <p className="text-xs text-text-secondary leading-relaxed">Powers live web search for company research.</p>
                                                    </div>
                                                </div>`;

content = content.replace(oldTavilyCard, newTavilyCard);

fs.writeFileSync('src/components/ProfileIntelligenceSettings.tsx', content);
