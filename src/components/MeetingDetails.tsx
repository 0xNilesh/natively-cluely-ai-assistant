import React, { useState } from 'react';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { ArrowLeft, Search, Mail, Link, ChevronDown, Play, ArrowUp, Copy, Check, MoreHorizontal, Settings, ArrowRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { genMessageId } from '../utils/messageId';
import MeetingChatOverlay from './MeetingChatOverlay';
import EditableTextBlock from './EditableTextBlock';
import NativelyLogo from './icon.png';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';

SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('py', python);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('js', javascript);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('ts', typescript);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('yml', yaml);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('rs', rust);
SyntaxHighlighter.registerLanguage('cpp', cpp);
SyntaxHighlighter.registerLanguage('c++', cpp);
SyntaxHighlighter.registerLanguage('csharp', csharp);
SyntaxHighlighter.registerLanguage('cs', csharp);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('md', markdown);
SyntaxHighlighter.registerLanguage('markup', markup);
SyntaxHighlighter.registerLanguage('html', markup);

const mapLanguageForPrism = (lang: string, code: string): string => {
  if (!lang) {
    if (code.includes('def ') || code.includes('import ') || code.includes('elif ') || code.includes('print(') || code.includes(':\n')) {
      return 'python';
    }
    return 'javascript';
  }
  const lower = lang.toLowerCase().trim();
  const mapper: Record<string, string> = {
    'js': 'javascript',
    'javascript': 'javascript',
    'ts': 'typescript',
    'typescript': 'typescript',
    'py': 'python',
    'python': 'python',
    'rb': 'ruby',
    'ruby': 'ruby',
    'sh': 'bash',
    'bash': 'bash',
    'shell': 'bash',
    'zsh': 'bash',
    'go': 'go',
    'golang': 'go',
    'rs': 'rust',
    'rust': 'rust',
    'cs': 'csharp',
    'csharp': 'csharp',
    'cpp': 'cpp',
    'c++': 'cpp',
    'h': 'cpp',
    'c': 'c',
    'java': 'java',
    'kt': 'kotlin',
    'kotlin': 'kotlin',
    'swift': 'swift',
    'yml': 'yaml',
    'yaml': 'yaml',
    'xml': 'markup',
    'html': 'markup',
    'svg': 'markup',
    'json': 'json',
    'css': 'css',
    'md': 'markdown',
    'markdown': 'markdown',
    'sql': 'sql',
  };
  return mapper[lower] || lower;
};

const formatTime = (ms: number) => {
    const date = new Date(ms);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase();
};

const formatDuration = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;
};

const cleanMarkdown = (content: string) => {
    if (!content) return '';
    // Ensure code blocks are on new lines to fix rendering issues
    return content.replace(/([^\n])```/g, '$1\n\n```');
};

// The mode's note-section template is the source of truth for the notes layout
// (Summary on top, then the mode's sections). The imposed Decisions/Action-items/
// Open-questions/Risks blocks are kept in the schema (they power the follow-up draft and
// cross-meeting recall) but are NOT rendered as the primary layout. Set true to surface them.
const SHOW_STRUCTURED_BLOCKS = false;

interface Evidence { speakerId?: string; speakerName?: string; speaker?: string; timestampMs?: number; timestamp?: number; quote?: string; segmentId?: string }
interface FollowUpDraftObj { type?: string; subject?: string; body: string; tone?: string }

interface Meeting {
    id: string;
    title: string;
    date: string;
    duration: string;
    summary: string;
    detailedSummary?: {
        overview?: string;
        actionItems: string[];
        keyPoints: string[];
        actionItemsTitle?: string;
        keyPointsTitle?: string;
        sections?: Array<{ title: string; bullets: string[] }>;
        sectionsV3?: Array<{ id: string; title: string; order?: number; bullets: Array<{ id?: string; text: string; confidence?: 'high' | 'medium' | 'low'; evidence?: Evidence[] }> }>;
        tldr?: string[];
        whatChanged?: string[];
        decisions?: Array<{ id?: string; text: string; owner?: string; timestampMs?: number; confidence: 'high' | 'medium' | 'low'; evidence?: Evidence[] }>;
        actionItemsV3?: Array<{ id?: string; text: string; owner?: string; deadline?: string; sourceTimestampMs?: number; explicitness: 'explicit' | 'inferred'; confidence: 'high' | 'medium' | 'low'; status?: 'open' | 'done' | 'deferred'; evidence?: Evidence[] }>;
        openQuestions?: Array<{ id?: string; text: string; owner?: string; status: 'open' | 'answered' | 'deferred'; confidence?: 'high' | 'medium' | 'low'; evidence?: Evidence[] }>;
        risks?: Array<{ id?: string; text: string; severity: 'low' | 'medium' | 'high'; confidence?: 'high' | 'medium' | 'low'; evidence?: Evidence[] }>;
        timeline?: Array<{ id?: string; timestampMs?: number; title: string; description?: string; type: string; evidence?: Evidence[] }>;
        sourceQuality?: { transcriptCoverage: number; speakerQuality: 'good' | 'mixed' | 'poor'; actionItemConfidence: 'high' | 'medium' | 'low'; warnings: string[] };
        mode?: { selectedModeId?: string; selectedModeName?: string; selectedTemplateType?: string; detectedModeId?: string; detectedModeName?: string; detectedConfidence?: number; summaryModeUsed?: string };
        generation?: { strategy?: string; chunkCount?: number; durationMs?: number; warnings?: string[] };
        speakerLabels?: Record<string, string>;
        crossMeeting?: { stillOpen?: string[] };
        recipes?: Record<string, string>;
        // Phase 7 — PostCallWorkflow enhancements (schema v2). Backend writes
        // these via buildPostCallEnhancements(); UI renders them when present.
        schemaVersion?: number;
        actionItemsStructured?: Array<{
            id: string;
            text: string;
            owner?: string;
            deadline?: string;
            sourceTimestamp?: number;
        }>;
        // V3 follow-up is a structured object; legacy rows stored a plain string.
        followUpDraft?: FollowUpDraftObj | string;
        coachingInsights?: Array<{
            id: string;
            type: string;
            title: string;
            detail: string;
            severity: 'info' | 'opportunity' | 'warning';
            evidence?: string;
        }>;
    };
    transcript?: Array<{
        speaker: string;
        text: string;
        timestamp: number;
    }>;
    usage?: Array<{
        type: 'assist' | 'followup' | 'chat' | 'followup_questions';
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
    }>;
}

interface MeetingDetailsProps {
    meeting: Meeting;
    onBack: () => void;
    onOpenSettings: () => void;
}

const MeetingDetails: React.FC<MeetingDetailsProps> = ({ meeting: initialMeeting }) => {
    const isLight = useResolvedTheme() === 'light';
    // We need local state for the meeting object to reflect optimistic updates
    const [meeting, setMeeting] = useState<Meeting>(initialMeeting);
    const [activeTab, setActiveTab] = useState<'summary' | 'transcript' | 'usage'>('summary');
    const [query, setQuery] = useState('');
    const [isCopied, setIsCopied] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [submittedQuery, setSubmittedQuery] = useState('');

    // Stable client-side keys for the action-item and key-point lists. The
    // persisted shape is string[], so React keyed the rows by index, but the
    // onEnter handler splices a new empty row in mid-list — shifting indices
    // and causing React to reuse the wrong EditableTextBlock instance for the
    // shifted rows (focus, draft text, and selection jump to the wrong row).
    // Same bug class as issue #253; keep the ids array in lockstep with the
    // items array via state updates rather than a ref so React re-renders
    // see the post-splice ordering atomically.
    const [actionItemKeys, setActionItemKeys] = useState<string[]>(() =>
        (initialMeeting.detailedSummary?.actionItems ?? []).map(() => genMessageId()),
    );
    const [keyPointKeys, setKeyPointKeys] = useState<string[]>(() =>
        (initialMeeting.detailedSummary?.keyPoints ?? []).map(() => genMessageId()),
    );

    const isV3Summary = meeting.detailedSummary?.schemaVersion === 3;
    const v3Actions = meeting.detailedSummary?.actionItemsV3 || [];
    const v3Decisions = meeting.detailedSummary?.decisions || [];
    const v3Questions = meeting.detailedSummary?.openQuestions || [];
    const v3Risks = meeting.detailedSummary?.risks || [];
    const v3Tldr = meeting.detailedSummary?.tldr || [];
    const v3WhatChanged = meeting.detailedSummary?.whatChanged || [];
    const v3Mode = meeting.detailedSummary?.mode;
    const v3SummaryStatus = (meeting as any).summaryStatus as string | undefined;

    // Normalize follow-up draft (object in V3, legacy string).
    const rawFollowUp = meeting.detailedSummary?.followUpDraft;
    const followUpBody = typeof rawFollowUp === 'string' ? rawFollowUp : (rawFollowUp?.body || '');
    const followUpSubject = typeof rawFollowUp === 'string' ? undefined : rawFollowUp?.subject;
    const followUpDraftTone = (typeof rawFollowUp === 'string' ? undefined : rawFollowUp?.tone) as 'professional' | 'warm' | 'concise' | 'friendly' | undefined;

    // Regenerate / evidence-jump / speaker-rename UI state.
    const [isRegenerating, setIsRegenerating] = useState(false);
    const [isRegeneratingFollowUp, setIsRegeneratingFollowUp] = useState(false);
    // Selected follow-up tone, shown in the selector. Seeded from the saved draft's tone.
    const [followUpTone, setFollowUpTone] = useState<'professional' | 'warm' | 'concise' | 'friendly'>(followUpDraftTone || 'professional');
    const [showEvidence, setShowEvidence] = useState(false);
    const [pendingScrollTs, setPendingScrollTs] = useState<number | null>(null);
    const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
    const [speakerDraft, setSpeakerDraft] = useState('');

    const copyRecipe = (text: string) => {
        navigator.clipboard?.writeText(text || '').catch(() => { /* swallow */ });
    };

    const reloadMeeting = async () => {
        try {
            const fresh = await window.electronAPI?.getMeetingDetails?.(meeting.id);
            if (fresh) {
                setMeeting(fresh as Meeting);
                // Keep the tone selector in sync with the regenerated draft.
                const fu = (fresh as Meeting).detailedSummary?.followUpDraft;
                const tone = typeof fu === 'string' ? undefined : fu?.tone;
                if (tone === 'professional' || tone === 'warm' || tone === 'concise' || tone === 'friendly') setFollowUpTone(tone);
            }
        } catch { /* swallow */ }
    };

    const handleRegenerate = async (templateType?: string) => {
        if (isRegenerating || !window.electronAPI?.regenerateMeetingSummary) return;
        setIsRegenerating(true);
        try {
            const res = await window.electronAPI.regenerateMeetingSummary(meeting.id, templateType ? { templateType } : undefined);
            if (res?.success) await reloadMeeting();
        } catch { /* swallow */ } finally { setIsRegenerating(false); }
    };

    const handleRegenerateFollowUp = async (tone?: 'professional' | 'warm' | 'concise' | 'friendly') => {
        if (isRegeneratingFollowUp || !window.electronAPI?.regenerateMeetingFollowUp) return;
        setIsRegeneratingFollowUp(true);
        try {
            const res = await window.electronAPI.regenerateMeetingFollowUp(meeting.id, tone);
            if (res?.success) await reloadMeeting();
        } catch { /* swallow */ } finally { setIsRegeneratingFollowUp(false); }
    };

    const handleSaveSpeakerLabel = async (speakerId: string, name: string) => {
        const existing = meeting.detailedSummary?.speakerLabels || {};
        const next = { ...existing, [speakerId]: name.trim() };
        if (!name.trim()) delete next[speakerId];
        setMeeting(prev => ({ ...prev, detailedSummary: { ...(prev.detailedSummary as any), speakerLabels: next } }));
        setEditingSpeaker(null);
        try { await window.electronAPI?.updateMeetingSpeakerLabels?.(meeting.id, next); } catch { /* swallow */ }
    };

    // Resolve a transcript segment's display name using saved speaker labels.
    const resolveSpeakerName = (rawSpeaker: string): string => {
        const labels = meeting.detailedSummary?.speakerLabels || {};
        const lower = (rawSpeaker || '').toLowerCase();
        const id = /^(user|me)$/.test(lower) ? 'me' : (/^(interviewer|them|other|system|assistant)$/.test(lower) ? 'speaker_1' : lower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown');
        if (labels[id]) return labels[id];
        if (id === 'me') return 'Me';
        if (id === 'speaker_1') return 'Speaker 1';
        return rawSpeaker || 'Speaker';
    };

    const evidenceTimestamp = (evidence?: Evidence[]): number | undefined => {
        const first = evidence?.[0];
        if (!first) return undefined;
        return typeof first.timestampMs === 'number' ? first.timestampMs : (typeof first.timestamp === 'number' ? first.timestamp : undefined);
    };

    // Transcript timestamps are absolute epoch ms (Date.now()); the earliest segment is the
    // meeting start. Use it to render evidence times as a relative m:ss offset into the meeting.
    const meetingStartMs = React.useMemo(() => {
        const ts = (meeting.transcript || []).map(t => t.timestamp).filter(t => typeof t === 'number' && t > 0);
        return ts.length ? Math.min(...ts) : 0;
    }, [meeting.transcript]);

    // Render a (possibly absolute-epoch) timestamp as a relative m:ss into the meeting.
    const formatEvidenceTime = (ts?: number): string => {
        if (typeof ts !== 'number') return '';
        // Epoch-ms values are huge; subtract meeting start. Already-relative small values pass through.
        const rel = ts > 1e11 && meetingStartMs > 0 ? ts - meetingStartMs : ts;
        return formatDuration(Math.max(0, rel));
    };

    const evidenceLabel = (evidence?: Evidence[]) => {
        const first = evidence?.[0];
        if (!first) return '';
        const time = formatEvidenceTime(evidenceTimestamp(evidence));
        const who = first.speakerName || first.speaker || '';
        const quote = first.quote ? `“${first.quote}”` : '';
        return [time, who, quote].filter(Boolean).join(' · ');
    };

    // Jump to the transcript tab and scroll to the segment nearest an evidence timestamp.
    const jumpToEvidence = (evidence?: Evidence[]) => {
        const ts = evidenceTimestamp(evidence);
        if (typeof ts !== 'number') return;
        setActiveTab('transcript');
        setPendingScrollTs(ts);
    };

    const handleSubmitQuestion = () => {
        if (query.trim()) {
            setSubmittedQuery(query);
            if (!isChatOpen) {
                setIsChatOpen(true);
            }
            setQuery('');
        }
    };

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && query.trim()) {
            e.preventDefault();
            handleSubmitQuestion();
        }
    };

    const handleCopy = async () => {
        let textToCopy = '';

        if (activeTab === 'summary' && meeting.detailedSummary) {
            if (meeting.detailedSummary.schemaVersion === 3) {
                textToCopy = `
Meeting: ${meeting.title}
Date: ${new Date(meeting.date).toLocaleDateString()}

TLDR:
${meeting.detailedSummary.tldr?.map(item => `- ${item}`).join('\n') || 'None'}

WHAT CHANGED:
${meeting.detailedSummary.whatChanged?.map(item => `- ${item}`).join('\n') || 'None'}

DECISIONS:
${meeting.detailedSummary.decisions?.map(item => `- ${item.text}`).join('\n') || 'None'}

ACTION ITEMS:
${meeting.detailedSummary.actionItemsV3?.map(item => `- ${item.owner ? `${item.owner}: ` : ''}${item.text}${item.deadline ? ` by ${item.deadline}` : ''}${item.explicitness === 'inferred' ? ' (inferred)' : ''}`).join('\n') || 'None'}

OPEN QUESTIONS:
${meeting.detailedSummary.openQuestions?.map(item => `- ${item.text}`).join('\n') || 'None'}

RISKS / BLOCKERS:
${meeting.detailedSummary.risks?.map(item => `- [${item.severity}] ${item.text}`).join('\n') || 'None'}

OVERVIEW:
${meeting.detailedSummary.overview || ''}
${followUpBody.trim() ? `\nFOLLOW-UP DRAFT:\n${followUpSubject ? `Subject: ${followUpSubject}\n` : ''}${followUpBody}` : ''}
                `.trim();
            } else {
                textToCopy = `
Meeting: ${meeting.title}
Date: ${new Date(meeting.date).toLocaleDateString()}

OVERVIEW:
${meeting.detailedSummary.overview || ''}

ACTION ITEMS:
${meeting.detailedSummary.actionItems?.map(item => `- ${item}`).join('\n') || 'None'}

KEY POINTS:
${meeting.detailedSummary.keyPoints?.map(item => `- ${item}`).join('\n') || 'None'}
                `.trim();
            }
        } else if (activeTab === 'transcript' && meeting.transcript) {
            textToCopy = meeting.transcript.map(t => `[${formatTime(t.timestamp)}] ${resolveSpeakerName(t.speaker)}: ${t.text}`).join('\n');
        } else if (activeTab === 'usage' && meeting.usage) {
            textToCopy = meeting.usage.map(u => `Q: ${u.question || ''}\nA: ${u.answer || ''}`).join('\n\n');
        }

        if (!textToCopy) return;

        try {
            await navigator.clipboard.writeText(textToCopy);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy content:', err);
        }
    };

    // UPDATE HANDLERS
    const handleTitleSave = async (newTitle: string) => {
        setMeeting(prev => ({ ...prev, title: newTitle }));
        if (window.electronAPI?.updateMeetingTitle) {
            await window.electronAPI.updateMeetingTitle(meeting.id, newTitle);
        }
    };

    const handleOverviewSave = async (newOverview: string) => {
        setMeeting(prev => ({
            ...prev,
            detailedSummary: {
                ...prev.detailedSummary!,
                overview: newOverview
            }
        }));
        if (window.electronAPI?.updateMeetingSummary) {
            await window.electronAPI.updateMeetingSummary(meeting.id, { overview: newOverview });
        }
    };

    const handleActionItemSave = async (index: number, newVal: string) => {
        const newItems = [...(meeting.detailedSummary?.actionItems || [])];
        if (!newVal.trim()) {
            // Optional: Remove empty items? For now just keep empty or update
        }
        newItems[index] = newVal;

        setMeeting(prev => ({
            ...prev,
            detailedSummary: {
                ...prev.detailedSummary!,
                actionItems: newItems
            }
        }));

        if (window.electronAPI?.updateMeetingSummary) {
            await window.electronAPI.updateMeetingSummary(meeting.id, { actionItems: newItems });
        }
    };

    const handleKeyPointSave = async (index: number, newVal: string) => {
        const newItems = [...(meeting.detailedSummary?.keyPoints || [])];
        newItems[index] = newVal;

        setMeeting(prev => ({
            ...prev,
            detailedSummary: {
                ...prev.detailedSummary!,
                keyPoints: newItems
            }
        }));

        if (window.electronAPI?.updateMeetingSummary) {
            await window.electronAPI.updateMeetingSummary(meeting.id, { keyPoints: newItems });
        }
    };


    return (
        <div className="h-full w-full flex flex-col bg-bg-secondary text-text-secondary font-sans overflow-hidden">
            {/* Main Content */}
            <main className="flex-1 overflow-y-auto custom-scrollbar">
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1, duration: 0.3 }}
                    className="max-w-4xl mx-auto px-8 py-8 pb-32" // Added pb-32 for floating footer clearance
                >
                    {/* Meta Info & Actions Row */}
                    <div className="flex items-start justify-between mb-6">
                        <div className="w-full pr-4">
                            {/* Date formatting could be improved to use meeting.date if it's an ISO string */}
                            <div className="text-xs text-text-tertiary font-medium mb-1">
                                {new Date(meeting.date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                            </div>

                            {/* Editable Title */}
                            <EditableTextBlock
                                initialValue={meeting.title}
                                onSave={handleTitleSave}
                                tagName="h1"
                                className="text-3xl font-bold text-text-primary tracking-tight -ml-2 px-2 py-1 rounded-md transition-colors"
                                multiline={false}
                            />
                        </div>

                        {/* Moved Actions: Follow-up & Share (REMOVED per user request) */}
                        {/* <div className="flex items-center gap-2 mt-1"> ... </div> */}
                    </div>

                    {/* Tabs */}
                    {/* Designing Tabs to match reference 1:1 (Dark Pill Container) */}
                    <div className="flex items-center justify-between mb-8">
                        <div className={`p-1 rounded-xl inline-flex items-center gap-0.5 ${isLight ? 'bg-[#E5E5EA] border border-black/[0.04]' : 'bg-[#121214] border border-white/[0.08]'}`}>
                            {['summary', 'transcript', 'usage'].map((tab) => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveTab(tab as any)}
                                    className={`
                                        relative px-3 py-1 text-[13px] font-medium rounded-lg transition-all duration-200 z-10
                                        ${activeTab === tab ? (isLight ? 'text-black' : 'text-[#E9E9E9]') : `${isLight ? 'text-text-secondary' : 'text-text-tertiary'} hover:text-text-primary`}
                                    `}
                                >
                                    {activeTab === tab && (
                                        <motion.div
                                            layoutId="activeTabBackground"
                                            className={`absolute inset-0 rounded-lg -z-10 shadow-sm ${isLight ? 'bg-white' : 'bg-[#3A3A3C]'}`}
                                            initial={false}
                                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                                        />
                                    )}
                                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                                </button>
                            ))}
                        </div>

                        {/* Copy Button - Inline with Tabs (Always visible) */}
                        <button
                            onClick={handleCopy}
                            className="flex items-center gap-2 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
                        >
                            {isCopied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                            {isCopied ? 'Copied' : activeTab === 'summary' ? 'Copy full summary' : activeTab === 'transcript' ? 'Copy full transcript' : 'Copy usage'}
                        </button>
                    </div>

                    {/* Tab Content */}
                    <div className="space-y-8">
                        {/* Using standard divs for content, framer motion for layout */}
                        {activeTab === 'summary' && (
                            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                {/* Overview - Rendered as Markdown */}
                                {meeting.detailedSummary?.overview && (
                                <div className="mb-6 pb-6 border-b border-border-subtle prose prose-sm max-w-none">
                                    <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        components={{
                                            h1: ({ node, ...props }) => <h1 className="text-xl font-bold text-text-primary mt-4 mb-2" {...props} />,
                                            h2: ({ node, ...props }) => <h2 className="text-lg font-semibold text-text-primary mt-4 mb-2" {...props} />,
                                            h3: ({ node, ...props }) => <h3 className="text-base font-semibold text-text-primary mt-3 mb-1" {...props} />,
                                            p: ({ node, ...props }) => <p className="text-sm text-text-secondary leading-relaxed mb-2" {...props} />,
                                            ul: ({ node, ...props }) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                                            ol: ({ node, ...props }) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                                            li: ({ node, ...props }) => <li className="text-sm text-text-secondary" {...props} />,
                                            strong: ({ node, ...props }) => <strong className="font-semibold text-text-primary" {...props} />,
                                            a: ({ node, ...props }) => <a className="text-blue-500 hover:underline" {...props} />,
                                        }}
                                    >
                                        {meeting.detailedSummary?.overview || ''}
                                    </ReactMarkdown>
                                </div>
                                )}

                                {/* V3 — product-grade structured notes: fast skim, decisions, actions, open questions, risks, quality. */}
                                {isV3Summary && meeting.detailedSummary?.sourceQuality?.warnings && meeting.detailedSummary.sourceQuality.warnings.length > 0 && (
                                    <section className="mb-6 p-3 rounded-[10px] border border-amber-400/30 bg-amber-500/5">
                                        <p className="text-sm font-semibold text-text-primary mb-1">Quality warning</p>
                                        <ul className="space-y-1">
                                            {meeting.detailedSummary.sourceQuality.warnings.map((warning, i) => (
                                                <li key={i} className="text-[12.5px] text-text-secondary leading-relaxed">{warning}</li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {/* V3 toolbar: regenerate + evidence toggle + processing status */}
                                {isV3Summary && (
                                    <div className="mb-6 flex flex-wrap items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => handleRegenerate()}
                                            disabled={isRegenerating}
                                            className="text-[11px] px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 disabled:opacity-50 text-text-secondary border border-white/10 transition-colors"
                                        >
                                            {isRegenerating ? 'Regenerating…' : 'Regenerate notes'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setShowEvidence(v => !v)}
                                            className="text-[11px] px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-text-secondary border border-white/10 transition-colors"
                                        >
                                            {showEvidence ? 'Hide evidence' : 'Show evidence'}
                                        </button>
                                        {v3SummaryStatus && v3SummaryStatus !== 'completed' && (
                                            <span className="text-[11px] text-amber-400">Status: {v3SummaryStatus.replace(/_/g, ' ')}</span>
                                        )}
                                    </div>
                                )}

                                {/* Mode auto-detect suggestion: only when detected differs from selected with confidence. */}
                                {isV3Summary && v3Mode?.detectedModeName && v3Mode?.detectedConfidence != null && v3Mode.detectedConfidence >= 0.5 &&
                                  v3Mode.detectedModeName !== v3Mode.selectedModeName && (
                                    <section className="mb-6 p-3 rounded-[10px] border border-blue-400/30 bg-blue-500/5 flex items-center justify-between gap-3">
                                        <p className="text-[12.5px] text-text-secondary leading-relaxed">
                                            This looks like a <span className="font-semibold text-text-primary">{v3Mode.detectedModeName}</span> meeting
                                            {v3Mode.selectedModeName ? <> (notes used {v3Mode.selectedModeName})</> : null}.
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => handleRegenerate(v3Mode.detectedModeId ? undefined : (v3Mode.detectedModeName || '').toLowerCase())}
                                            disabled={isRegenerating}
                                            className="shrink-0 text-[11px] px-2.5 py-1 rounded-md bg-blue-500/15 hover:bg-blue-500/25 disabled:opacity-50 text-blue-300 border border-blue-400/30 transition-colors"
                                        >
                                            Regenerate as {v3Mode.detectedModeName}
                                        </button>
                                    </section>
                                )}

                                {/* Cross-meeting recall: still-open carryover from prior meetings (Phase 13). */}
                                {isV3Summary && meeting.detailedSummary?.crossMeeting?.stillOpen && meeting.detailedSummary.crossMeeting.stillOpen.length > 0 && (
                                    <section className="mb-6 p-3 rounded-[10px] border border-purple-400/30 bg-purple-500/5">
                                        <p className="text-sm font-semibold text-text-primary mb-1">Carried over from earlier meetings</p>
                                        <ul className="space-y-1">
                                            {meeting.detailedSummary.crossMeeting.stillOpen.map((line, i) => (
                                                <li key={i} className="text-[12.5px] text-text-secondary leading-relaxed">{line}</li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {/* Summary on top — outcome-first, grounded. Then the mode's template sections below. */}
                                {isV3Summary && v3Tldr.length > 0 && (
                                    <section className="mb-8">
                                        <h2 className="text-lg font-semibold text-text-primary mb-4">Summary</h2>
                                        <ul className="space-y-3">
                                            {v3Tldr.map((item, i) => (
                                                <li key={i} className="flex items-start gap-3 group">
                                                    <div className="mt-2 w-1.5 h-1.5 rounded-full bg-purple-500/80 shrink-0" />
                                                    <p className="text-sm text-text-secondary leading-relaxed">{item}</p>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {/* The mode's note-section TEMPLATE — the primary notes layout (e.g. Questions and
                                    responses, Discovery, Action items). Rendered right under Summary, in template order.
                                    Empty sections are dropped server-side. */}
                                {isV3Summary && meeting.detailedSummary?.sectionsV3 && meeting.detailedSummary.sectionsV3.length > 0 && (
                                    <>
                                        {meeting.detailedSummary.sectionsV3.map((section) => (
                                            <section key={section.id} className="mb-8">
                                                <h2 className="text-lg font-semibold text-text-primary mb-4">{section.title}</h2>
                                                <ul className="space-y-3">
                                                    {section.bullets.map((bullet, i) => (
                                                        <li key={bullet.id || i} className="flex items-start gap-3">
                                                            <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary/60 shrink-0" />
                                                            <div className="min-w-0 flex-1">
                                                                <p className="text-sm text-text-secondary leading-relaxed">{bullet.text}</p>
                                                                {showEvidence && evidenceLabel(bullet.evidence) && (
                                                                    <button type="button" onClick={() => jumpToEvidence(bullet.evidence)} className="text-[11px] text-blue-400/80 hover:text-blue-300 mt-1 text-left">↳ {evidenceLabel(bullet.evidence)}</button>
                                                                )}
                                                            </div>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </section>
                                        ))}
                                    </>
                                )}

                                {/* SHOW_STRUCTURED_BLOCKS: the mode's note-section TEMPLATE is the source of truth, so the
                                    imposed What-changed/Decisions/Actions/Questions/Risks blocks are NOT rendered as the
                                    primary layout (they remain in the schema, powering the follow-up draft + cross-meeting
                                    recall). Flip to true to surface them again. */}
                                {SHOW_STRUCTURED_BLOCKS && isV3Summary && v3WhatChanged.length > 0 && (
                                    <section className="mb-8">
                                        <h2 className="text-lg font-semibold text-text-primary mb-4">What changed</h2>
                                        <ul className="space-y-3">
                                            {v3WhatChanged.map((item, i) => (
                                                <li key={i} className="flex items-start gap-3 group">
                                                    <div className="mt-2 w-1.5 h-1.5 rounded-full bg-indigo-500/80 shrink-0" />
                                                    <p className="text-sm text-text-secondary leading-relaxed">{item}</p>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {SHOW_STRUCTURED_BLOCKS && isV3Summary && v3Decisions.length > 0 && (
                                    <section className="mb-8">
                                        <h2 className="text-lg font-semibold text-text-primary mb-4">Decisions</h2>
                                        <ul className="space-y-3">
                                            {v3Decisions.map((item, i) => (
                                                <li key={item.id || i} className="p-3 rounded-[10px] border border-white/10 bg-white/[0.02]">
                                                    <div className="flex items-start gap-3">
                                                        <div className="mt-2 w-1.5 h-1.5 rounded-full bg-blue-500/80 shrink-0" />
                                                        <div className="min-w-0 flex-1">
                                                            <p className="text-sm text-text-secondary leading-relaxed">{item.text}</p>
                                                            <p className="text-[11px] text-text-tertiary mt-1">
                                                                {item.owner && <span>{item.owner} · </span>}
                                                                <span>{item.confidence} confidence</span>
                                                            </p>
                                                            {showEvidence && evidenceLabel(item.evidence) && (
                                                                <button type="button" onClick={() => jumpToEvidence(item.evidence)} className="text-[11px] text-blue-400/80 hover:text-blue-300 mt-1 text-left">↳ {evidenceLabel(item.evidence)}</button>
                                                            )}
                                                        </div>
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {SHOW_STRUCTURED_BLOCKS && isV3Summary && v3Actions.length > 0 && (
                                    <section className="mb-8">
                                        <h2 className="text-lg font-semibold text-text-primary mb-4">Action Items</h2>
                                        <ul className="space-y-3">
                                            {v3Actions.map((item, i) => (
                                                <li key={item.id || i} className="p-3 rounded-[10px] border border-emerald-400/20 bg-emerald-500/[0.03]">
                                                    <div className="flex items-start gap-3">
                                                        <div className="mt-2 w-1.5 h-1.5 rounded-full bg-emerald-500/80 shrink-0" />
                                                        <div className="min-w-0 flex-1">
                                                            <p className="text-sm text-text-secondary leading-relaxed">{item.text}</p>
                                                            <p className="text-[11px] text-text-tertiary mt-1 flex flex-wrap gap-x-1">
                                                                {item.owner && <span className="font-medium">{item.owner}</span>}
                                                                {item.deadline && <span>by {item.deadline}</span>}
                                                                <span className={`px-1.5 py-0.5 rounded border ${item.explicitness === 'explicit' ? 'border-emerald-400/30 text-emerald-400' : 'border-amber-400/30 text-amber-400'}`}>{item.explicitness}</span>
                                                                <span>{item.confidence} confidence</span>
                                                            </p>
                                                            {showEvidence && evidenceLabel(item.evidence) && (
                                                                <button type="button" onClick={() => jumpToEvidence(item.evidence)} className="text-[11px] text-blue-400/80 hover:text-blue-300 mt-1 text-left">↳ {evidenceLabel(item.evidence)}</button>
                                                            )}
                                                        </div>
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {SHOW_STRUCTURED_BLOCKS && isV3Summary && v3Questions.length > 0 && (
                                    <section className="mb-8">
                                        <h2 className="text-lg font-semibold text-text-primary mb-4">Open Questions</h2>
                                        <ul className="space-y-3">
                                            {v3Questions.map((item, i) => (
                                                <li key={item.id || i} className="flex items-start gap-3 group">
                                                    <div className="mt-2 w-1.5 h-1.5 rounded-full bg-yellow-500/80 shrink-0" />
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm text-text-secondary leading-relaxed">{item.text}</p>
                                                        <p className="text-[11px] text-text-tertiary mt-0.5">{item.status}{item.owner ? ` · ${item.owner}` : ''}{evidenceLabel(item.evidence) ? ` · ${evidenceLabel(item.evidence)}` : ''}</p>
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {SHOW_STRUCTURED_BLOCKS && isV3Summary && v3Risks.length > 0 && (
                                    <section className="mb-8">
                                        <h2 className="text-lg font-semibold text-text-primary mb-4">Risks / Blockers</h2>
                                        <ul className="space-y-3">
                                            {v3Risks.map((item, i) => (
                                                <li key={item.id || i} className="p-3 rounded-[10px] border border-red-400/20 bg-red-500/[0.03]">
                                                    <p className="text-sm text-text-secondary leading-relaxed">{item.text}</p>
                                                    <p className="text-[11px] text-text-tertiary mt-1">{item.severity} severity{evidenceLabel(item.evidence) ? ` · ${evidenceLabel(item.evidence)}` : ''}</p>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {/* V3 follow-up draft — human prose, copy + regenerate + tone. */}
                                {isV3Summary && followUpBody.trim() && (
                                    <section className="mb-8">
                                        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                                            <h2 className="text-lg font-semibold text-text-primary">Follow-up draft</h2>
                                            <div className="flex items-center gap-2">
                                                <button type="button" onClick={() => copyRecipe((followUpSubject ? `Subject: ${followUpSubject}\n\n` : '') + followUpBody)} className="text-[11px] px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-text-secondary border border-white/10 transition-colors">Copy</button>
                                                <button type="button" onClick={() => handleRegenerateFollowUp()} disabled={isRegeneratingFollowUp} className="text-[11px] px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 disabled:opacity-50 text-text-secondary border border-white/10 transition-colors">{isRegeneratingFollowUp ? 'Regenerating…' : 'Regenerate'}</button>
                                                <select
                                                    value={followUpTone}
                                                    onChange={(e) => { const t = e.target.value as 'professional' | 'warm' | 'concise' | 'friendly'; setFollowUpTone(t); handleRegenerateFollowUp(t); }}
                                                    className="text-[11px] px-1.5 py-1 rounded-md bg-white/5 text-text-secondary border border-white/10"
                                                    title="Regenerate with tone"
                                                >
                                                    <option value="professional">Professional</option>
                                                    <option value="warm">Warm</option>
                                                    <option value="concise">Concise</option>
                                                    <option value="friendly">Friendly</option>
                                                </select>
                                            </div>
                                        </div>
                                        {followUpSubject && <p className="text-[12.5px] text-text-tertiary mb-1">Subject: {followUpSubject}</p>}
                                        <pre className="text-[12.5px] text-text-secondary leading-relaxed whitespace-pre-wrap font-sans select-text cursor-text p-3 rounded-[10px] border border-white/10 bg-white/[0.02]">{followUpBody}</pre>
                                    </section>
                                )}

                                {/* Action Items - Only show if there are items */}
                                {!isV3Summary && meeting.detailedSummary?.actionItems && meeting.detailedSummary.actionItems.length > 0 && (
                                    <section className="mb-8">
                                        <div className="flex items-center justify-between mb-4">
                                            <EditableTextBlock
                                                initialValue={meeting.detailedSummary?.actionItemsTitle || 'Action Items'}
                                                onSave={(val) => {
                                                    setMeeting(prev => ({
                                                        ...prev,
                                                        detailedSummary: { ...prev.detailedSummary!, actionItemsTitle: val }
                                                    }));
                                                    window.electronAPI?.updateMeetingSummary(meeting.id, { actionItemsTitle: val });
                                                }}
                                                tagName="h2"
                                                className="text-lg font-semibold text-text-primary -ml-2 px-2 py-1 rounded-sm transition-colors"
                                                multiline={false}
                                            />
                                        </div>
                                        <ul className="space-y-3">
                                            {meeting.detailedSummary.actionItems.map((item, i) => (
                                                <li key={actionItemKeys[i] ?? i} className="flex items-start gap-3 group">
                                                    <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:bg-blue-500 transition-colors shrink-0" />
                                                    <div className="flex-1">
                                                        <EditableTextBlock
                                                            initialValue={item}
                                                            onSave={(val) => handleActionItemSave(i, val)}
                                                            tagName="p"
                                                            className="text-sm text-text-secondary leading-relaxed -ml-2 px-2 rounded-sm transition-colors"
                                                            placeholder="Type an action item..."
                                                            onEnter={() => {
                                                                const newItems = [...(meeting.detailedSummary?.actionItems || [])];
                                                                newItems.splice(i + 1, 0, "");
                                                                setActionItemKeys(prev => {
                                                                    const next = [...prev];
                                                                    next.splice(i + 1, 0, genMessageId());
                                                                    return next;
                                                                });
                                                                setMeeting(prev => ({
                                                                    ...prev,
                                                                    detailedSummary: { ...prev.detailedSummary!, actionItems: newItems }
                                                                }));
                                                            }}
                                                        />
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {/* Key Points - Only show if there are items */}
                                {!isV3Summary && meeting.detailedSummary?.keyPoints && meeting.detailedSummary.keyPoints.length > 0 && (
                                    <section>
                                        <div className="flex items-center justify-between mb-4">
                                            <EditableTextBlock
                                                initialValue={meeting.detailedSummary?.keyPointsTitle || 'Key Points'}
                                                onSave={(val) => {
                                                    setMeeting(prev => ({
                                                        ...prev,
                                                        detailedSummary: { ...prev.detailedSummary!, keyPointsTitle: val }
                                                    }));
                                                    window.electronAPI?.updateMeetingSummary(meeting.id, { keyPointsTitle: val });
                                                }}
                                                tagName="h2"
                                                className="text-lg font-semibold text-text-primary -ml-2 px-2 py-1 rounded-sm transition-colors"
                                                multiline={false}
                                            />
                                        </div>
                                        <ul className="space-y-3">
                                            {meeting.detailedSummary.keyPoints.map((item, i) => (
                                                <li key={keyPointKeys[i] ?? i} className="flex items-start gap-3 group">
                                                    <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:bg-purple-500 transition-colors shrink-0" />
                                                    <div className="flex-1">
                                                        <EditableTextBlock
                                                            initialValue={item}
                                                            onSave={(val) => handleKeyPointSave(i, val)}
                                                            tagName="p"
                                                            className="text-sm text-text-secondary leading-relaxed -ml-2 px-2 rounded-sm transition-colors"
                                                            placeholder="Type a key point..."
                                                            onEnter={() => {
                                                                const newItems = [...(meeting.detailedSummary?.keyPoints || [])];
                                                                newItems.splice(i + 1, 0, "");
                                                                setKeyPointKeys(prev => {
                                                                    const next = [...prev];
                                                                    next.splice(i + 1, 0, genMessageId());
                                                                    return next;
                                                                });
                                                                setMeeting(prev => ({
                                                                    ...prev,
                                                                    detailedSummary: { ...prev.detailedSummary!, keyPoints: newItems }
                                                                }));
                                                            }}
                                                        />
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {/* Phase 7 — Structured action items (with owner / deadline).
                                    Rendered ONLY when PostCallWorkflow has produced them
                                    (schemaVersion === 2). Falls through silently otherwise so
                                    pre-Phase-7 meetings still look the same. */}
                                {!isV3Summary && meeting.detailedSummary?.actionItemsStructured && meeting.detailedSummary.actionItemsStructured.length > 0 && (
                                    <section className="mb-8">
                                        <h2 className="text-lg font-semibold text-text-primary mb-4">Next Steps</h2>
                                        <ul className="space-y-2">
                                            {meeting.detailedSummary.actionItemsStructured.map(item => (
                                                <li key={item.id} className="flex items-start gap-3 group">
                                                    <div className="mt-2 w-1.5 h-1.5 rounded-full bg-emerald-500/70 group-hover:bg-emerald-400 shrink-0" />
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm text-text-secondary leading-relaxed">{item.text}</p>
                                                        {(item.owner || item.deadline) && (
                                                            <p className="text-[11px] text-text-tertiary mt-0.5">
                                                                {item.owner && <span className="font-medium">{item.owner}</span>}
                                                                {item.owner && item.deadline && <span> · </span>}
                                                                {item.deadline && <span>by {item.deadline}</span>}
                                                            </p>
                                                        )}
                                                    </div>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                {/* Phase 7 — Coaching insights (mode-specific opportunities). */}
                                {meeting.detailedSummary?.coachingInsights && meeting.detailedSummary.coachingInsights.length > 0 && (
                                    <section className="mb-8">
                                        <h2 className="text-lg font-semibold text-text-primary mb-4">Coaching</h2>
                                        <ul className="space-y-3">
                                            {meeting.detailedSummary.coachingInsights.map(insight => {
                                                const tone = insight.severity === 'warning'
                                                    ? 'border-amber-400/40 bg-amber-500/5'
                                                    : insight.severity === 'opportunity'
                                                        ? 'border-blue-400/40 bg-blue-500/5'
                                                        : 'border-text-tertiary/30 bg-transparent';
                                                return (
                                                    <li key={insight.id} className={`p-3 rounded-[10px] border ${tone}`}>
                                                        <p className="text-sm font-semibold text-text-primary">{insight.title}</p>
                                                        <p className="text-[12.5px] text-text-secondary mt-1 leading-relaxed">{insight.detail}</p>
                                                        {insight.evidence && (
                                                            <p className="text-[11px] text-text-tertiary mt-1.5 italic">"{insight.evidence}"</p>
                                                        )}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    </section>
                                )}

                                {/* Phase 7 — Follow-up email draft (legacy V2: string). V3 renders its own above. */}
                                {!isV3Summary && typeof meeting.detailedSummary?.followUpDraft === 'string' && meeting.detailedSummary.followUpDraft.trim() && (
                                    <section className="mb-8">
                                        <div className="flex items-center justify-between mb-3">
                                            <h2 className="text-lg font-semibold text-text-primary">Follow-up Draft</h2>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const fu = meeting.detailedSummary?.followUpDraft;
                                                    navigator.clipboard?.writeText(typeof fu === 'string' ? fu : '').catch(() => { /* swallow */ });
                                                }}
                                                className="text-[11px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-text-secondary border border-white/10 transition-colors"
                                            >
                                                Copy
                                            </button>
                                        </div>
                                        <pre className="text-[12.5px] text-text-secondary leading-relaxed whitespace-pre-wrap font-sans select-text cursor-text p-3 rounded-[10px] border border-white/10 bg-white/[0.02]">{meeting.detailedSummary.followUpDraft}</pre>
                                    </section>
                                )}

                                {/* Mode-specific sections (when active mode has a notes template) */}
                                {!isV3Summary && meeting.detailedSummary?.sections && meeting.detailedSummary.sections.length > 0 && (
                                    <div className="space-y-8">
                                        {meeting.detailedSummary.sections.map((section, si) => (
                                            section.bullets.length > 0 && (
                                                <section key={`${section.title}-${si}`}>
                                                    <div className="flex items-center justify-between mb-4">
                                                        <h2 className="text-lg font-semibold text-text-primary">{section.title}</h2>
                                                    </div>
                                                    <ul className="space-y-3">
                                                        {section.bullets.map((bullet, bi) => (
                                                            <li key={bi} className="flex items-start gap-3 group">
                                                                <div className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary shrink-0" />
                                                                <p className="text-sm text-text-secondary leading-relaxed">{bullet}</p>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </section>
                                            )
                                        ))}
                                    </div>
                                )}
                            </motion.div>
                        )}

                        {activeTab === 'transcript' && (
                            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                {/* Speaker rename row: distinct speakers + inline rename (Phase 9). */}
                                {(() => {
                                    const speakers = Array.from(new Set((meeting.transcript || [])
                                        .filter(e => !['system', 'ai', 'assistant', 'model'].includes((e.speaker || '').toLowerCase()))
                                        .map(e => e.speaker)));
                                    if (speakers.length === 0) return null;
                                    return (
                                        <div className="mb-5 flex flex-wrap items-center gap-2">
                                            <span className="text-[11px] text-text-tertiary">Speakers:</span>
                                            {speakers.map((sp) => {
                                                const display = resolveSpeakerName(sp);
                                                const id = (sp || '').toLowerCase().replace(/^(user|me)$/, 'me').replace(/^(interviewer|them|other|system|assistant)$/, 'speaker_1').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
                                                if (editingSpeaker === id) {
                                                    return (
                                                        <span key={id} className="flex items-center gap-1">
                                                            <input
                                                                autoFocus
                                                                value={speakerDraft}
                                                                onChange={e => setSpeakerDraft(e.target.value)}
                                                                onKeyDown={e => { if (e.key === 'Enter') handleSaveSpeakerLabel(id, speakerDraft); if (e.key === 'Escape') setEditingSpeaker(null); }}
                                                                onBlur={() => handleSaveSpeakerLabel(id, speakerDraft)}
                                                                placeholder={display}
                                                                className="text-[11px] px-2 py-1 rounded-md bg-white/10 text-text-primary border border-blue-400/40 w-36"
                                                            />
                                                        </span>
                                                    );
                                                }
                                                return (
                                                    <button
                                                        key={id}
                                                        type="button"
                                                        onClick={() => { setEditingSpeaker(id); setSpeakerDraft(display); }}
                                                        className="text-[11px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-text-secondary border border-white/10 transition-colors"
                                                        title="Rename speaker"
                                                    >
                                                        {display} ✎
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    );
                                })()}
                                <div className="space-y-6">
                                    {(() => {
                                        const filteredTranscript = meeting.transcript?.filter(entry => {
                                            const isHidden = ['system', 'ai', 'assistant', 'model'].includes(entry.speaker?.toLowerCase());
                                            return !isHidden;
                                        }) || [];

                                        if (filteredTranscript.length === 0) {
                                            return <p className="text-text-tertiary">No transcript available.</p>;
                                        }

                                        // Find the segment index closest to a pending evidence timestamp.
                                        const scrollIndex = pendingScrollTs == null ? -1 : filteredTranscript.reduce((best, e, idx) => {
                                            const d = Math.abs((e.timestamp || 0) - pendingScrollTs);
                                            return d < best.d ? { d, idx } : best;
                                        }, { d: Infinity, idx: -1 }).idx;

                                        return filteredTranscript.map((entry, i) => (
                                            <div
                                                key={i}
                                                className={`group rounded-md transition-colors ${i === scrollIndex ? 'bg-blue-500/10 ring-1 ring-blue-400/30 -mx-2 px-2 py-1' : ''}`}
                                                ref={i === scrollIndex ? (el) => { if (el && pendingScrollTs != null) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => setPendingScrollTs(null), 1500); } } : undefined}
                                            >
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="text-xs font-semibold text-text-secondary">
                                                        {resolveSpeakerName(entry.speaker)}
                                                    </span>
                                                    <span className="text-xs text-text-tertiary font-mono">{entry.timestamp ? formatTime(entry.timestamp) : '0:00'}</span>
                                                </div>
                                                <p className="text-text-secondary text-[15px] leading-relaxed transition-colors select-text cursor-text">{entry.text}</p>
                                            </div>
                                        ));
                                    })()}
                                </div>
                            </motion.section>
                        )}

                        {activeTab === 'usage' && (
                            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-8 pb-10">
                                {meeting.usage?.map((interaction, i) => (
                                    <div key={i} className="space-y-4">
                                        {/* User Question */}
                                        {interaction.question && (
                                            <div className="flex justify-end">
                                                <div className="bg-accent-primary text-white px-5 py-2.5 rounded-2xl rounded-tr-sm max-w-[80%] text-[15px] leading-relaxed shadow-sm">
                                                    {interaction.question}
                                                </div>
                                            </div>
                                        )}

                                        {/* AI Answer */}
                                        {interaction.answer && (
                                            <div className="flex items-start gap-4">
                                                <div className="mt-1 w-6 h-6 rounded-full bg-bg-input flex items-center justify-center border border-border-subtle shrink-0">
                                                    <img src={NativelyLogo} alt="AI" className="w-4 h-4 opacity-50 object-contain force-black-icon" />
                                                </div>
                                                <div>
                                                    <div className="text-[11px] text-text-tertiary mb-1.5 font-medium">{formatTime(interaction.timestamp)}</div>
                                                    <div className="text-text-secondary text-[15px] leading-relaxed max-w-none">
                                                        <ReactMarkdown
                                                            remarkPlugins={[remarkGfm]}
                                                            components={{
                                                                h1: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                h2: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                h3: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                p: ({ node, ...props }) => <p className="text-[15px] text-text-secondary font-normal leading-relaxed mb-2 whitespace-pre-wrap" {...props} />,
                                                                ul: ({ node, ...props }) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                                                                ol: ({ node, ...props }) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                                                                li: ({ node, ...props }) => <li className="text-[15px] text-text-secondary font-normal" {...props} />,
                                                                strong: ({ node, ...props }) => <span className="font-normal text-text-secondary" {...props} />,
                                                                a: ({ node, ...props }: any) => <a className="text-blue-500 hover:underline" {...props} />,
                                                                pre: ({ children }: any) => <div className="not-prose mb-4">{children}</div>,
                                                                code: ({ node, inline, className, children, ...props }: any) => {
                                                                    const match = /language-(\w+)/.exec(className || '');
                                                                    const isInline = inline ?? false;
                                                                    const lang = match ? match[1] : '';

                                                                    return !isInline ? (
                                                                        <div className="my-3 rounded-xl overflow-hidden border border-white/[0.08] shadow-lg bg-zinc-800/60 backdrop-blur-md">
                                                                            <div className="bg-white/[0.04] px-3 py-1.5 border-b border-white/[0.08]">
                                                                                <span className="text-[10px] uppercase tracking-widest font-semibold text-white/40 font-mono">
                                                                                    {lang || 'CODE'}
                                                                                </span>
                                                                            </div>
                                                                            <div className="bg-transparent">
                                                                                <SyntaxHighlighter
                                                                                    language={mapLanguageForPrism(lang, String(children))}
                                                                                    style={vscDarkPlus}
                                                                                    customStyle={{
                                                                                        margin: 0,
                                                                                        borderRadius: 0,
                                                                                        fontSize: '13px',
                                                                                        lineHeight: '1.6',
                                                                                        background: 'transparent',
                                                                                        padding: '16px',
                                                                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                                                                                    }}
                                                                                    wrapLongLines={true}
                                                                                    showLineNumbers={true}
                                                                                    lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1.2em', color: 'rgba(255,255,255,0.2)', textAlign: 'right', fontSize: '11px' }}
                                                                                    {...props}
                                                                                >
                                                                                    {String(children).replace(/\n$/, '')}
                                                                                </SyntaxHighlighter>
                                                                            </div>
                                                                        </div>
                                                                    ) : (
                                                                        <code className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[13px] font-mono text-text-primary border border-border-subtle whitespace-pre-wrap" {...props}>
                                                                            {children}
                                                                        </code>
                                                                    );
                                                                }
                                                            }}
                                                        >
                                                            {cleanMarkdown(interaction.answer || '')}
                                                        </ReactMarkdown>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                                {!meeting.usage?.length && <p className="text-text-tertiary">No usage history.</p>}
                            </motion.section>
                        )}
                    </div>
                </motion.div>
            </main>

            {/* Floating Footer (Ask Bar) */}
            <div className={`absolute bottom-0 left-0 right-0 p-6 flex justify-center pointer-events-none ${isChatOpen ? 'z-50' : 'z-20'}`}>
                <div className="w-full max-w-[440px] relative group pointer-events-auto">
                    {/* Dark Glass Effect Input (Matching Reference) */}
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleInputKeyDown}
                        placeholder="Ask about this meeting..."
                        className="w-full pl-5 pr-12 py-3 bg-transparent backdrop-blur-[24px] backdrop-saturate-[140%] shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-white/20 rounded-full text-sm text-text-primary placeholder-text-tertiary/70 focus:outline-none transition-shadow duration-200"
                    />
                    <button
                        onClick={handleSubmitQuestion}
                        className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full transition-all duration-200 border border-white/5 ${query.trim() ? 'bg-text-primary text-bg-primary hover:scale-105' : 'bg-bg-item-active text-text-primary hover:bg-bg-item-hover'
                            }`}
                    >
                        <ArrowUp size={16} className="transform rotate-45" />
                    </button>
                </div>
            </div>

            {/* Chat Overlay */}
            <MeetingChatOverlay
                isOpen={isChatOpen}
                onClose={() => {
                    setIsChatOpen(false);
                    setQuery('');
                    setSubmittedQuery('');
                }}
                meetingContext={{
                    id: meeting.id,  // Required for RAG queries
                    title: meeting.title,
                    summary: meeting.detailedSummary?.overview,
                    keyPoints: meeting.detailedSummary?.keyPoints,
                    actionItems: meeting.detailedSummary?.actionItems,
                    transcript: meeting.transcript
                }}
                initialQuery={submittedQuery}
                onNewQuery={(newQuery) => {
                    setSubmittedQuery(newQuery);
                }}
            />
        </div>
    );
};

export default MeetingDetails;
