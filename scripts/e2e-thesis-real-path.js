// scripts/e2e-thesis-real-path.js
//
// Round-6 acceptance gate: drives the REAL document-grounded path end-to-end
// against a REAL multi-page thesis PDF and the REAL Natively API backend.
//
//   real PDF ingest (pdf-parse + [Page N] markers)
//   → real ModesManager + ModeContextRetriever (Document Map: ToC-exclusion,
//     section tree, bounded scoring, query planner)
//   → real LLMHelper.streamChat with CHAT_MODE_PROMPT
//   → model=natively → POST api.natively.software/v1/chat
//   → serverModel=gemini-3.1-flash-lite
//
// This is the harness that proved the round-6 rebuild: it caught that the model
// was only ever seeing the "3.4.1 Conversational Agent" ToC fragment, and
// confirmed the fix (0 → 15/15 critical questions on the real backend).
//
// Boots a REAL Electron app (NOT ELECTRON_RUN_AS_NODE — that has no `app`, so
// DatabaseManager.app.getPath throws) against a throwaway userData dir.
//
// Run:
//   npm run build:electron
//   RUN_NATIVELY_API_E2E=1 NATIVELY_API_KEY=<key> \
//     [E2E_MODEL=natively] [E2E_PDF="/abs/path/thesis.pdf"] \
//     ./node_modules/.bin/electron scripts/e2e-thesis-real-path.js
//
// PDF source resolution (first that exists):
//   1. $E2E_PDF
//   2. repo-root "Sample thesis for testing.pdf"
//   3. the stored content of any reference file in the live natively.db
//      (so it works even without the PDF file, using what the app ingested)
// If none resolve, the harness SKIPs cleanly (exit 0).

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist-electron', 'electron');

const KEY = process.env.NATIVELY_API_KEY || '';
const MODEL = process.env.E2E_MODEL || 'natively';
if (process.env.RUN_NATIVELY_API_E2E !== '1' || !KEY) {
  console.log('[e2e] SKIP — set RUN_NATIVELY_API_E2E=1 + NATIVELY_API_KEY to run the real-backend thesis E2E');
  process.exit(0);
}

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-thesis-e2e-'));
app.setPath('userData', tmpUserData);

const CUSTOM_PROMPT = [
  'Act as my real-time seminar presentation assistant.',
  'I have uploaded a seminar/thesis file.',
  'Answer from the uploaded seminar content first.',
  'Do not invent facts, numbers, methods, or results.',
  'If something is not in the file, say it is not directly mentioned in my seminar material.',
  'Keep answers natural, confident, student-friendly, and speakable.',
].join(' ');

// The 15 critical reproduction questions + the facts each answer must contain.
const CRITICAL = [
  { q: 'What is the main topic of my thesis?', must: [/agentic ai|vision-language-action|vla|embodied/i] },
  { q: 'What are the two research questions?', must: [/AGI/i], should: [/perception|decision/i] },
  { q: 'What is OpenVLA?', must: [/openvla/i] },
  { q: 'What is OpenVLA-OFT?', must: [/openvla-oft/i], should: [/parallel decoding|action chunk|43|finetun|fine-tun/i] },
  { q: 'How is OpenVLA-OFT different from OpenVLA?', must: [/openvla-oft/i] },
  { q: 'What is AgenticVLA?', must: [/agenticvla|agentic/i] },
  { q: 'What is the Mercury X1 robot?', must: [/mercury x1/i] },
  { q: 'How many degrees of freedom does Mercury X1 have?', must: [/19/] },
  { q: 'What sensors does Mercury X1 use?', must: [/lidar/i], should: [/ultrasonic|2d vision|vision/i] },
  { q: 'What is the role of ROS#?', must: [/ros#/i], should: [/unity|\.net|nodes|topics/i] },
  { q: 'What is the role of Unity?', must: [/unity/i] },
  { q: 'What camera setup was used for data collection?', must: [/camera|orbbec|logitech/i] },
  { q: 'What was LoRA used for?', must: [/lora|finetun|fine-tun|adapt/i] },
  { q: 'What evaluation metrics were used?', must: [/success rate|mse|mean squared/i] },
  { q: 'What are the four main phases of the project?', must: [/teleoperation|data collection|training|integration/i] },
];
const GREETING = /what would you like help with|how can i help|what can i (?:help|do)/i;
const FORBIDDEN = ['TalentScope', 'Convex', 'Stream SDK', 'Clerk', 'Next.js', 'Tailwind', 'RBAC'];

async function collect(gen) { let o = ''; for await (const t of gen) o += t; return o; }

async function ingestPdfText(pdfPath) {
  // Same ingest the IPC handler uses: pdf-parse@2.x pages → [Page N] markers.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
  if (pdfjsLib) {
    try {
      const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = require('node:url').pathToFileURL(workerPath).href;
    } catch { /* best effort */ }
  }
  const { PDFParse } = require('pdf-parse');
  const data = await new PDFParse({ data: fs.readFileSync(pdfPath) }).getText();
  if (Array.isArray(data.pages) && data.pages.length > 0) {
    return data.pages.map((p) => `[Page ${p.num}]\n${typeof p.text === 'string' ? p.text : ''}`).join('\n\n');
  }
  return data.text || '';
}

function resolveContent() {
  const envPdf = process.env.E2E_PDF;
  const repoPdf = path.join(repoRoot, 'Sample thesis for testing.pdf');
  if (envPdf && fs.existsSync(envPdf)) return { kind: 'pdf', src: envPdf };
  if (fs.existsSync(repoPdf)) return { kind: 'pdf', src: repoPdf };
  // Fall back to whatever a reference file already in the live DB holds.
  const liveDb = path.join(os.homedir(), 'Library/Application Support/natively/natively.db');
  if (fs.existsSync(liveDb)) {
    try {
      const Database = require(path.join(repoRoot, 'node_modules', 'better-sqlite3'));
      const db = new Database(liveDb, { readonly: true });
      const row = db.prepare("SELECT content FROM mode_reference_files WHERE content LIKE '%OpenVLA%' ORDER BY length(content) DESC LIMIT 1").get();
      db.close();
      if (row && row.content) return { kind: 'stored', src: row.content };
    } catch { /* no live DB content */ }
  }
  return null;
}

async function main() {
  await app.whenReady();

  const found = resolveContent();
  if (!found) {
    console.log('[e2e] SKIP — no thesis PDF (set E2E_PDF, or place "Sample thesis for testing.pdf" at repo root) and no stored thesis content in the live DB');
    process.exit(0);
  }
  const content = found.kind === 'pdf' ? await ingestPdfText(found.src) : found.src;
  console.log(`[e2e] source=${found.kind} contentChars=${content.length} pageMarkers=${(content.match(/\[Page \d+\]/g) || []).length}`);

  const { ModesManager } = require(path.join(distRoot, 'services/ModesManager.js'));
  const llmMod = require(path.join(distRoot, 'LLMHelper.js'));
  const LLMHelper = llmMod.LLMHelper || llmMod.default;
  const { CHAT_MODE_PROMPT } = require(path.join(distRoot, 'llm/prompts.js'));

  const mm = ModesManager.getInstance();
  for (const m of mm.getModes()) if (/thesis|seminar/i.test(m.name)) { try { mm.deleteMode(m.id); } catch { /* ignore */ } }
  const mode = mm.createMode({ name: 'Thesis E2E', templateType: 'general' });
  mm.updateMode(mode.id, { customContext: CUSTOM_PROMPT });
  mm.addReferenceFile({ modeId: mode.id, fileName: 'thesis.pdf', content });
  mm.setActiveMode(mode.id);
  if (mm.getActiveModeDocumentGroundingInfo().documentGroundedCustomModeActive !== true) {
    console.error('[e2e] FATAL: documentGroundedCustomModeActive is not true');
    process.exit(1);
  }

  const llm = new LLMHelper();
  llm.setNativelyKey(KEY);
  llm.setModel(MODEL);

  let pass = 0, fail = 0;
  const serverModels = new Set();
  const latencies = [];
  for (const c of CRITICAL) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 30000);
    const start = Date.now();
    let ans = '';
    try {
      // Pass NO context — streamChat retrieves internally via the active mode,
      // exactly like the real gemini-chat-stream handler.
      ans = await collect(llm.streamChat(c.q, undefined, undefined, CHAT_MODE_PROMPT, false, false, [], ctl.signal, undefined, { answerType: 'lecture_answer' }));
    } catch { ans = ''; } finally { clearTimeout(to); }
    latencies.push(Date.now() - start);
    const t = ans.trim();
    const sm = llm.getLastProviderModel && llm.getLastProviderModel();
    if (sm) serverModels.add(sm);
    const probs = [];
    if (GREETING.test(t)) probs.push('GREETING');
    if (t.length < 8) probs.push('EMPTY');
    for (const d of FORBIDDEN) if (t.toLowerCase().includes(d.toLowerCase())) probs.push('DRIFT:' + d);
    const miss = c.must.filter((re) => !re.test(t));
    if (miss.length) probs.push('MISS:' + miss.map(String).join(','));
    if (probs.length === 0) { pass++; console.log(`PASS  ${c.q}  [${sm}]`); }
    else { fail++; console.log(`FAIL  ${c.q}  [${sm}] :: ${probs.join(';')}`); console.log(`      → ${t.slice(0, 160).replace(/\n/g, ' ')}`); }
  }
  latencies.sort((a, b) => a - b);
  console.log(`\n[e2e] ${pass}/${pass + fail} critical (model=${MODEL}, serverModels=${[...serverModels].join(',')})`);
  console.log(`[e2e] latency median=${latencies[Math.floor(latencies.length / 2)]}ms p95=${latencies[Math.floor(latencies.length * 0.95)] || latencies[latencies.length - 1]}ms`);

  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[e2e] FATAL', e);
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(2);
});
