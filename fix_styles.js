const fs = require('fs');
let content = fs.readFileSync('src/components/ProfileIntelligenceSettings.tsx', 'utf8');

// 1. Fix BezelCard
content = content.replace(
    /className=\{\`bg-bg-item-surface border border-border-subtle rounded-\[18px\] overflow-hidden shadow-sm \$\{className\}\`\}/g,
    'className={`bg-bg-item-surface border border-border-subtle rounded-xl overflow-hidden ${className}`}'
);

// 2. Fix MagneticButton
content = content.replace(
    /whileHover=\{!disabled \? \{ scale: 1\.02, y: -1 \} : \{\}\}/g,
    'whileHover={!disabled ? { scale: 1.02 } : {}}'
);
content = content.replace(
    /className=\{\`relative group px-6 py-3 text-\[13px\] tracking-tight font-bold rounded-full flex items-center justify-center gap-2 overflow-hidden \$\{disabled \? 'opacity-50 cursor-not-allowed' : ''\} \$\{className\} \$\{primary \? 'bg-text-primary text-bg-main shadow-\[0_10px_20px_-10px_rgba\(0,0,0,0\.2\)\]' : 'bg-bg-input text-text-primary hover:bg-bg-surface border border-border-subtle'\}\`\}/g,
    "className={`relative group px-3.5 py-2 text-[12px] font-semibold rounded-lg flex items-center justify-center gap-1.5 overflow-hidden ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className} ${primary ? 'bg-text-primary text-bg-main' : 'bg-bg-input text-text-primary hover:bg-bg-surface border border-border-subtle'}`}"
);
content = content.replace(
    /className="absolute inset-0 rounded-full ring-1 ring-inset ring-white\/20 pointer-events-none"/g,
    'className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/10 pointer-events-none"'
);

// 3. Fix main header icon
content = content.replace(
    /w-12 h-12 rounded-\[1\.25rem\]/g,
    'w-10 h-10 rounded-xl'
);
content = content.replace(
    /User size=\{22\}/g,
    'User size={18}'
);

// 4. Fix card header icons and texts
// Old: text-[15px] font-bold tracking-tight -> New: text-sm font-semibold
content = content.replace(
    /text-\[15px\] font-bold text-text-primary mb-1 tracking-tight/g,
    'text-sm font-semibold text-text-primary mb-1'
);
// Old: h3 className="text-lg font-bold -> New: text-[15px] font-semibold
content = content.replace(
    /className="text-lg font-bold text-text-primary tracking-tight"/g,
    'className="text-[15px] font-semibold text-text-primary"'
);
content = content.replace(
    /className="text-\[13px\] text-text-secondary mt-1"/g,
    'className="text-xs text-text-secondary mt-1"'
);

// 5. Fix big icon boxes in cards
content = content.replace(
    /w-10 h-10 rounded-lg bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0 mt-0\.5 shadow-sm/g,
    'w-8 h-8 rounded-[8px] bg-bg-input border border-border-subtle flex items-center justify-center text-text-tertiary shrink-0 mt-0.5'
);
content = content.replace(
    /w-10 h-10 rounded-xl bg-emerald-500\/10 border border-emerald-500\/20 flex items-center justify-center shrink-0 shadow-sm/g,
    'w-8 h-8 rounded-[8px] bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0'
);
content = content.replace(
    /Globe size=\{20\}/g,
    'Globe size={16}'
);
content = content.replace(
    /RefreshCw size=\{20\}/g,
    'RefreshCw size={16}'
);
content = content.replace(
    /Upload size=\{20\}/g,
    'Upload size={16}'
);
content = content.replace(
    /Briefcase size=\{20\}/g,
    'Briefcase size={16}'
);

fs.writeFileSync('src/components/ProfileIntelligenceSettings.tsx', content);
console.log('Fixed styles');
