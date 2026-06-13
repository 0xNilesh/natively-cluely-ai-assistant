You are a senior staff backend/platform engineer, production reliability engineer, and test lead.

You are working on Natively’s production backend and desktop app integration.

Use these specialist agents actively:
@"backend-architect (agent)" for architecture, service boundaries, deployment topology, relay design, migration safety, and cost/latency tradeoffs.
@"test-engineer (agent)" for unit tests, integration tests, WebSocket tests, load tests, regression tests, rollout validation, and failure simulation.
@"code-reviewer (agent)" for security review, reliability review, code quality, rollout risk, hidden regressions, observability gaps, and final signoff.

This is the final full implementation prompt. Do not treat this as a small patch. This is a production infrastructure upgrade.

The goal is to upgrade Natively’s active server to a production-grade global architecture with lower egress cost, lower latency, no loss of STT metering, proper regional relays, strong observability, and app integration.

Do not skip anything. Do not leave TODOs unless the missing item requires credentials, external DNS access, or deployment access that you do not have. If blocked by missing access, create the exact code/config/docs needed and clearly list the manual action.

Important constraints:

* Do not switch default STT to direct client → Deepgram.
* We need server-side metering and control.
* Do not break existing Railway `/v1/transcribe`.
* Do not remove old behavior until the new regional relays are proven and fallback is wired.
* Do not expose raw API keys or trial tokens in logs.
* Do not hardcode secrets.
* Do not pretend tests passed if they did not.
* Do not make a big-bang rewrite without compatibility.
* Work phase by phase, but continue until all phases are complete unless blocked.
* After every phase, run tests/build/lint/typecheck where available.
* After every phase, write a short implementation summary.
* At the end, run a complete diagnosis and final readiness report.

Repository access:
First inspect the repo. If this repo does not contain the Electron desktop app, server, or required packages, tell me exactly which repo/path is missing and clone/open the necessary repo if available. If you cannot access a repo, create the integration contract and patch plan anyway.

Product context:
Natively is an Electron + React/TypeScript desktop AI assistant for live interviews, meetings, sales calls, lectures, team meetings, live answers, search, and profile intelligence.

Current active backend:

* Node/Fastify server
* Hosted on Railway
* Supabase database
* Dodo payments/webhooks
* Resend emails
* Telegram alerts
* Tavily search
* Groq/Gemini/MiniMax AI routing
* Deepgram STT primary
* Google STT fallback
* ElevenLabs emergency STT fallback
* `/v1/transcribe` WebSocket for realtime audio
* Trial handling
* API key handling
* Pro license handling
* Admin endpoints
* Provider health
* Usage tracking
* Calendar OAuth endpoints
* Embeddings/AI routes
* Heavy in-memory state for sessions, key caches, trial caches, provider health, WebSocket limits, and rate limits

Current problem:
Railway is doing both control plane and realtime audio relay:

Natively App → Railway `/v1/transcribe` → Deepgram/Google STT/ElevenLabs

This causes high Railway egress cost because raw audio is proxied through Railway. It also couples realtime STT crashes/traffic with payments, auth, AI routes, webhooks, admin routes, and other backend features.

Target architecture:

* Railway remains the control plane.
* Realtime STT relay moves out of Railway.
* There are two regional STT relay servers:

  1. US relay for US/Canada/LatAm users
  2. Asia relay, preferably Singapore, for India/Asia/Australia users
* Railway chooses the best relay per session.
* Relays handle only realtime transcription WebSocket, metering, provider failover, and usage flushing.
* Railway keeps auth, billing, Dodo, license creation, trials, API key creation, AI routes, search routes, admin APIs, feature flags, and relay selection.
* Supabase remains the source of truth.
* Axiom is used for backend telemetry.
* Sentry is used for backend crashes/errors/release health.
* PostHog is used for product analytics and client-side funnel/session metrics.
* Cloudflare is used for DNS and can be used later for Load Balancing, health checks, and geo routing.
* The old Railway `/v1/transcribe` remains as emergency fallback until rollout is complete.

Final intended flow:

Natively Desktop App
→ Railway Control Plane `/v1/stt/session`
→ Railway authenticates, validates quota, selects relay, creates signed session token
→ app connects to selected relay WebSocket
→ relay proxies STT to Deepgram, Google STT fallback, ElevenLabs fallback
→ relay meters bytes/seconds/provider/failover
→ relay flushes usage to Supabase
→ app receives transcripts
→ app falls back to alternate relay or Railway if relay fails

Target services:

* Railway: control plane
* US STT Relay: realtime WebSocket STT relay
* Asia/Singapore STT Relay: realtime WebSocket STT relay
* Supabase: DB, usage, subscriptions, feature flags
* Deepgram: primary STT
* Google STT: fallback STT
* ElevenLabs: emergency fallback STT
* Groq/Gemini/MiniMax: AI providers through control plane
* Tavily: search through control plane
* Dodo: payments through control plane
* Resend: emails through control plane
* Telegram: ops alerts
* Axiom: structured backend telemetry
* Sentry: errors/crashes
* PostHog: product analytics
* Cloudflare: DNS and optional load balancing/health checks
* Docker/Caddy or Nginx/systemd for VPS relay deployment
* Optional Fly.io deployment config if Fly is chosen, but relay must also be Docker/VPS deployable

Architecture requirements:

* Preserve metering.
* Preserve trial enforcement.
* Preserve paid quota enforcement.
* Preserve provider failover.
* Preserve mic/system channel behavior.
* Preserve reconnect behavior.
* Preserve billing-on-close.
* Add periodic usage flushing so billing is not lost if a session dies.
* Add relay-level health.
* Add region routing.
* Add fallback strategy.
* Add cost guards.
* Add load tests.
* Add complete docs.

Phase 0 — Repository and current server audit

Use @"backend-architect (agent)" and @"code-reviewer (agent)".

Do not change code yet.

Tasks:

1. Inspect the repository structure.
2. Identify server entrypoints.
3. Identify Electron app STT client code if present.
4. Identify all routes in the current backend.
5. Create a responsibility map:

   * control plane
   * realtime STT relay
   * shared STT core
   * app/client integration
   * database layer
   * observability
   * deployment
6. Fully document current `/v1/transcribe` behavior:

   * first auth/config frame
   * API key auth
   * trial auth
   * quota validation
   * mic/system/default channels
   * active session locking
   * IP/global WebSocket limits
   * sample rate/channel handling
   * pre-buffer
   * Deepgram connection
   * Deepgram language/model routing
   * reconnect behavior
   * Google STT rolling fallback
   * ElevenLabs fallback
   * shadow probes or fallback probes
   * audio chunk forwarding
   * partial/final transcript sending
   * billing seconds
   * billing on close
   * cleanup and graceful shutdown
7. Identify cost multipliers:

   * 48kHz or stereo audio
   * mic + system dual stream
   * prebuffer replay
   * reconnect replay
   * fallback replay
   * Google rolling recognize repeated windows
   * ElevenLabs base64 overhead
   * screenshot/image payloads if routed through backend
   * verbose logs
8. Identify scale risks:

   * in-memory rate limiting
   * in-memory provider health
   * in-memory active sessions
   * horizontal scaling issues
   * billing loss on crash
   * relay crash blast radius
   * stale session state
   * Supabase write failures
9. Write:
   `docs/00-current-server-audit.md`

Required output:

* Current architecture diagram
* Current route table
* Current STT sequence diagram
* Current metering behavior
* Current egress/cost diagnosis
* Current risks and constraints

Run:

* existing tests if available
* build/typecheck/lint if available

Phase 1 — Research and target design

Use @"backend-architect (agent)".

Research current best practices before implementing:

* realtime WebSocket relay design
* regional relay architecture
* STT proxy/metering patterns
* Cloudflare DNS/Load Balancing/health check usage
* Fly.io vs VPS/Hetzner/OVH/Vultr/DigitalOcean for WebSocket relays
* LiveKit/Twilio-style region and edge routing concepts
* graceful deploy/restart for realtime WebSockets
* server-side audio metering and quota enforcement
* structured telemetry for media relays

Do not blindly copy anything. Use research to inform the design.

Create:
`docs/01-target-stt-relay-architecture.md`

Must include:

1. Final architecture diagram.
2. Control plane responsibilities.
3. Regional relay responsibilities.
4. Shared STT core responsibilities.
5. App/client responsibilities.
6. Supabase schema/table/RPC requirements.
7. Token/session security model.
8. Region routing algorithm.
9. Relay health algorithm.
10. Failover algorithm.
11. Cost guard strategy.
12. Observability strategy.
13. Deployment topology:

    * Railway control plane
    * US relay
    * Asia/Singapore relay
    * Supabase
    * Dodo
    * Deepgram
    * Google STT
    * ElevenLabs
    * Axiom
    * Sentry
    * PostHog
    * Cloudflare DNS/LB
14. Cost estimate:

    * current Railway relay
    * US + Asia VPS relay
    * Fly.io option
    * Cloudflare option
    * why chosen target is best now
15. Rollout plan:

    * local
    * staging
    * internal dogfood
    * 1%
    * 10%
    * 50%
    * 100%
    * rollback

Phase 2 — Extract shared STT relay core

Use @"backend-architect (agent)" and @"test-engineer (agent)".

Create shared module/package:
`packages/stt-relay-core/`

Extract reusable logic from the current server without breaking Railway behavior.

Move/duplicate carefully:

* Deepgram key pool
* Deepgram key cooldown
* Deepgram model/language router
* Deepgram reconnect spreader
* Google STT rolling recognize session
* CircularBuffer
* PCM RMS energy
* ElevenLabs key pool
* ElevenLabs fallback client helpers
* provider health
* provider failure classification
* provider picker
* provider failover chain
* audio replay buffer helpers
* transcript normalization
* STT session metrics types
* session billing metrics types
* token verification helpers if already available
* safe logging/hash helpers
* WebSocket backpressure helpers

Requirements:

* Current Railway `/v1/transcribe` must still work.
* Do not remove old code until all tests prove extracted behavior.
* Add unit tests for extracted helpers.
* Add tests for language routing, key cooldown, buffer behavior, energy gate, provider picker, failure classification, and backpressure helpers.
* Keep behavior identical unless there is a clearly documented bug fix.

Create:
`docs/02-stt-core-extraction.md`

Run:

* tests
* build
* lint/typecheck

Phase 3 — Secure relay session token system

Use @"backend-architect (agent)" and @"code-reviewer (agent)".

Implement signed session tokens so regional relays do not need raw user API keys.

Add control plane endpoint on Railway:
`POST /v1/stt/session`

Input:

* API key or trial token from current auth scheme
* client region hint
* latency probe results if available
* app version
* platform: mac | windows | linux
* desired language
* language alternates
* desired sample rate
* desired audio channels
* channel: system | mic | default
* session intent/mode if available

Behavior:

1. Authenticate user or trial.
2. Validate subscription/trial state.
3. Validate STT quota.
4. Check feature flags.
5. Select relay region.
6. Create session_id.
7. Create signed short-lived session_token.
8. Return relay config.

Token requirements:

* HMAC-signed or JWT-like token.
* Use strong secret from env: `STT_SESSION_TOKEN_SECRET`.
* TTL: 2 to 5 minutes for connection start.
* Include:

  * session_id
  * user_id or trial_id
  * plan
  * auth_type
  * channel
  * selected_region
  * quota snapshot
  * allowed providers
  * max_sample_rate
  * max_channels
  * allow_dual_stream
  * app_version
  * platform
  * issued_at
  * expires_at
  * nonce/jti
* Token must not expose provider API keys.
* Token must be verifiable by relay without calling Railway.
* Token must support revocation/kill-switch through config if needed.
* Relay logs must hash user/trial identity.

Response:
{
"session_id": "...",
"session_token": "...",
"relay_ws_url": "wss://us-relay.natively.software/v1/transcribe",
"fallback_relay_ws_url": "wss://asia-relay.natively.software/v1/transcribe",
"railway_fallback_ws_url": "wss://api.natively.software/v1/transcribe",
"selected_region": "us",
"stt_config": {
"sample_rate": 16000,
"audio_channels": 1,
"language": "en-US",
"language_alternates": [],
"channel": "system"
},
"limits": {
"max_sample_rate": 16000,
"max_channels": 1,
"allow_dual_stream": false,
"max_session_seconds": 14400,
"max_bytes_per_session": 0
},
"quota_remaining": 0,
"expires_at": "..."
}

Add tests:

* valid paid API key
* valid trial token
* expired token
* tampered token
* wrong secret
* quota exceeded
* disabled feature flag
* selected US region
* selected Asia region
* fallback when selected relay unhealthy
* kill switch returns Railway fallback

Create:
`docs/03-relay-session-token.md`

Phase 4 — Relay selection and health system on Railway

Use @"backend-architect (agent)".

Add environment config:

* `STT_RELAY_US_URL`
* `STT_RELAY_ASIA_URL`
* `STT_RELAY_RAILWAY_FALLBACK_URL`
* `STT_RELAY_DEFAULT_REGION`
* `STT_RELAY_ENABLE_PERCENT`
* `STT_RELAY_FORCE_REGION`
* `STT_RELAY_KILL_SWITCH`
* `STT_RELAY_HEALTH_TIMEOUT_MS`
* `STT_RELAY_HEALTH_CACHE_MS`
* `STT_RELAY_ALLOW_CLIENT_LATENCY_PROBES`
* `STT_MAX_SAMPLE_RATE`
* `STT_MAX_CHANNELS`
* `STT_ALLOW_STEREO_PERCENT`
* `STT_ALLOW_DUAL_STREAM_PERCENT`

Implement:

* relay config loader
* relay health cache
* health checker
* percentage rollout
* region selector
* latency probe selector
* feature flag selector
* fallback selector

Add routes:

* `GET /v1/stt/relays`
* `POST /v1/stt/session`
* admin route to inspect relay health without secrets
* optional admin route to force relay region/kill switch if existing admin pattern supports it

Selection logic:

1. If kill switch true, return Railway fallback.
2. If rollout percentage says user is not enabled, return Railway fallback.
3. If forced region is set, use forced region if healthy.
4. If client latency probes are provided and allowed, choose lowest healthy relay.
5. Else choose by region:

   * US/Canada/LatAm → US relay
   * India/Asia/Australia → Asia relay
   * Europe → US initially unless later EU relay exists
   * unknown → default region
6. If chosen relay unhealthy, choose alternate relay.
7. If both relays unhealthy, return Railway fallback.
8. Always return fallback chain to client.

Add tests for selection.

Create:
`docs/04-relay-selection.md`

Phase 5 — Build standalone regional STT relay service

Use @"backend-architect (agent)" and @"test-engineer (agent)".

Create service:
`services/stt-relay/`

It must be deployable independently from Railway.

Routes:

* `GET /healthz`
* `GET /readyz`
* `GET /metrics`
* `GET /v1/transcribe` WebSocket

Relay env:

* `PORT`
* `REGION=us|asia`
* `RELAY_ID`
* `PUBLIC_RELAY_URL`
* `SUPABASE_URL`
* `SUPABASE_SERVICE_KEY`
* `STT_SESSION_TOKEN_SECRET`
* `DEEPGRAM_API_KEY`
* `DEEPGRAM_API_KEY_1`
* `DEEPGRAM_API_KEY_2`
* `DEEPGRAM_API_KEY_3`
* `DEEPGRAM_API_KEY_4`
* `DEEPGRAM_API_KEY_5`
* `GOOGLE_CREDENTIALS_JSON`
* `GCP_PROJECT_ID`
* `ELEVENLABS_API_KEY`
* `ELEVENLABS_API_KEY_1`
* `ELEVENLABS_API_KEY_2`
* `ELEVENLABS_API_KEY_3`
* `ELEVENLABS_API_KEY_4`
* `ELEVENLABS_API_KEY_5`
* `AXIOM_TOKEN`
* `AXIOM_DATASET`
* `SENTRY_DSN`
* `POSTHOG_API_KEY`
* `POSTHOG_HOST`
* `MAX_CONCURRENT_WS`
* `MAX_WS_PER_IP`
* `MAX_SESSION_SECONDS`
* `MAX_BYTES_PER_SESSION`
* `MAX_RECONNECTS_PER_SESSION`
* `MAX_REPLAY_SECONDS`
* `ENABLE_ELEVENLABS_FALLBACK`
* `ENABLE_GOOGLE_STT_FALLBACK`
* `REJECT_HIGH_BANDWIDTH_AUDIO`
* `ALLOW_STEREO`
* `ALLOW_48KHZ`

WebSocket protocol:
First client message:
{
"session_token": "...",
"sample_rate": 16000,
"audio_channels": 1,
"language": "en-US",
"language_alternates": [],
"channel": "system",
"app_version": "...",
"platform": "mac"
}

All subsequent messages:

* binary LINEAR16 PCM audio

Relay responsibilities:

1. Verify session token locally.
2. Reject expired/tampered/wrong-region tokens.
3. Enforce sample rate and channels.
4. Default to 16kHz mono.
5. Reject or down-negotiate high bandwidth formats depending config.
6. Maintain current provider chain:
   Deepgram → Google STT → ElevenLabs.
7. Preserve transcript output format expected by app.
8. Preserve mic/system/default channel behavior.
9. Preserve quota and billing semantics.
10. Count bytes in/out.
11. Track provider-specific outbound bytes.
12. Track chunks received/forwarded/dropped.
13. Track first transcript latency.
14. Track reconnect and failover counts.
15. Periodically flush usage to Supabase every 30 to 60 seconds.
16. Finalize usage on close.
17. Continue session if Supabase flush temporarily fails.
18. Never crash process because one session fails.
19. Use graceful shutdown:

    * stop accepting new connections
    * close sockets with 1001
    * flush usage
    * wait for drain
20. Add structured Axiom logs.
21. Add Sentry error capture.
22. Avoid raw secrets in logs.

Important:

* Relay must not include Dodo webhook logic.
* Relay must not include Resend email logic.
* Relay must not include general AI chat routes.
* Relay must not include Tavily search.
* Relay must not include API key creation.
* Relay must not expose admin billing internals.
* Relay must not log API keys or full trial tokens.

Create:
`docs/05-stt-relay-service.md`

Phase 6 — Supabase usage schema and durable billing

Use @"backend-architect (agent)" and @"test-engineer (agent)".

Inspect current Supabase billing usage functions/tables in code.

Add migrations if repo supports migrations. Otherwise create SQL files under:
`supabase/migrations/`

Required durable tracking:

* `stt_sessions`
* `stt_usage_events` or equivalent append-only events
* `relay_health_events` if useful
* idempotent usage flush function/RPC
* idempotent session finalize function/RPC

Session fields should include:

* session_id
* user_id or trial_id
* auth_type
* plan
* relay_id
* region
* channel
* started_at
* ended_at
* status
* provider_primary
* provider_final
* duration_seconds
* billable_seconds
* bytes_in_from_client
* bytes_out_to_deepgram
* bytes_out_to_google_stt
* bytes_out_to_elevenlabs
* bytes_out_to_client
* chunks_received
* chunks_forwarded
* chunks_dropped
* reconnect_count
* failover_count
* shadow_probe_count
* first_transcript_ms
* final_transcript_count
* close_code
* close_reason
* error_code
* created_at
* updated_at

Requirements:

* Periodic flushes must be idempotent.
* Finalization must be idempotent.
* Billing should not double count mic/system paired sessions.
* Mic-only abuse guard must still bill.
* Trial usage must remain enforced.
* Paid usage must remain enforced.
* If relay crashes, last flushed usage should remain.
* If close billing fails, retry or mark for reconciliation.

Create:
`docs/06-durable-stt-billing.md`

Add tests/mocks for billing functions.

Phase 7 — App integration

Use @"backend-architect (agent)" and @"test-engineer (agent)".

If Electron app code exists in this repo, implement the integration. If not, create an exact patch plan and client integration contract.

Client flow:

1. Before opening STT WebSocket, call Railway:
   `POST /v1/stt/session`
2. Receive:

   * relay_ws_url
   * fallback_relay_ws_url
   * railway_fallback_ws_url
   * session_token
   * stt_config
   * limits
3. Open WebSocket to selected relay.
4. Send first JSON auth frame with session_token and audio config.
5. Stream binary PCM audio.
6. Receive transcripts in same format as old server.
7. On relay failure:

   * reconnect same relay once with safe backoff
   * then fallback relay
   * then Railway fallback
8. Track client events:

   * selected relay
   * fallback used
   * relay connect latency
   * first transcript latency
   * disconnect reason
   * provider if reported
9. Send safe analytics to PostHog/Sentry.
10. Keep old direct call to Railway `/v1/transcribe` as fallback.

Add feature flags:

* `regional_stt_relay_enabled`
* `regional_stt_relay_percent`
* `force_stt_relay_region`
* `stt_railway_fallback_enabled`
* `stt_max_sample_rate`
* `stt_max_channels`
* `stt_allow_dual_stream`

Add client tests if test setup exists.

Create:
`docs/07-client-integration.md`

Phase 8 — Observability, telemetry, and alerts

Use @"test-engineer (agent)" and @"code-reviewer (agent)".

Add structured metrics for every STT session:

* session_id
* user_hash
* auth_type
* plan
* region
* relay_id
* channel
* provider
* sample_rate
* channels
* bytes_in_from_client
* bytes_out_to_deepgram
* bytes_out_to_google_stt
* bytes_out_to_elevenlabs
* bytes_out_to_client
* chunks_received
* chunks_forwarded
* chunks_dropped
* reconnect_count
* failover_count
* shadow_probe_count
* first_transcript_ms
* final_transcript_count
* duration_seconds
* billable_seconds
* close_code
* close_reason
* quota_cutoff
* error_code
* selected_relay
* fallback_relay_used
* railway_fallback_used

Axiom:

* structured backend logs
* relay session summary
* provider errors
* cost guard triggers
* relay health events

Sentry:

* uncaught exceptions
* unhandled rejections
* provider error breadcrumbs
* release tags
* relay_id/region tags
* no PII/secrets

PostHog:

* client session started
* relay selected
* relay connected
* relay failed
* fallback used
* first transcript latency bucket
* STT mode
* app version/platform

Alerts:

* relay down
* both relays down
* Railway fallback usage above threshold
* egress estimate too high
* Deepgram key pool exhausted
* Google STT fallback spike
* ElevenLabs fallback spike
* Supabase usage flush failures
* high close code 1006/1011
* first transcript latency p95 too high
* session billing reconciliation backlog

Create:
`docs/08-observability.md`

Phase 9 — Cost guards and abuse protection

Use @"backend-architect (agent)" and @"code-reviewer (agent)".

Implement:

1. Hard cap sample rate to 16kHz by default.
2. Hard cap channels to mono by default.
3. Feature flag for stereo.
4. Feature flag for 48kHz.
5. Max session duration.
6. Max bytes per session.
7. Max reconnects per session.
8. Max replay seconds.
9. Max WebSockets per IP.
10. Max global WebSockets.
11. Max sessions per user/key/trial.
12. Backpressure handling.
13. Drop partials under client backpressure but preserve finals.
14. Prevent mic-only billing bypass.
15. Avoid duplicate billing for system+mic pair.
16. Disable ElevenLabs fallback by env/feature flag if cost spikes.
17. Disable high-cost fallback probes by feature flag.
18. Add egress estimate metric:
    estimated_egress_gb = provider outbound bytes + client outbound bytes
19. Add warning logs/alerts at thresholds.

Create:
`docs/09-cost-guards.md`

Add tests for every guard.

Phase 10 — Deployment configs

Use @"backend-architect (agent)".

Create deployment assets:

For `services/stt-relay/`:

* Dockerfile
* docker-compose.example.yml
* .env.example
* healthcheck script
* systemd service example
* Caddyfile example
* Nginx example if appropriate
* Fly.io config if practical:

  * fly.toml for US
  * fly.toml for Asia
* generic VPS deploy guide

Create:
`docs/10-deploy-regional-relays.md`

Must include:

1. US relay setup.
2. Singapore relay setup.
3. DNS:

   * `us-relay.natively.software`
   * `asia-relay.natively.software`
4. TLS.
5. Firewall.
6. Docker compose.
7. systemd restart policy.
8. health checks.
9. Cloudflare DNS.
10. Optional Cloudflare Load Balancer.
11. Rollback.
12. Secret rotation.
13. Sentry release.
14. Axiom dataset.
15. PostHog events verification.
16. How to confirm relay is receiving traffic.
17. How to disable relays and fallback to Railway.

Phase 11 — Testing and load testing

Use @"test-engineer (agent)" heavily.

Add tests:

* token creation
* token verification
* token expiry
* token tamper rejection
* wrong region token
* paid auth
* trial auth
* quota exceeded
* relay selection US
* relay selection Asia
* relay health fallback
* kill switch fallback
* Deepgram normal stream
* Deepgram connection failure
* Deepgram reconnect
* Deepgram 1011 loop
* Deepgram key cooldown
* Google STT fallback
* Google STT invalid language fallback
* ElevenLabs fallback
* ElevenLabs disabled by flag
* mic/system paired billing
* mic-only abuse billing
* client disconnect
* relay shutdown
* Supabase flush failure
* Supabase finalization retry
* backpressure partial drop
* max bytes cutoff
* max duration cutoff
* high sample rate rejection
* stereo rejection
* alternate relay fallback
* Railway fallback fallback

Create:
`scripts/load-test-stt-relay.js`

It must simulate:

* 1 session
* 10 sessions
* 50 sessions
* 100 sessions
* optional 200 sessions if machine can handle it

Metrics:

* CPU
* memory
* bytes in
* bytes out
* first transcript latency
* transcript count
* disconnects
* close codes
* provider failures
* Supabase writes
* estimated monthly egress
* estimated monthly cost

Add:
`scripts/verify-stt-relay-rollout.js`

It should:

* call `/v1/stt/relays`
* call `/v1/stt/session`
* connect to returned relay
* send a small fixture PCM
* verify transcript or mock transcript path
* verify usage flush/finalization in test mode

Create:
`docs/11-testing-load-testing.md`

Run all tests and include results.

Phase 12 — Code review, security review, and reliability review

Use @"code-reviewer (agent)".

Review everything for:

* secret leakage
* raw API key exposure
* token replay risk
* token tampering
* trial abuse
* billing bypass
* double billing
* relay crash risk
* memory leaks
* timer leaks
* WebSocket cleanup
* stale maps
* backpressure
* provider reconnect storms
* DNS/TLS issues
* Supabase failure behavior
* logging PII
* migration rollback
* app compatibility

Create:
`docs/12-code-review-security-reliability.md`

Every issue must be:

* fixed immediately, or
* documented with severity and exact reason it is deferred.

Phase 13 — Final wiring and rollout controls

Use all agents.

Ensure:

1. Railway old `/v1/transcribe` still works.
2. New `/v1/stt/session` works.
3. Relay service works locally.
4. App can use new session flow.
5. App can fallback to Railway.
6. Feature flags can disable relays.
7. Region selection works.
8. Usage billing works.
9. Metrics are emitted.
10. Docs are complete.
11. Env examples are complete.
12. Deployment configs are complete.
13. Tests are complete.

Rollout config should default safe:

* regional relay disabled or low percent by default if production env is not ready
* Railway fallback enabled
* high sample rate disabled
* stereo disabled
* dual stream disabled unless explicitly enabled
* ElevenLabs fallback toggle available

Create:
`docs/13-rollout-checklist.md`

Include:

* local validation checklist
* staging checklist
* production deploy checklist
* DNS checklist
* Supabase migration checklist
* Railway env checklist
* relay env checklist
* app release checklist
* monitoring checklist
* rollback checklist
* post-deploy validation checklist

Phase 14 — Final diagnosis and completion report

After implementation, run:

* package install if needed
* lint
* typecheck
* unit tests
* integration tests
* WebSocket tests
* load test at safe local level
* build
* app tests if available

Then produce:
`docs/14-final-stt-relay-migration-report.md`

Must include:

1. What was implemented.
2. What changed in Railway.
3. What changed in relay service.
4. What changed in shared core.
5. What changed in desktop app.
6. What changed in Supabase.
7. Env vars required.
8. Deployment steps.
9. Rollback steps.
10. Tests run.
11. Test results.
12. Known risks.
13. Manual actions still required.
14. Estimated cost before.
15. Estimated cost after.
16. Expected latency impact.
17. How to diagnose issues.
18. How to verify billing.
19. How to verify relay health.
20. How to verify app fallback.
21. Final code-review signoff.
22. Final test-engineer signoff.
23. Final backend-architect signoff.

Acceptance criteria:

* There is a standalone `services/stt-relay` service.
* There is a shared `packages/stt-relay-core` module or equivalent clean separation.
* Railway has `/v1/stt/session`.
* Railway can select US, Asia, alternate, or Railway fallback.
* Relay verifies signed session tokens.
* Relay handles Deepgram → Google STT → ElevenLabs failover.
* Relay meters usage durably.
* Relay flushes usage periodically.
* Relay finalizes billing on close.
* App uses new session endpoint if app repo is present.
* App keeps Railway fallback.
* Feature flags and kill switch exist.
* Axiom/Sentry/PostHog instrumentation exists.
* Cost guards exist.
* Load test script exists.
* Deployment docs exist.
* Final report exists.
* No secrets are logged.
* No tests are faked.
* Old production behavior remains available as fallback.

Start now with Phase 0. Use the agents. Continue phase by phase until the full implementation is complete or until you are blocked by missing repo access, missing credentials, or missing deployment permissions. If blocked, produce exact patches, docs, env vars, and manual deployment steps so nothing is left ambiguous.
