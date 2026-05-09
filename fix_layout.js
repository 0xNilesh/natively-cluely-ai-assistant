const fs = require('fs');
let content = fs.readFileSync('src/components/ProfileIntelligenceSettings.tsx', 'utf8');

const target1 = `            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto">
                <div className="max-w-[1400px] mx-auto p-8 pb-32">
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
                                    </motion.div>`;

const replacement1 = `            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto p-5 pb-12">
                    <div className="space-y-6">
                        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, ...spring }} className="mb-4 pt-2">
                            <h3 className="text-lg font-bold text-text-primary tracking-tight">Professional Identity</h3>
                            <p className="text-[13px] text-text-secondary mt-1">
                                This engine constructs an intelligent representation of your career history and skills graph.
                            </p>
                        </motion.div>`;

content = content.replace(target1, replacement1);

// We need to fix the closing tags.
// Let's count them dynamically or just replace exactly what we have.
// In the current file we have:
//                    </div>
//                </div>
//            </div>
//
//            <PremiumUpgradeModal
const target2 = `                    </div>
                </div>
            </div>

            <PremiumUpgradeModal`;

const replacement2 = `                </div>
            </div>

            <PremiumUpgradeModal`;

content = content.replace(target2, replacement2);

fs.writeFileSync('src/components/ProfileIntelligenceSettings.tsx', content);
console.log('Fixed');
