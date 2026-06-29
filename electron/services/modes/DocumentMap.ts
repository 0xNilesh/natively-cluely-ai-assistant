// electron/services/modes/DocumentMap.ts
//
// Document Map for document-grounded custom modes (round-6 rebuild, 2026-06-29).
//
// WHY THIS EXISTS
// ---------------
// Rounds 2-5 patched the model/prompt layer. Round 6 proved (on the real
// 66-page thesis PDF + the live DB) that ingestion is fine — the full 128 KB of
// text with [Page N] markers and every entity is stored — but RETRIEVAL is
// broken. The old chunker's heading regex
//     /^\s*(?:#{1,3}\s+|(?:\d+(?:\.\d+){0,2}\s+))/
// matched Table-of-Contents dotted-leader lines like
//     "3.4.1 Conversational Agent . . . . . . . . . 38"
// as if they were real section headings, fragmenting the ToC into dozens of
// tiny heading-only chunks. Those (plus a generic "response guidelines" chunk)
// won retrieval for almost every question, so the model only ever saw
// "3.4.1 Conversational Agent" and answered "not in the material" for facts
// that are plainly present.
//
// This module builds a real Document Map from the STORED content (no re-upload):
//   - parses and EXCLUDES the Table of Contents
//   - detects REAL section headings (chapter-numbered, not ToC lines, not table
//     rows, not bibliography entries) and their page ranges
//   - produces a section tree: { num, title, pageStart, pageEnd, body }
//   - exposes a flat section list the retriever chunks/indexes over
//
// Validated on the real thesis: ~51 clean sections, 51 ToC lines removed, every
// key section (2.1.2 OpenVLA-OFT p13, 2.3.2 Technical Specifications p17,
// 2.4.2 ROS# p20, 1.1 Research Questions p8, 4.1 Evaluation metrics p44)
// resolves to its correct body.
//
// Code-review hardening (2026-06-29): the "N.N Title <page>" ToC rule is scoped
// to the detected ToC region only (it false-positived on real prose ending in a
// number); the chapter-number cap was raised from 12 to 40 (it silently dropped
// chapters 13+); a bibliography guard rejects "12 Smith et al 2021 …"; sections
// carry pageStart/pageEnd (single-page-of-heading mis-cited multi-page sections).

export interface DocumentSection {
    /** Section number as written, e.g. "2.1.2" or "" for the preamble. */
    num: string;
    /** Full heading line as written, e.g. "2.1.2 OpenVLA-OFT". */
    heading: string;
    /** 1-based page the heading appears on. */
    pageStart: number;
    /** 1-based last page the section body spans. */
    pageEnd: number;
    /** Body text of the section (whitespace-normalised, ToC + heading excluded). */
    body: string;
    /** Depth from the section number (1 = chapter, 2 = section, 3 = subsection). */
    depth: number;
}

export interface DocumentMap {
    sections: DocumentSection[];
    /** Total [Page N] markers seen — the real page count. */
    pageCount: number;
    /** Number of ToC lines excluded from the corpus. */
    tocLinesRemoved: number;
    /** True if a recognisable Table of Contents was detected and excluded AND
     *  enough real sections were found to chunk by section. */
    hasToc: boolean;
}

const PAGE_MARKER_RE = /^\s*\[Page\s+(\d+)\]\s*$/;
const DOTTED_LEADER_RE = /\.\s?\.\s?\.\s?\./; // ". . . ." navigation leaders
// "N.N Title <pageNumber>" — only treated as ToC INSIDE the detected ToC region.
const TOC_ENTRY_RE = /^\d+(?:\.\d+){0,3}\s+[A-Z].{0,70}?\s+\d{1,3}$/;
// A real section heading: chapter-numbered, Title-cased, no trailing punctuation.
const HEADING_RE = /^(\d+(?:\.\d+){0,3})\s+([A-Z][A-Za-z].{1,68})$/;
// Bibliography / author-year line guard: "12 Smith et al 2021 Robotics", "5 J.
// Doe, A. Roe. 2019". Reject lines whose title looks like authors + a 19xx/20xx
// year, which a numbered bibliography emits and which would otherwise parse as a
// chapter heading.
const BIBLIO_RE = /\b(19|20)\d{2}\b|\bet al\b|\b[A-Z]\.\s?[A-Z]?\.?\s+[A-Z][a-z]+/;

function hasDottedLeader(line: string): boolean {
    return DOTTED_LEADER_RE.test(line);
}

// Within the ToC region, a "N.N Title <page>" line is navigation.
function isTocEntryLine(line: string): boolean {
    const t = line.trim();
    return TOC_ENTRY_RE.test(t);
}

function parseHeading(line: string): { num: string; title: string } | null {
    const t = line.trim();
    if (!t) return null;
    if (hasDottedLeader(t)) return null;
    const m = t.match(HEADING_RE);
    if (!m) return null;
    if (/[.:;,]$/.test(t)) return null;            // headings don't end in punctuation
    const firstNum = parseInt(m[1].split('.')[0], 10);
    if (firstNum < 1 || firstNum > 40) return null; // chapters 1-40; excludes data rows like "<bignum> pose"
    if (/[[\]]|\bmm\b|\brx\b|pose/i.test(t)) return null; // table/data rows
    if (BIBLIO_RE.test(t)) return null;            // numbered bibliography entries
    return { num: m[1], title: m[2].trim() };
}

/**
 * Identify the [startLine, endLine] span of the Table of Contents: the region
 * between the first and last dotted-leader line, when there are enough of them
 * to constitute a real ToC. Returns null when there's no ToC. This scopes the
 * looser "N.N Title <page>" exclusion so it cannot drop real content lines that
 * merely end in a number elsewhere in the document.
 */
function detectTocRegion(lines: string[]): { start: number; end: number; count: number } | null {
    let first = -1;
    let last = -1;
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        if (hasDottedLeader(lines[i])) {
            if (first === -1) first = i;
            last = i;
            count++;
        }
    }
    if (count < 5) return null; // a real ToC is many dotted lines; <5 is incidental
    return { start: first, end: last, count };
}

/**
 * Build a Document Map from stored reference-file content. Pure + deterministic.
 * Works on PDF content that carries [Page N] markers (the v18→v19 ingest format)
 * and degrades gracefully on plain text without markers.
 */
export function buildDocumentMap(content: string): DocumentMap {
    const lines = content.split('\n');
    const toc = detectTocRegion(lines);
    const tocStart = toc ? toc.start : -1;
    const tocEnd = toc ? toc.end : -1;

    const sections: DocumentSection[] = [];
    let current: { num: string; heading: string; pageStart: number; pageEnd: number; body: string[] } = {
        num: '', heading: '', pageStart: 1, pageEnd: 1, body: [],
    };
    let curPage = 1;
    let maxPage = 1;
    let tocLinesRemoved = 0;

    const flush = () => {
        const body = current.body.join('\n').replace(/\s+/g, ' ').trim();
        if (body || current.heading) {
            sections.push({
                num: current.num,
                heading: current.heading || 'Preamble',
                pageStart: current.pageStart,
                pageEnd: Math.max(current.pageStart, current.pageEnd),
                body,
                depth: current.num ? current.num.split('.').length : 0,
            });
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const pm = line.match(PAGE_MARKER_RE);
        if (pm) {
            curPage = parseInt(pm[1], 10);
            if (curPage > maxPage) maxPage = curPage;
            current.pageEnd = curPage; // section spans up to the latest page seen
            continue;
        }
        const inToc = tocStart !== -1 && i >= tocStart && i <= tocEnd;
        // ToC lines (dotted leaders anywhere; "N.N Title <page>" only inside the
        // ToC region) are navigation, not content.
        if (hasDottedLeader(line) || (inToc && isTocEntryLine(line))) {
            tocLinesRemoved++;
            continue;
        }
        const h = parseHeading(line);
        if (h) {
            flush();
            current = { num: h.num, heading: line.trim(), pageStart: curPage, pageEnd: curPage, body: [] };
        } else {
            current.body.push(line);
        }
    }
    flush();

    // hasToc gates section-based chunking: require a real ToC AND enough real
    // numbered sections, else a flat-prose doc with a few incidental dotted
    // lines would wrongly trigger section-chunking with one giant section.
    const numberedSections = sections.filter(s => s.num).length;
    const hasToc = tocLinesRemoved >= 5 && numberedSections >= 3;

    return { sections, pageCount: maxPage, tocLinesRemoved, hasToc };
}

/**
 * Resolve a query to the section numbers it most likely targets, using the
 * section TITLES from the document map (not a hardcoded synonym table). Returns
 * section numbers ordered best-first. ADVISORY ONLY — the caller must treat
 * these as a boost/preference, never a hard filter (a query whose entity is not
 * a title word would otherwise lose recall). Empty when nothing matches
 * confidently; the caller then falls back to global retrieval.
 */
export function resolveTargetSections(query: string, map: DocumentMap): string[] {
    const q = query.toLowerCase();
    const qWords = new Set(
        q.replace(/[^a-z0-9#-]+/g, ' ').split(/\s+/).filter(w => w.length > 2),
    );
    if (qWords.size === 0) return [];

    const scored: Array<{ num: string; score: number }> = [];
    for (const s of map.sections) {
        if (!s.num) continue;
        const titleLower = s.heading.toLowerCase();
        const titleWords = titleLower
            .replace(/^\d+(?:\.\d+)*\s+/, '')
            .replace(/[^a-z0-9#-]+/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2);
        if (titleWords.length === 0) continue;
        let hits = 0;
        for (const tw of titleWords) if (qWords.has(tw)) hits++;
        // Exact verbatim title-token match in the query (handles "ROS#", hyphens).
        for (const tw of titleWords) {
            if (tw.length >= 3 && q.includes(tw)) hits += 0.5;
        }
        if (hits > 0) {
            // Normalise by title length so a 1-word title match isn't swamped by
            // a long title that happens to share a common word.
            scored.push({ num: s.num, score: hits / Math.sqrt(titleWords.length) });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    // A STRONG title match (≥1.0 — the query contains the section title's
    // distinctive word verbatim, e.g. "ROS#", "OpenVLA-OFT", "Unity",
    // "Evaluation metrics") is high-confidence; return it directly. A weak
    // title match (0.5–1.0, e.g. a query sharing a common word like "data" with
    // several section titles) does NOT block the content fallback below, which
    // finds the section whose BODY actually discusses the asked-about thing.
    const strongTitleTargets = scored.filter(s => s.score >= 1.0).slice(0, 4).map(s => s.num);
    if (strongTitleTargets.length > 0) return strongTitleTargets;

    // CONTENT FALLBACK (round-6 Stage 3b). When no section TITLE matches the
    // query (e.g. "What camera setup was used?" — the answer lives in
    // "3.1.1 Robotic Hardware and Software configuration", whose title has no
    // "camera"), score section BODIES for the query's content terms and target
    // the best-matching section. Common words ("what", "data", "used") appear
    // in most sections and would drown the signal word ("camera"), so we weight
    // each query word by its INVERSE SECTION FREQUENCY — a word that appears in
    // few sections is discriminative and scores high; a word in many sections
    // barely counts. No document-specific terms are hardcoded.
    const STOPWORDS = new Set([
        'what', 'which', 'where', 'when', 'how', 'why', 'who', 'whom',
        'used', 'use', 'using', 'uses', 'was', 'were', 'are', 'is', 'the',
        'for', 'and', 'with', 'this', 'that', 'these', 'those', 'does', 'did',
        'has', 'have', 'had', 'can', 'could', 'would', 'should', 'about',
        'role', 'main', 'project', 'thesis', 'paper', 'work', 'study',
    ]);
    const contentWords = [...qWords].filter(w => w.length >= 4 && !STOPWORDS.has(w));
    if (contentWords.length === 0) return [];
    const sectionsWithBody = map.sections.filter(s => s.num && s.body);
    if (sectionsWithBody.length === 0) return [];
    // Section frequency per content word.
    const sf = new Map<string, number>();
    for (const w of contentWords) {
        let n = 0;
        for (const s of sectionsWithBody) if (s.body.toLowerCase().includes(w)) n++;
        sf.set(w, n);
    }
    const total = sectionsWithBody.length;
    // The most DISCRIMINATIVE content word (rarest across sections). The target
    // section MUST contain it — this prevents a section that merely shares
    // generic words from winning. e.g. for "What was LoRA used for?" the only
    // content word is "lora", so the target must literally contain "lora".
    const rarest = [...contentWords].sort((a, b) => (sf.get(a) || total) - (sf.get(b) || total))[0];
    const bodyScored: Array<{ num: string; score: number }> = [];
    for (const s of sectionsWithBody) {
        const bodyLower = s.body.toLowerCase();
        if (!bodyLower.includes(rarest)) continue; // must contain the signal word
        let score = 0;
        for (const w of contentWords) {
            if (!bodyLower.includes(w)) continue;
            const freq = sf.get(w) || total;
            // Inverse section frequency: rare words (low freq) → high weight.
            score += Math.log((total + 1) / (freq + 1));
        }
        if (score > 0) bodyScored.push({ num: s.num, score });
    }
    bodyScored.sort((a, b) => b.score - a.score);
    if (bodyScored.length === 0) return [];
    const top = bodyScored[0].score;
    return bodyScored.filter(s => s.score >= top * 0.8).slice(0, 3).map(s => s.num);
}
