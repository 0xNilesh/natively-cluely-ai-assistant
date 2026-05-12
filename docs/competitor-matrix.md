# Competitor Intelligence Matrix — Live Interview / Meeting AI Copilots

**Date:** May 2026
**Targets:** Cluely, Final Round AI, LockedIn AI, Verve AI, Linkjob AI, Interview Solver, Parakeet AI (+ short notes on Sensei, Interview Coder, InterviewPal, InterviewBee, others).
**Method:** Web search + public-source review. Every numerical or technical claim has a cited URL. Marked **(unverified)** when no source supports it.

---

## At-a-glance matrix

| Vendor | Pricing (monthly USD) | TTFT claim | TTFT measured | STT | LLM | Stealth mechanism | Hotkey UX | Known issues |
|---|---|---|---|---|---|---|---|---|
| **Cluely** | $20 Pro / Free Starter | "instant" | **5–90 s** journalists | unverified (multi: Whisper/Groq/EL/Google/Deepgram per teardowns) | GPT-4.1 + Claude 3.7 Sonnet fallback (leaked) | Hidden Electron transparent overlay (compositor-level) | CMD/CTRL+Enter | **83k-user breach**, ARR fraud, prompt leaked, Truely detector |
| **Final Round AI** | $148 / $96 (Q) / $81 (sa) | "real-time" | freezes mid-interview (Trustpilot) | unverified | unverified ("newest models") | App-window-exclusion (weaker) | Auto-fire | Auto-renew billing scandals, no refunds, 40% neg Trustpilot |
| **LockedIn AI** | $54.99 / $29.99 (Q); free 10 min/day | **116 ms** marketing | 2–4 s reviewers; voice-capture fails | unverified | GPT-4o, Gemini 2.0/2.5, Claude 3.5 (user-pick) | Native desktop overlay (API not named) | `Cmd/Ctrl+Alt+L` send; `Cmd/Ctrl+Alt+K` add-context | HackerRank detected; mediocre Trustpilot |
| **Verve AI** | $59.50 Pro / $38.25 Standard | none published | "low latency"; reviewer "lag" complaints | unverified | unverified | Native overlay + Camouflage Mode + **click-through `Cmd+Shift+P`** | Cmd+Shift+S area shot, F1–F4 steering | Web/extension build NOT stealth |
| **Linkjob AI** | $99.99 / $69.99 (Q) / $29.99 (Y) / $699.99 lifetime | "<1 s" | no independent test | unverified | tier-gated (Haiku/4o-mini→Opus/GPT-5.1) | "100% invisible" claim, API unverified | per-tier hotkey | thin independent reviews |
| **Interview Solver** | $39 / $30 (Q) | none | "delays" / "frozen" | unverified | unverified | Hotkey-toggled manual hide; works on Zoom ≤6.16 | **Ctrl+Esc push-to-answer** | no auto-fire; macOS compat issues |
| **Parakeet AI** | ~$74.90 credit-based | "extremely low" | reviewers: **slow + freezes** | claimed NVIDIA Parakeet (name collision) | GPT-5, GPT-4.1, Claude 4 Sonnet | Window-filter trick; **process visible as `pmodule`** | Mouse-only, no hotkeys | **Named-targeted by Talview/Honorlock/Polygraf**, cursor-trace fingerprint |

---

## Cluely

### Latency
- **Marketing:** instant. `CMD/CTRL+Enter` "Assist" with no published TTFT ([docs.cluely.com/changelog](https://docs.cluely.com/changelog)).
- **Journalists measured 5–10 s; Victoria Song at The Verge measured up to 90 s** plus audio glitches ([Wikipedia/BI/Verge](https://en.wikipedia.org/wiki/Cluely), [tldv review](https://tldv.io/blog/cluely-review/)). BI also documented hallucinated skills not on the reporter's LinkedIn.

### STT
- Multi-provider per teardowns: Whisper, Groq, ElevenLabs, Google, Deepgram ([market.dev profile](https://explore.market.dev/ecosystems/openai/projects/pluely)). Specific routing **unverified**.

### LLM stack
- Reverse-engineered by Jack Cable: **GPT-4.1 in most cases, Claude 3.7 Sonnet fallback** ([@jackhcable](https://x.com/jackhcable/status/1936500982994928059)). Secondary writeups reference **GPT-4o mini and Claude 4 Sonnet** ([aixploria](https://www.aixploria.com/en/cluely-ai-undetectable/)).
- Leaked system prompt: <https://gist.github.com/cablej/ccfe7fe097d8bbb05519bacfeb910038> and <https://gist.github.com/martinbowling/ba029b603b333204bef1ec01d28f7186>.
- Cluely sent DMCA takedowns instead of patching ([Medium nullwalker](https://medium.com/@nullwalker/how-cheating-app-cluely-got-hacked-leaking-83-000-users-data-9ac572ff3d00)).

### Stealth
- Hidden Electron transparent overlay with always-on-top + frame-removal + taskbar-hide. Excluded from screen-capture pipelines via compositor-level flags — same primitive Zoom itself uses ([shadecoder breakdown](https://www.shadecoder.com/blogs/zoom-cannot-detect-cluely-here-s-why-technical-breakdown-risks), [Cluely docs](https://docs.cluely.com/feature/undectability)).
- **Detection counter-tooling:** Columbia students built **Truely "Demon Mirror"** — interviewer sends app to candidate which enumerates PIDs for Cluely ([QQ Insights](https://qqinsights.com/just-developed-an-ai-cheat-detector-to-counter-columbias-cheating-ai-tool-the-columbia-student-creates-an-ai-demon-mirror/)). Behavioral detection: 3–5 s pauses regardless of question difficulty ([Fabric](https://fabrichq.ai/blogs/how-to-detect-cluely-in-interviews)). Talview markets explicit Cluely detection ([Talview](https://www.talview.com/en/stop-cluely-cheating)).

### Pricing
- **Free Starter** (basic, daily cap)
- **Pro $20/mo** unlimited
- **Enterprise** custom ([Cluely pricing](https://cluely.com/pricing), [eesel](https://www.eesel.ai/blog/cluely-pricing))

### Bugs / breaches / scandals
- **2025 breach: 83k users — full meeting transcripts and screen captures exfiltrated.** Cause: admin password in a public GitHub repo + weak GraphQL + client-side paywall. Response: DMCA takedowns, not patches ([Medium nullwalker](https://medium.com/@nullwalker/how-cheating-app-cluely-got-hacked-leaking-83-000-users-data-9ac572ff3d00), [Scoble](https://x.com/Scobleizer/status/1937022680932462723)).
- **ARR fraud admission March 5 2026:** Roy Lee admitted the July 2025 $7M ARR figure was inflated. Real ARR ~$5.2M (35% gap). Methods: annualised best single month, counted unsigned pipeline, booked 12-month ARR on day 1 ([TechCrunch admission](https://techcrunch.com/2026/03/05/cluely-ceo-roy-lee-admits-to-publicly-lying-about-revenue-numbers-last-year/), [Inc.](https://www.inc.com/leila-sheridan/an-a16z-backed-startup-that-helps-people-cheat-on-job-interviews-just-got-caught-in-a-7-million-lie-the-ceo-was-sweating/91313070)).
- Verge: "painfully awkward"; BI: hallucinated skills, 5–10 s lag; Frank on Fraud: normalises deception ([Frank on Fraud](https://frankonfraud.com/the-cheating-boom-inside-cluelys-bid-to-normalize-deception/)).

### UI patterns
- Push-to-answer via CMD/CTRL+Enter (customisable since late 2025).
- Leaked system prompt structure: direct answer first → headline ≤6 words → 1–2 bullets ≤15 words each. No markdown headers, bold for emphasis, dashes for bullets, backticks for code.
- Streaming line-by-line. No documented STAR/behavioral branching at the prompt level.

### Funding
- Seed $5.3M Apr 2025 (Abstract + Susa) ([TechCrunch](https://techcrunch.com/2025/04/21/columbia-student-suspended-over-interview-cheating-tool-raises-5-3m-to-cheat-on-everything/))
- Series A $15M Jun 2025 (a16z lead), ~$120M post-money ([TechCrunch](https://techcrunch.com/2025/06/20/cluely-a-startup-that-helps-cheat-on-everything-raises-15m-from-a16z/), [a16z](https://a16z.com/announcement/investing-in-cluely/))
- ARR claims discounted heavily after admission.

---

## Final Round AI

### Latency
- One third-party comparison cites **350 ms+** ([Verve comparison](https://www.vervecopilot.com/blog/verve-ai-final-round-ai-pricing-comparison)) — **low-quality source, unverified**.
- Trustpilot: **live copilot freezes mid-interview** ([Trustpilot](https://www.trustpilot.com/review/finalroundai.com), [raina](https://rainaiservices.com/reviews/final-round-ai/)). Linkjob: "slow to generate or scroll too quickly" ([Linkjob](https://www.linkjob.ai/hub/final-round-ai-review/)).

### STT
**Unverified.** No public disclosure or teardown. Marketing claims platform compatibility but not backend.

### LLM stack
**Unverified.** Generic "newest AI models." No model named by independent source.

### Stealth
- Marketed as **Stealth Mode** — separate native desktop window omitted from the user's window selection during share ([download](https://www.finalroundai.com/download), [interview-copilot](https://www.finalroundai.com/interview-copilot)).
- **Application-window exclusion only — weaker than Cluely's compositor-level overlay.**
- Multiple Trustpilot reviewers report Stealth Mode **appearing in screen shares** ([Verve roundup](https://www.vervecopilot.com/blog/most-undetectable-interview-copilot), [Trustpilot](https://www.trustpilot.com/review/finalroundai.com)).

### Pricing
- Essential **$148/mo** monthly
- Pro **$96/mo** quarterly
- God Mode **$81/mo** semi-annual ([subscription](https://www.finalroundai.com/subscription))
- **No free trial. No refund** per multiple Trustpilot reviews. **Auto-renew $249–$488 surprise charges** ([rainaiservices](https://rainaiservices.com/reviews/final-round-ai/), [skywork](https://skywork.ai/skypage/en/Final-Round-AI-In-Depth-Review-(2025):-My-Hands-On-Test-of-the-AI-Interview-Copilot/1974875358924304384))

### Bugs / complaints
- Trustpilot 3.9; **40% negative, 17% 1-star, 18% used "scam" or "fraud"** ([rainaiservices](https://rainaiservices.com/reviews/final-round-ai/))
- Auto-renewal billing surprises, 3-day refund window impossible to invoke, mid-interview freezes, unresponsive support
- **No publicly disclosed data breach** found

### UI patterns
- "Runs quietly in the background like a digital sticky note" → auto-fire on detected question ([Sensei review](https://www.senseicopilot.com/blog/finalround-ai-review))
- **STAR-method scaffolding** (Situation, Task, Action, Result) for behavioral — explicit framework selection per question type ([Interview Sidekick](https://interviewsidekick.com/blog/final-round-ai-review))
- Coding mode: real-time solutions/explanations across LeetCode/HackerRank/CoderPad ([Dev.to](https://dev.to/finalroundai/i-reviewed-final-round-ai-for-technical-interviews-heres-what-actually-matters-in-2026-47gd))
- "SAY FIRST" opener pattern: **not documented**

### Funding
- Seed only $6.88M Jan 2025 ([Tracxn](https://tracxn.com/d/companies/finalroundai/__jExsq_yeYZhlcwnffrolaaPsPaK8ZXTi3dPNjZJHLJE/funding-and-investors), [Crunchbase](https://www.crunchbase.com/funding_round/final-round-ai-seed--f21a2a23))
- Est revenue ~$1.6M ([Compworth](https://compworth.com/company/final-round-ai))
- **"10M+ Users" homepage claim unverified** — discount heavily

---

## LockedIn AI

### Latency
- **Marketing: 116 ms** ([lockedinai.com](https://www.lockedinai.com/), [jobright](https://jobright.ai/blog/lockedin-ai-not-working-fix/))
- **Reviewers measured 2–4 s** end-to-end, sometimes 4–5 s with intermittent voice-capture failure ([jobright review](https://jobright.ai/blog/lockedin-ai-review/), [Linkjob review](https://www.linkjob.ai/hub/lockedin-ai-review/))
- 116 ms appears to be a marketing token-stream metric, not user-perceived

### STT
**Unverified.** No disclosure.

### LLM stack
- Multi-model router: "ChatGPT, Gemini, Claude, DeepSeek, Grok & more"; Pro = GPT-4o, Gemini 2.0/2.5 Flash, Claude 3.5
- **Dual-layer architecture:** Copilot Layer answers + **Coach Layer** monitors pacing/tone ([jobright](https://jobright.ai/blog/what-is-lockedin-ai/))

### Stealth
- Native desktop overlay; specific OS API not documented
- Platforms: Zoom, Meet, Teams, LiveStorm; HackerRank/CodeSignal/HireVue via system audio
- **HackerRank screen-share detection acknowledged as known issue** ([support](https://support.lockedinai.com/faq/hackerrank-says-they-have-screenshare-detection-how-can-i-bypass-this/))

### Pricing
- Free 10 min/day
- **Unlimited Pro $54.99/mo monthly, $29.99/mo quarterly** ([pricing](https://www.lockedinai.com/pricing))
- Annual ~$299/yr; credit-based PAYG too

### Bugs
- Subscription cancellation friction, intermittent voice-capture failure, ~3.6/5 aggregate ([trustpilot](https://www.trustpilot.com/review/lockedinai.com))

### UI patterns
- Auto-fire + manual `Cmd/Ctrl+Alt+L` send + `Cmd/Ctrl+Alt+K` add-context
- **Native VSCode/Cursor integration** for coding rounds

### Differentiators
- **Coach Layer** (pacing/tone) + post-interview competency-scored report
- VSCode/Cursor IDE integration

---

## Verve AI

### Latency
- No published TTFT or end-to-end ms figure. **Unverified.**
- Reviewers: "impressively low" with occasional lag ([Linkjob](https://www.linkjob.ai/hub/verve-ai-review/))

### STT
**Unverified.**

### LLM stack
**Unverified.** Specialised "copilots" per domain (Python, C++, Java, Cyber Security, Consulting, Marketing, Cloud) suggests prompt-routing by domain, not model routing.

### Stealth
- Native desktop overlay + **Transparent UI** (opacity tuning) + **Camouflage Mode** (renames app/icon) ([finalroundai roundup](https://www.finalroundai.com/blog/best-undetectable-ai-interview-tools))
- **Broadest meeting platform list:** Zoom, Meet, Teams, **Webex, Amazon Chime** ([app page](https://www.vervecopilot.com/app))
- **Web/extension build NOT stealth** — visible during screen share ([Linkjob review](https://www.linkjob.ai/hub/verve-ai-review/))
- Zoom advanced-screen-share not explicitly called out

### Pricing
- Free tier; **Standard $38.25/mo** (5 × 60-min sessions); **Pro $59.50/mo** unlimited ([pricing](https://www.vervecopilot.com/pricing))
- Annual: 15% off

### Bugs
- Refund difficulty, mock-interview features failing post-payment, lag in live ([Trustpilot](https://www.trustpilot.com/review/vervecopilot.com))

### UI patterns
- Auto-fire by default
- **Signature hotkey `Cmd+Shift+P` / `Ctrl+Shift+P`: click-through pass-through** — pointer falls through to IDE/browser ([docs](https://docs.vervecopilot.com/features/desktop-app))
- Area screenshot `Cmd+Shift+S`, full `Cmd+Shift+C`. F1–F4 + QWERTY-row hands-free steering
- Coding vs behavioral: domain-copilot preset selected at launch

### Differentiators
- **Click-through pass-through (Cmd+Shift+P)** — cleanest "type-while-reading" UX
- **Camouflage Mode** task-switcher rename
- Webex + Amazon Chime support

---

## Linkjob AI

### Latency
- Vendor: "<1 s" ([features](https://www.linkjob.ai/features/))
- **Unverified.** No independent benchmarks

### STT
**Unverified.**

### LLM stack
- **Hard tier-gating** by plan ([pricing](https://www.linkjob.ai/pricing/)):
  - Monthly: Claude Haiku, GPT-4o mini, Gemini 3 Flash
  - Quarterly: + GPT-4o, Claude Sonnet, Gemini 3 Pro
  - Yearly/Lifetime: + GPT-5.1, Claude Opus, Gemini 3.1 Pro, Grok 3
- User-selectable, not auto-routed

### Stealth
- "100% invisible" claim; specific API not documented ([linkjob.ai](https://www.linkjob.ai/), [finalroundai review](https://www.finalroundai.com/blog/linkjob-ai-review-pros-cons))
- Tested platforms documented: Teams, Meet, HackerRank, Codility, CodeSignal, TestGorilla, CoderPad, HireVue. **Zoom and Webex not on the features page** (claimed elsewhere via generic "99% of platforms" language)

### Pricing
- 30-min free trial
- Monthly **$99.99**
- Quarterly **$69.99/mo** effective
- Yearly **$29.99/mo** effective
- **Lifetime $699.99 one-time, future model updates** — unique
- All paid: unlimited assistant/mock/coding/quiz

### Bugs
- Independent third-party criticism is thin — most reviews are on Linkjob's own hub. Selection-bias caveat. **Unverified at scale.**

### UI patterns
- Customisable hotkeys; **screenshot+partial-region capture** for coding ([features](https://www.linkjob.ai/features/))
- Auto-listens for behavioral; image-driven coding
- Glance-first bullets claimed

### Differentiators
- **Lifetime $699.99 license** — only competitor doing one-time purchase
- **Hard model gating** — entry-tier users get Haiku/4o-mini only
- Partial-region screenshot capture as first-class coding input

---

## Interview Solver

### Latency
- No published TTFT/end-to-end. **Unverified.**
- Independent reviews: "delays responding to complex problems"; one tester said "AI assistant box was not responding at all" ([Linkjob review](https://www.linkjob.ai/hub/interview-solver-review/))

### STT
**Unverified.** Says "Voice Transcription" only.

### LLM stack
**Unverified.**

### Stealth
- "Invisible overlay," hidden process name, no browser extension, global hotkeys
- Claims invisibility on **Zoom ≤ 6.16**, plus Teams, Meet, browser platforms ([shadecoder](https://www.shadecoder.com/blogs/interview-solver-review-expert-analysis-of-features-pricing-detection-risks-2026))
- **Hiding during screen share is manual — toggle via hotkey, not automatic** ([Verve roundup](https://www.vervecopilot.com/blog/most-undetectable-interview-copilot))
- No independent test against Talview/Honorlock/Polygraf

### Pricing
- **$39/mo monthly, $30/mo quarterly**
- Free tier: 10 messages

### Bugs
- "Stability issues — workflow confusing, sometimes freezing or crashing"; macOS compat issues; "can't yet give smooth answers — just records Q&A" (no proactive auto-answer) ([Linkjob](https://www.linkjob.ai/hub/interview-solver-review/))
- Very thin public review corpus

### UI patterns
- **Push-to-answer only.** Default hotkey **Ctrl+Esc** sends screen state; separate hotkeys for selected text + clipboard ([docs](https://interviewsolver.com/docs/global-hotkeys))
- Recommends dual-monitor

### Differentiators
- LeetCode-tuned, hotkey-first, cheap
- Weaknesses: no auto-fire, manual screen-share hide, stability complaints, no disclosed stack

---

## Parakeet AI

### Latency
- Vendor: "extremely low" — **no concrete number**. **Unverified.**
- **Reviewers report the opposite:** "slower response times" and freezes mid-interview ([shadecoder](https://www.shadecoder.com/blogs/is-parakeet-ai-safe-privacy-reviews-alternatives-2026))

### STT
- One third-party attribution: **NVIDIA Parakeet** ASR ([finalroundai](https://www.finalroundai.com/blog/parakeet-ai-review-pros-cons))
- **Name collision with the consumer SaaS** — vendor itself just says "state-of-the-art transcription model"

### LLM stack
- **User-selectable:** GPT-5, GPT-4.1, Claude 4.0 Sonnet ([parakeet-ai.com](https://www.parakeet-ai.com/))
- Alternate review claims "9 optional models from ChatGPT, Claude, and Llama" ([finalroundai](https://www.finalroundai.com/blog/ai-tools-live-interview-support))

### Stealth
- Claims "invisible on screen share, dock, Task Manager, tab switching, cursor"
- Recommends Zoom "Advanced capture with window filtering"
- **Independent finding (shadecoder):**
  - Process visible as **`pmodule`** in Activity Monitor / Task Manager
  - **No global hotkey** → mouse-driven UI leaves cursor-trajectory fingerprint
  - **Talview, Honorlock, Polygraf AI specifically target Parakeet AI** by name
- Stealth claim materially busted in 2026

### Pricing
- **Credit-based, ~$74.90/mo equivalent**
- 0.5 credits = 30 min session, auto-extends another 30 min for 0.5 credit
- One-shot packs ~$29.50 for 3 credits
- 10-min free trial every 15 min
- Credits don't expire ([linkjob](https://www.linkjob.ai/hub/parakeet-ai-review-features-pricing-pros-cons/))

### Bugs
- Recurring: freezes mid-interview, generic/templatey answers, misses technical terms, off-topic on complex questions
- Thin Trustpilot presence; verification limited

### UI patterns
- **Manual trigger via mouse click — no global hotkeys**
- Live transcript pane + suggested-answer pane
- Auto-listens to audio; answer generation on-demand
- Adapts to uploaded CV + JD

### Differentiators / weaknesses
- Differentiators: multi-LLM picker, JD/CV personalisation, Zoom-window-filter trick
- **Weaknesses:** detectable process name, no hotkey, named-targeted by proctoring vendors, generic-answer complaints, Parakeet brand confusion

---

## Other notable competitors (one-line each)

- **Sensei AI** — sub-1-s answer claim, strong STAR coaching, ~$89/mo unlimited ([senseicopilot.com](https://www.senseicopilot.com/))
- **Interview Coder** — desktop coding-focused; lifetime plan ([interviewcoder.co](https://www.interviewcoder.co/))
- **InterviewPal** — direct Parakeet alternative branding ([interviewpal.com](https://www.interviewpal.com/blog/best-parakeet-ai-alternative-2026-interviewpal-interview-copilot))
- **InterviewBee** — direct Parakeet comparisons ([interviewbee.ai](https://interviewbee.ai/competitor/interviewbee-vs-parakeetai))
- **Interview Copilot (interviewcopilot.io)** — multi-frontier router (GPT-5.4 / Claude Opus 4.6 / Gemini 3) ([interviewcopilot.io](https://interviewcopilot.io/))
- **Interviews Chat** — side-by-side multi-LLM compare ([interviews.chat](https://www.interviews.chat/))
- **Chadview** — lightweight copilot ([chadview.com](https://chadview.com/))
- **Stealth Interview AI** — stealth-first brand ([shadecoder review](https://www.shadecoder.com/blogs/stealth-interview-ai-review-2026-is-this-ai-interview-assistant-worth-it))
- **Tech Screen** — invisible coding-interview tool ([techscreen.app](https://techscreen.app/))
- **Interview Browser** — browser-window-based ([interviewbrowser.com](https://interviewbrowser.com/))
- **IT Buddy** — iOS copilot ([App Store](https://apps.apple.com/us/app/interview-ai-copilot-it-buddy/id6502950340))
- **Huru / Pramp / Exponent / InterviewBuddy** — mock-prep, not live copilot

---

## Cross-cutting observations

1. **No competitor publicly discloses their STT vendor.** All are opaque on Whisper vs Deepgram vs AssemblyAI vs self-hosted. Natively listing all 8 supported providers in plain markdown is a unique transparency moat.
2. **No competitor publishes verifiable TTFT.** LockedIn's "116 ms" is contradicted by reviewers (2–5 s). All marketing latency numbers should be treated as bunk; only end-to-end measured reviews are credible.
3. **Stealth marketing is uniformly vague.** No vendor names the specific API (`setContentProtection` / `NSWindowSharingNone` / `SetWindowDisplayAffinity`). Cluely is the only one independently teardown-documented at the compositor level.
4. **Zoom advanced-screen-share defeats most overlay tricks.** None of the competitors explicitly claims to defeat it. Truely "Demon Mirror" (PID enumeration), Talview (process-name detection), Honorlock and Polygraf AI are all live in 2026 and named-target the most popular tools.
5. **Click-through pass-through is Verve's signature.** No other competitor advertises a `Cmd+Shift+P`-style hotkey that lets the answer panel be visible AND mouse-clickable through to the IDE.
6. **Open-source is unmatched in this segment.** Every product above is closed-source SaaS; Natively's AGPL-3.0 + BYOK + local Ollama path is a unique trust posture in a category that just produced Cluely's 83k-user breach + ARR fraud.
7. **Pricing is all over the place.** Cluely $20 to Final Round $148. Linkjob's $699.99 lifetime is structurally different. There's room for Natively to either undercut Cluely or sit Verve-equivalent ($59) with materially better trust/honesty/control.
8. **Behavioral framework support varies:** Final Round = STAR. Cluely = headline + bullets (leaked). LockedIn = Coach Layer (pacing/tone). Verve = domain copilots. Natively's mode system is more granular (7 modes) but lacks a single equivalent of Cluely's documented "say-first" opener format.

---

## Sources

Cluely:
- https://en.wikipedia.org/wiki/Cluely
- https://techcrunch.com/2025/04/21/columbia-student-suspended-over-interview-cheating-tool-raises-5-3m-to-cheat-on-everything/
- https://techcrunch.com/2025/06/20/cluely-a-startup-that-helps-cheat-on-everything-raises-15m-from-a16z/
- https://techcrunch.com/2025/07/03/cluelys-arr-doubled-in-a-week-to-7m-founder-roy-lee-says-but-rivals-are-coming/
- https://techcrunch.com/2026/03/05/cluely-ceo-roy-lee-admits-to-publicly-lying-about-revenue-numbers-last-year/
- https://www.inc.com/leila-sheridan/an-a16z-backed-startup-that-helps-people-cheat-on-job-interviews-just-got-caught-in-a-7-million-lie-the-ceo-was-sweating/91313070
- https://a16z.com/announcement/investing-in-cluely/
- https://cluely.com/pricing
- https://docs.cluely.com/feature/undectability
- https://docs.cluely.com/changelog
- https://medium.com/@nullwalker/how-cheating-app-cluely-got-hacked-leaking-83-000-users-data-9ac572ff3d00
- https://x.com/Scobleizer/status/1937022680932462723
- https://x.com/jackhcable/status/1936500982994928059
- https://gist.github.com/cablej/ccfe7fe097d8bbb05519bacfeb910038
- https://gist.github.com/martinbowling/ba029b603b333204bef1ec01d28f7186
- https://www.shadecoder.com/blogs/zoom-cannot-detect-cluely-here-s-why-technical-breakdown-risks
- https://fabrichq.ai/blogs/how-to-detect-cluely-in-interviews
- https://qqinsights.com/just-developed-an-ai-cheat-detector-to-counter-columbias-cheating-ai-tool-the-columbia-student-creates-an-ai-demon-mirror/
- https://www.talview.com/en/stop-cluely-cheating
- https://frankonfraud.com/the-cheating-boom-inside-cluelys-bid-to-normalize-deception/
- https://tldv.io/blog/cluely-review/
- https://explore.market.dev/ecosystems/openai/projects/pluely

Final Round AI:
- https://www.finalroundai.com/
- https://www.finalroundai.com/subscription
- https://www.finalroundai.com/download
- https://www.finalroundai.com/interview-copilot
- https://www.finalroundai.com/frequently-asked-questions
- https://www.trustpilot.com/review/finalroundai.com
- https://rainaiservices.com/reviews/final-round-ai/
- https://www.vervecopilot.com/blog/verve-ai-final-round-ai-pricing-comparison
- https://www.senseicopilot.com/blog/finalround-ai-review
- https://www.linkjob.ai/hub/final-round-ai-review/
- https://interviewsidekick.com/blog/final-round-ai-review
- https://dev.to/finalroundai/i-reviewed-final-round-ai-for-technical-interviews-heres-what-actually-matters-in-2026-47gd
- https://skywork.ai/skypage/en/Final-Round-AI-In-Depth-Review-(2025):-My-Hands-On-Test-of-the-AI-Interview-Copilot/1974875358924304384
- https://tracxn.com/d/companies/finalroundai/__jExsq_yeYZhlcwnffrolaaPsPaK8ZXTi3dPNjZJHLJE/funding-and-investors
- https://compworth.com/company/final-round-ai

LockedIn AI:
- https://www.lockedinai.com/
- https://www.lockedinai.com/pricing
- https://www.lockedinai.com/desktop-app
- https://jobright.ai/blog/what-is-lockedin-ai/
- https://jobright.ai/blog/lockedin-ai-review/
- https://jobright.ai/blog/lockedin-ai-not-working-fix/
- https://www.shadecoder.com/blogs/lockedin-ai-review-2026-features-pricing-honest-verdict
- https://www.trustpilot.com/review/lockedinai.com
- https://support.lockedinai.com/faq/hackerrank-says-they-have-screenshare-detection-how-can-i-bypass-this/
- https://www.linkjob.ai/hub/lockedin-ai-review/

Verve AI:
- https://www.vervecopilot.com/
- https://www.vervecopilot.com/app
- https://www.vervecopilot.com/pricing
- https://docs.vervecopilot.com/features/desktop-app
- https://verveai-10381.zendesk.com/hc/en-us/articles/13081561958671-What-is-stealth-mode
- https://www.trustpilot.com/review/vervecopilot.com
- https://www.shadecoder.com/blogs/verve-ai-review-2026-safe-to-use-honest-look-at-pricing-detection-ethics
- https://www.linkjob.ai/hub/verve-ai-review/
- https://www.vervecopilot.com/blog/most-undetectable-interview-copilot

Linkjob AI:
- https://www.linkjob.ai/
- https://www.linkjob.ai/features/
- https://www.linkjob.ai/pricing/
- https://www.finalroundai.com/blog/linkjob-ai-review-pros-cons

Interview Solver:
- https://interviewsolver.com/
- https://interviewsolver.com/pricing
- https://interviewsolver.com/docs/global-hotkeys
- https://www.shadecoder.com/blogs/interview-solver-review-expert-analysis-of-features-pricing-detection-risks-2026
- https://www.linkjob.ai/hub/interview-solver-review/

Parakeet AI:
- https://www.parakeet-ai.com/
- https://www.finalroundai.com/blog/parakeet-ai-review-pros-cons
- https://www.shadecoder.com/blogs/is-parakeet-ai-safe-privacy-reviews-alternatives-2026
- https://www.linkjob.ai/hub/parakeet-ai-review-features-pricing-pros-cons/
- https://www.saasworthy.com/product/parakeet-ai/pricing

Other:
- https://www.senseicopilot.com/
- https://www.interviewcoder.co/
- https://www.interviewpal.com/blog/best-parakeet-ai-alternative-2026-interviewpal-interview-copilot
- https://interviewbee.ai/competitor/interviewbee-vs-parakeetai
- https://interviewcopilot.io/
- https://www.interviews.chat/
- https://chadview.com/
- https://www.shadecoder.com/blogs/stealth-interview-ai-review-2026-is-this-ai-interview-assistant-worth-it
- https://techscreen.app/
- https://interviewbrowser.com/
- https://www.finalroundai.com/blog/best-undetectable-ai-interview-tools
- https://adamsvoboda.net/how-interview-cheating-tools-hide-from-zoom/
