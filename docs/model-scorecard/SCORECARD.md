# SCORECARD — Model × Capability (living)

Last updated: 2026-05-30. Pool tested: gemini-3-flash-preview, agy (Gemini 3.5 Flash), opencode-go
glm-5.1 / kimi-k2.6, claude-sonnet-4-6 (bar). opus/gpt = ceiling refs (not contestants).
quality 0–1 · ✓=CRIT-gate pass · ✗=DQ (missed a CRITICAL item).

## Batch 1 — Coding workers (anchor: mythos-harness-style Python)

### Easy fixtures (Stage B, n=3 median) — mostly SATURATED
| Capability | gemini | agy | glm-5.1 | kimi-k2.6 | sonnet(bar) | confidence |
|---|---|---|---|---|---|---|
| scout    | 0.875 ✓ | 0.750 ✓ | 0.875 ✓ | 0.625 ✓ | 0.875 ✓ | MEDIUM (real spread) |
| builder  | 1.000 ✓ | 1.000 ✓ | 1.000 ✓ | 1.000 ✓ | 1.000 ✓ | SATURATED |
| reviewer | 0.900 ✓ | 0.800 ✗ | 0.900 ✓ | 0.900 ✗ | 1.000(SA) | near-sat |
| merger   | 1.000 ✓ | ✗ markers | 1.000 ✓ | 1.000 ✓ | 1.000(SA) | near-sat |
| monitor  | 0.600 ✓ | 0.800 ✓ | 0.800 ✗ | 0.600 ✓ | 0.800(SA) | real, noisy |

### Hard fixtures (n=1 screen) — discriminating
| Capability | gemini | agy | glm-5.1 | kimi-k2.6 | finding |
|---|---|---|---|---|---|
| builder-hard  | 1.000 ✓ | 1.000 ✓ | 1.000 ✓ | 1.000 ✓ | STILL saturated — builder is genuinely cheap-routable when a test oracle exists |
| reviewer-hard | 0.625 ✓ | 0.625 ✓ | 0.625 ✗ | 0.750 ✗ | race/UTF-8 traps separate the field; only agy+gemini stay CRIT-clean |
| merger-hard   | 1.000 ✓ | 0.000 ✗ | 1.000 ✓ | 1.000 ✓ | pytest oracle (8 tests): gemini/glm/kimi all nail semantic merge 8/8; **only agy fails** (9 markers left, import error) |

## Per-capability read (Batch 1)
| Capability | Best-fit candidate | Notes | Confidence |
|---|---|---|---|
| **scout**   | gemini-3-flash-preview | ties bar at 0.875, cheapest, stable | MEDIUM |
| **builder** | gemini-3-flash-preview | saturated even on hard fixture — any cheap model works w/ test oracle | MEDIUM (hard-confirmed) |
| **reviewer**| gemini-3-flash-preview | only cheap model CRIT-clean on BOTH easy+hard; agy clean-easy but DQ-easy-rerun, kimi/glm DQ-hard | LOW-MED |
| **merger**  | gemini-3-flash-preview / glm-5.1 / kimi-k2.6 | all 8/8 on HARD semantic merge; **only agy unfit (leaves conflict markers, import error)** | MEDIUM (hard-confirmed) |
| **monitor** | agy | only stable cheap model at 0.800; gemini 0.600, glm noisy | LOW-MED (noisy) |

## Cross-cutting findings
- **gemini-3-flash-preview = most stable cheap model** — CRIT-clean across the widest set, ~free.
- **agy: high raw capability, poor output hygiene** — leaks `file:///` paths, conflict markers,
  tool-narration. Strong at monitor/reasoning; **unfit for merger on BOTH easy+hard** (only model
  to leave conflict markers; merger-hard import error).
- **merger discriminates by output-contract discipline, not reasoning** — gemini/glm/kimi all
  produce valid 8/8 semantic merges on the hard fixture; agy alone botches the edit mechanics.
- **gemini-3-flash-preview = strongest cheap all-rounder** — CRIT-clean reviewer-hard, 8/8
  merger-hard, saturates builder, ~free.
- **Test-oracle tasks (builder) saturate** — cheap models match Claude; route cheap with confidence.
- **Judgment tasks (reviewer/monitor) discriminate** — need hard fixtures + n=3 to route safely.
- **opencode-go (glm/kimi) intermittently CRIT-fails** under n=3 — variance risk; needs retry policy.

## Status: NO routing applied
Live assignments unchanged (scout=haiku, builder/reviewer/merger/monitor=sonnet, lead/coord/orch=opus).
This scorecard is evidence for *future* expansion decisions, not an applied config.
