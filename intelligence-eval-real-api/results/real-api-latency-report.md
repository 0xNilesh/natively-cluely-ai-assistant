# Real API Latency Report

Endpoint: `https://api.natively.software/v1/chat`

## manual_identity
count: 10
p50/p95 first byte: 0.034/3.332ms
p50/p95 first token: 0.034/3.333ms
p50/p95 first useful token: 0.035/3.333ms
p50/p95 total: 0.035/3.333ms
slowest 5: ML-001=3.333ms, BE-001=0.581ms, PM-001=0.049ms, SDR-001=0.038ms, FND-001=0.035ms
likely bottleneck: deterministic (no provider)

## manual_projects
count: 9
p50/p95 first byte: 8294.44/73075.492ms
p50/p95 first token: 8294.485/73075.506ms
p50/p95 first useful token: 8294.494/73075.507ms
p50/p95 total: 8885.929/74087.501ms
slowest 5: CY-003=73075.507ms, BE-003=20956.399ms, UX-003=19157.786ms, FND-003=10792.254ms, ML-003=8294.494ms
likely bottleneck: provider prefill + network

## manual_skills
count: 2
p50/p95 first byte: 7363.772/7363.772ms
p50/p95 first token: 7363.785/7363.785ms
p50/p95 first useful token: 7363.789/7363.789ms
p50/p95 total: 8499.428/8499.428ms
slowest 5: ML-006=7363.789ms, BE-006=5574.233ms
likely bottleneck: provider prefill + network

## manual_jd_fit
count: 8
p50/p95 first byte: 8224.112/53638.006ms
p50/p95 first token: 8224.127/53638.026ms
p50/p95 first useful token: 8224.128/53638.029ms
p50/p95 total: 8807.278/54173.15ms
slowest 5: FND-005=53638.029ms, CY-005=38904.032ms, DA-005=21403.753ms, SRE-005=8224.128ms, CSM-005=7981.99ms
likely bottleneck: provider prefill + network

## manual_negotiation
count: 5
p50/p95 first byte: 8330.069/37062.019ms
p50/p95 first token: 8330.083/37062.038ms
p50/p95 first useful token: 8330.085/37062.04ms
p50/p95 total: 8807.805/37611.943ms
slowest 5: CY-008=37062.04ms, PM-008=9523.666ms, UX-008=8330.085ms, SRE-008=7150.796ms, ML-008=5787.47ms
likely bottleneck: provider prefill + network

## what_to_answer_identity
count: 10
p50/p95 first byte: 0.142/1.371ms
p50/p95 first token: 0.142/1.374ms
p50/p95 first useful token: 0.142/1.375ms
p50/p95 total: 0.142/1.375ms
slowest 5: BE-002=1.375ms, ML-002=0.458ms, SDR-002=0.44ms, PM-002=0.243ms, FND-002=0.142ms
likely bottleneck: deterministic (no provider)

## what_to_answer_projects
count: 2
p50/p95 first byte: 22263.143/22263.143ms
p50/p95 first token: 22263.179/22263.179ms
p50/p95 first useful token: 22263.189/22263.189ms
p50/p95 total: 22960.067/22960.067ms
slowest 5: ML-004=22263.189ms, BE-004=7760.397ms
likely bottleneck: provider prefill + network

## what_to_answer_followup
count: 10
p50/p95 first byte: 7036.335/19883.173ms
p50/p95 first token: 7036.355/19883.201ms
p50/p95 first useful token: 7036.357/19883.204ms
p50/p95 total: 7567.43/19951.054ms
slowest 5: CSM-007=19883.204ms, CY-007=10753.32ms, SRE-007=8245.113ms, SDR-007=7282.94ms, ML-007=7036.357ms
likely bottleneck: provider prefill + network

## what_to_answer_jd_fit
count: 2
p50/p95 first byte: 9231.128/9231.128ms
p50/p95 first token: 9231.156/9231.156ms
p50/p95 first useful token: 9231.163/9231.163ms
p50/p95 total: 10166.278/10166.278ms
slowest 5: ML-005=9231.163ms, BE-005=6081.305ms
likely bottleneck: provider prefill + network

## what_to_answer_negotiation
count: 5
p50/p95 first byte: 7272.163/49353.218ms
p50/p95 first token: 7272.202/49353.232ms
p50/p95 first useful token: 7272.211/49353.234ms
p50/p95 total: 8018.278/50104.115ms
slowest 5: FND-008=49353.234ms, SDR-008=7631.944ms, BE-008=7272.211ms, CSM-008=6780.8ms, DA-008=5428.38ms
likely bottleneck: provider prefill + network

