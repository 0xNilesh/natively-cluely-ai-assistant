// Live smoke for document-grounded custom mode.
// Calls the real Gemini endpoint directly with the request shape the
// LLMHelper streamChat bundle would build, using the SAME prompt
// ordering (pinned instructions → retrieved context → user question) and
// the SAME fail-closed policy when the GPU is not in the uploaded file.
//
// We bypass LLMHelper's DB constructor (better-sqlite3 native binding
// mismatch on Node 25) and drive the provider directly so we observe
// real model behaviour against the seminar-mode rules.

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const GROQ_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_7,
  process.env.GROQ_API_KEY_8,
  process.env.GROQ_API_KEY_9,
  process.env.GROQ_API_KEY_10,
].filter(Boolean);

const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_5,
  process.env.GEMINI_API_KEY_6,
].filter(Boolean);

if (GROQ_KEYS.length === 0 && GEMINI_KEYS.length === 0) {
  console.error('[smoke] no Gemini or Groq keys found in .env');
  process.exit(2);
}

// Round-robin across keys on 429/quota so a single exhausted key does not
// sink the whole smoke run.
let groqCursor = 0;
let geminiCursor = 0;
function pickGroqKey() { const k = GROQ_KEYS[groqCursor % GROQ_KEYS.length]; groqCursor++; return k; }
function pickGeminiKey() { const k = GEMINI_KEYS[geminiCursor % GEMINI_KEYS.length]; geminiCursor++; return k; }

const SEMINAR_FIXTURE = `Title: Towards Connected Intelligence: Empowering Robotic Applications with Agentic AI Frameworks.
Abstract: Agentic AI frameworks integrated with Vision-Language-Action models for embodied robotic systems, specifically the AgenticVLA system deployed on the Mercury X1 humanoid robot.
The AgenticVLA pipeline uses OpenVLA-OFT finetuned with LoRA adapters and orchestrated by AutoGen.
Mercury X1 has 19 degrees of freedom. Sensors include LiDAR, ultrasonic sensors, and 2D vision.
ROS# bridges Unity and ROS. Unity hosts the VR teleoperation environment with Meta Quest 3 XR visualization.
The project has four main phases: teleoperation, data collection, training the VLA, and Agentic AI integration.
The benchmark Success Rate for AgenticVLA on semantic relationship understanding is 44 percent versus 0 percent for standard VLA; on prompt complexity 84 percent versus 42 percent for finetuned OpenVLA-OFT; on self-awareness 85 percent versus 43 percent.`;

const SYSTEM_PROMPT = [
  'You are a Seminar Presentation Assistant.',
  'The uploaded seminar file is the source of truth.',
  'Answer from uploaded seminar content first and avoid hallucinated details.',
  'Answer strictly based on the seminar file.',
  'If the answer is not in the uploaded file, say: This is not directly mentioned in my seminar material, but based on the topic, the likely explanation is...',
].join(' ');

function buildPrompt(question, retrievedBlock) {
  return [
    '## ACTIVE MODE INSTRUCTIONS (user-configured)',
    SYSTEM_PROMPT,
    '',
    '## UPLOADED REFERENCE FILES',
    '<uploaded_seminar_material>',
    SEMINAR_FIXTURE,
    '</uploaded_seminar_material>',
    '',
    retrievedBlock || '(retrieved blocks omitted)',
    '',
    '## USER QUESTION',
    question,
  ].join('\n');
}

async function callGroq(model, systemText, userText, { signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < GROQ_KEYS.length; attempt++) {
    const key = pickGroqKey();
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
          ],
          temperature: 0.2,
          max_tokens: 512,
        }),
        signal,
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content || '';
        return { text, model, provider: 'groq' };
      }
      const errText = await res.text().catch(() => '');
      lastErr = new Error(`HTTP ${res.status} ${errText.slice(0, 160)}`);
      if (res.status !== 429 && res.status !== 401) throw lastErr;
      console.warn(`[smoke] groq key exhausted (HTTP ${res.status}); rotating`);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      if (!/HTTP (?:429|401)/.test(err?.message || '')) throw err;
    }
  }
  throw lastErr || new Error('all Groq keys exhausted');
}

async function callGemini(model, systemText, userText, { signal } = {}) {
  if (GEMINI_KEYS.length === 0) throw new Error('no Gemini keys configured');
  let lastErr;
  for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
    const key = pickGeminiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          systemInstruction: { parts: [{ text: systemText }] },
          generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
        }),
        signal,
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('') || '';
        return { text, model, provider: 'gemini' };
      }
      const errText = await res.text().catch(() => '');
      lastErr = new Error(`HTTP ${res.status} ${errText.slice(0, 160)}`);
      if (res.status !== 429 && res.status !== 401) throw lastErr;
      console.warn(`[smoke] gemini key exhausted (HTTP ${res.status}); rotating`);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      if (!/HTTP (?:429|401)/.test(err?.message || '')) throw err;
    }
  }
  throw lastErr || new Error('all Gemini keys exhausted');
}

async function callProvider(groqModel, geminiModel, systemText, userText, signal) {
  // Try Gemini first (matches the user's primary stack), fall back to Groq.
  if (GEMINI_KEYS.length > 0) {
    try {
      return await callGemini(geminiModel, systemText, userText, { signal });
    } catch (err) {
      console.warn(`[smoke] gemini path failed (${err?.message?.slice(0, 120)}); falling back to groq`);
      if (GROQ_KEYS.length === 0) throw err;
    }
  }
  if (GROQ_KEYS.length > 0) return callGroq(groqModel, systemText, userText, { signal });
  throw new Error('no provider available');
}

function logAnswer(label, question, expectedHint, answer) {
  const text = (answer || '').trim();
  const tokens = text.split(/\s+/).filter(Boolean).length;
  console.log(`\n[smoke] ${label}`);
  console.log(`  Q: ${question}`);
  console.log(`  expected: ${expectedHint}`);
  console.log(`  answer (${tokens} words):`);
  console.log(`    ${text.slice(0, 320).replace(/\n/g, ' / ')}${text.length > 320 ? ' …' : ''}`);
}

async function liveCheck(label, question, retrievedBlock, expected, model, geminiModel) {
  const userText = buildPrompt(question, retrievedBlock);
  const start = Date.now();
  try {
    const { text, provider, model: usedModel } = await callProvider(model, geminiModel, SYSTEM_PROMPT, userText);
    const latency = Date.now() - start;
    logAnswer(label, question, expected, text);
    console.log(`  latency: ${latency}ms (provider=${provider}, model=${usedModel})`);
    return { text, latency };
  } catch (err) {
    console.error(`[smoke] ${label} failed:`, err?.message || err);
    return { text: '', latency: Date.now() - start };
  }
}

async function main() {
  const model = process.env.SMOKE_GROQ_MODEL || 'llama-3.3-70b-versatile';
  const geminiModel = process.env.SMOKE_GEMINI_MODEL || 'gemini-2.0-flash';

  const checks = [
    {
      label: 'main topic — should answer from seminar',
      question: 'What is the main topic of my thesis?',
      retrieved: null,
      expectMentions: ['Agentic AI', 'Vision-Language-Action', 'embodied robotic systems'],
      expectAbsent: ['TalentScope', 'real-time technical interview platform'],
    },
    {
      label: 'Mercury X1 specs — 19 DOF',
      question: 'How many degrees of freedom does Mercury X1 have?',
      retrieved: null,
      expectMentions: ['19', 'degrees of freedom', 'Mercury X1'],
      expectAbsent: ['TalentScope'],
    },
    {
      label: 'ROS# role',
      question: 'What is the role of ROS# in the project?',
      retrieved: null,
      expectMentions: ['ROS#', 'Unity', 'ROS'],
      expectAbsent: [],
    },
    {
      label: 'no coding scaffold leak',
      question: 'What problem is this thesis trying to solve?',
      retrieved: null,
      expectMentions: ['embodied', 'robot', 'Agentic AI', 'framework'],
      expectAbsent: ['## Approach', '## Code', '## Dry Run', '## Complexity'],
    },
    {
      label: 'profile contamination guard',
      question: 'What are the four main phases of the project?',
      retrieved: null,
      expectMentions: ['teleoperation', 'data collection', 'training', 'Agentic AI'],
      expectAbsent: ['TalentScope', 'real-time technical interview platform', 'Next.js', 'Tailwind'],
    },
    {
      label: 'fail-closed on GPU',
      question: 'What exact GPU was used for training?',
      retrieved: null,
      expectMentions: ['not directly mentioned', 'seminar material'],
      expectAbsent: ['NVIDIA', 'A100', 'H100', 'T4'],
    },
  ];

  let pass = 0, fail = 0;
  for (const c of checks) {
    const { text } = await liveCheck(c.label, c.question, c.retrieved, c.expectMentions.join(', '), model, geminiModel);
    const lower = text.toLowerCase();
    const missMentions = c.expectMentions.filter((m) => !lower.includes(m.toLowerCase()));
    const leakAbsents = c.expectAbsent.filter((m) => lower.includes(m.toLowerCase()));
    const ok = missMentions.length === 0 && leakAbsents.length === 0;
    if (ok) { pass++; console.log(`  PASS`); }
    else {
      fail++;
      console.log(`  FAIL — missing: ${missMentions.join(', ') || '∅'} ; leaked: ${leakAbsents.join(', ') || '∅'}`);
    }
  }
  console.log(`\n[smoke] ${pass}/${pass + fail} live checks passed (groq=${model}, gemini=${geminiModel})`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] fatal:', err);
  process.exit(2);
});
