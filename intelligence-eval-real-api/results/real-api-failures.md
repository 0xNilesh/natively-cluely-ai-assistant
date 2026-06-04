# Real API Failures

### BE-003
Profile: backend-engineer | Mode: manual_input | Pattern: projects_manual
Actual response: I have built two main projects. The first is OpenRate, which is an open-source rate-limiting library written in Go that supports token bucket and sliding window algorithms using Redis and gRPC, and it has gained about two thousand stars on GitHub. The second is LedgerSync, a CLI tool built in Python
Required facts missing: none
Forbidden facts present: none
Detected context layers: projects, resume, custom_context, persona
Latency (first useful): 20956.399ms
Fail reasons: latency_stall:firstUseful_20956ms
Root cause guess: Provider/network latency exceeded budget.

### ML-004
Profile: ml-engineer | Mode: what_to_answer | Pattern: projects_interviewer
Actual response: I can walk you through RecSys-Factory, which is a production recommendation system library I designed to handle the classic exploration-exploitation dilemma. I built it to support multi-armed bandit strategies, specifically implementing contextual bandits like LinUCB, which is based on the foundatio
Required facts missing: none
Forbidden facts present: none
Detected context layers: projects, resume, custom_context, persona, live_transcript
Latency (first useful): 22263.189ms
Fail reasons: latency_stall:firstUseful_22263ms
Root cause guess: Provider/network latency exceeded budget.

### UX-003
Profile: ui-ux-designer | Mode: manual_input | Pattern: projects_manual
Actual response: I have two key design projects in my profile. 

The first is DesignToken.io, which is an open-source tool I built to manage design tokens across platforms using the Figma API, React, and Style Dictionary, and it currently has over 800 active weekly designers. The second is PodcastPlayer, where I red
Required facts missing: none
Forbidden facts present: none
Detected context layers: projects, resume, custom_context, persona
Latency (first useful): 19157.786ms
Fail reasons: latency_stall:firstUseful_19158ms
Root cause guess: Provider/network latency exceeded budget.

### DA-005
Profile: data-analyst | Mode: manual_input | Pattern: jd_alignment
Actual response: I don't have your resume or the specific job description loaded right now, but you can structure your fit using a highly metric-driven approach. Start by mapping your technical capabilities directly to their data stack, specifying the exact scale and volume of databases you have queried. Then, frame
Required facts missing: none
Forbidden facts present: none
Detected context layers: persona
Latency (first useful): 21403.753ms
Fail reasons: latency_stall:firstUseful_21404ms
Root cause guess: Provider/network latency exceeded budget.

### DA-007
Profile: data-analyst | Mode: manual_input | Pattern: metrics_manual
Actual response: I've worked closely with both financial and engagement metrics across my roles. At Amazon, I focused heavily on inventory optimization where I helped save twelve million dollars a year in overstocking costs, alongside tracking model performance like the eighty-seven percent accuracy of my seller sco
Required facts missing: none
Forbidden facts present: none
Detected context layers: experience, resume, custom_context, persona
Latency (first useful): 12054.379ms
Fail reasons: latency_stall:firstUseful_12054ms
Root cause guess: Provider/network latency exceeded budget.

### CSM-007
Profile: customer-success-manager | Mode: what_to_answer | Pattern: follow_up
Actual response: At Slack, I realized our onboarding process was taking too long to deliver value, so I designed and implemented standardized CS playbooks. These playbooks aligned both our internal teams and customer stakeholders on clear, time-bound milestones. By moving to this structured approach, we successfully
Required facts missing: none
Forbidden facts present: none
Detected context layers: experience, resume, custom_context, persona, live_transcript
Latency (first useful): 19883.204ms
Fail reasons: latency_stall:firstUseful_19883ms
Root cause guess: Provider/network latency exceeded budget.

### CY-003
Profile: cybersecurity-analyst | Mode: manual_input | Pattern: projects_manual
Actual response: I have focused primarily on two major threat detection projects. The first is ThreatHunter-Playbook, which is a library of over 500 Sigma rules mapped directly to MITRE ATT&CK techniques like T1003 for OS Credential Dumping. I built it using Sigma, Splunk, and YARA, and it currently sees active comm
Required facts missing: none
Forbidden facts present: none
Detected context layers: projects, resume, experience, custom_context, persona
Latency (first useful): 73075.507ms
Fail reasons: latency_stall:firstUseful_73076ms
Root cause guess: Provider/network latency exceeded budget.

### CY-004
Profile: cybersecurity-analyst | Mode: what_to_answer | Pattern: approach
Actual response: Whenever I investigate a suspicious login, I start by mapping it directly to the ATT&CK framework, specifically looking at Valid Accounts under Initial Access, which is technique T1078. I immediately pull the surrounding context like the source IP, user agent, and whether multi-factor authentication
Required facts missing: none
Forbidden facts present: none
Detected context layers: experience, resume, custom_context, persona, live_transcript
Latency (first useful): 24239.709ms
Fail reasons: latency_stall:firstUseful_24240ms
Root cause guess: Provider/network latency exceeded budget.

### CY-005
Profile: cybersecurity-analyst | Mode: manual_input | Pattern: jd_alignment
Actual response: I don't have the specific job description in front of me right now. Looking at standard cyber analyst requirements, my background is a very strong fit. My core stack includes Splunk for SIEM and CrowdStrike for EDR. This covers the primary pipeline for incident response and threat hunting. I also wr
Required facts missing: none
Forbidden facts present: none
Detected context layers: skills, resume, custom_context, persona
Latency (first useful): 38904.032ms
Fail reasons: latency_stall:firstUseful_38904ms
Root cause guess: Provider/network latency exceeded budget.

### CY-008
Profile: cybersecurity-analyst | Mode: manual_input | Pattern: negotiation
Actual response: Honestly, I am open to discussing a compensation package that reflects my experience in threat hunting and incident response. Given my background handling complex APT campaigns at CrowdStrike and leading breach responses at Mandiant, I am looking for a competitive offer aligned with the market. My m
Required facts missing: none
Forbidden facts present: none
Detected context layers: experience, resume, custom_context, negotiation, persona
Latency (first useful): 37062.04ms
Fail reasons: latency_stall:firstUseful_37062ms
Root cause guess: Provider/network latency exceeded budget.

### CY-009
Profile: cybersecurity-analyst | Mode: manual_input | Pattern: unknown
Actual response: I don't have specific metrics on my SOC ticket closure rate right now. I've been focused on implementing detection strategies using the ATT&CK framework to improve our security posture, but I don't have the exact numbers in front of me. Can I help you with anything else related to security operation
Required facts missing: none
Forbidden facts present: none
Detected context layers: custom_context, persona
Latency (first useful): 29287.126ms
Fail reasons: latency_stall:firstUseful_29287ms
Root cause guess: Provider/network latency exceeded budget.

### FND-005
Profile: founder-ceo-bd | Mode: manual_input | Pattern: jd_alignment
Actual response: As a technical founder, you fit business development by bridging complex product capabilities with strategic market needs. Your outcome-driven mindset allows you to structure partnerships that generate real revenue rather than just vanity metrics. You can speak directly to engineering teams while se
Required facts missing: none
Forbidden facts present: none
Detected context layers: persona
Latency (first useful): 53638.029ms
Fail reasons: latency_stall:firstUseful_53638ms
Root cause guess: Provider/network latency exceeded budget.

### FND-006
Profile: founder-ceo-bd | Mode: what_to_answer | Pattern: metrics_guard
Actual response: I can share a few key numbers that highlight how we tie our technical execution directly to market growth. At my current company, Nexus AI, we have hit $2.4 million in ARR with 120 paying customers. That momentum allowed us to secure an $18 million Series A, and I built our 12-person technical team 
Required facts missing: none
Forbidden facts present: none
Detected context layers: experience, resume, custom_context, persona, live_transcript
Latency (first useful): 23651.559ms
Fail reasons: latency_stall:firstUseful_23652ms
Root cause guess: Provider/network latency exceeded budget.

### FND-008
Profile: founder-ceo-bd | Mode: what_to_answer | Pattern: negotiation
Actual response: Given my background building StackIQ to a forty million dollar acquisition and growing Nexus AI to over two million in ARR, I view compensation through the lens of long-term partnership. I am looking for a competitive market-rate base, but my primary focus is on a meaningful equity stake that aligns
Required facts missing: none
Forbidden facts present: none
Detected context layers: experience, resume, custom_context, negotiation, persona, live_transcript
Latency (first useful): 49353.234ms
Fail reasons: latency_stall:firstUseful_49353ms
Root cause guess: Provider/network latency exceeded budget.

### TWO-SUM-WTA
Profile: backend-engineer | Mode: what_to_answer | Pattern: coding_interviewer
Actual response: Yeah, we can solve Two Sum optimally in linear time using a hash map. The idea is to iterate through the array once while storing the numbers we've already seen and their indices. 

For each number, we calculate its complement by subtracting the current value from the target. If that complement is a
Required facts missing: none
Forbidden facts present: none
Detected context layers: experience, resume, custom_context, persona, live_transcript
Latency (first useful): 18021.213ms
Fail reasons: forbidden_context_layer_selected:resume, latency_stall:firstUseful_18021ms
Root cause guess: Provider/network latency exceeded budget.

### REVERSE-LINKED-LIST-WTA
Profile: backend-engineer | Mode: what_to_answer | Pattern: coding_interviewer
Actual response: To reverse a singly linked list, I typically use the iterative approach because it is highly optimal for space. We maintain three pointers to track the previous node, the current node, and the next node. As we traverse the list, we store the next node, flip the current node's pointer to point backwa
Required facts missing: none
Forbidden facts present: none
Detected context layers: experience, resume, custom_context, persona, live_transcript
Latency (first useful): 8908.989ms
Fail reasons: forbidden_context_layer_selected:resume
Root cause guess: See fail reasons.

