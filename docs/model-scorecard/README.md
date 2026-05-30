# Model Capability Scorecard

A living reference for **which model is best-fit for which swarm capability**, by measured
performance — so any project can route a capability to the cheapest model that is *good enough*
rather than defaulting everything to Claude.

This directory is part of the overstory template; new projects inherit it as a starting reference.

## What this is / isn't
- **IS:** an evidence log of bakeoff benchmarks (accuracy, CRIT-gate pass, cost tier, stability)
  per capability per model.
- **IS NOT:** an applied routing config. Current live assignments are tracked separately and are
  NOT auto-changed by these scores. Treat winners as *candidates*, confirm before pinning.

## How to read SCORECARD.md
- **quality** = accuracy on planted ground truth (0–1), separate from cost (per the bakeoff spec).
- **CRIT gate** = hard pre-filter; a model that misses any CRITICAL item is DISQUALIFIED for that
  capability regardless of score.
- **good-enough rule:** cheapest CRIT-pass model with quality ≥ 0.85 × best non-ceiling AND ≥ 0.75
  absolute. Else → keep the incumbent (usually Claude).
- **confidence:** SATURATED (fixture too easy to discriminate) / LOW / MEDIUM / HIGH.

## Cost order (operator subscription, cheapest → priciest)
gemini ≈ agy (monthly subs, ~free) < opencode-go (own pool) < haiku < sonnet < opus / gpt (ceiling refs).

## Methodology
See `overstory-sandbox/docs/superpowers/specs/2026-05-30-model-routing-bakeoff-design.md` and
`overstory-sandbox/artifacts/model-routing-bakeoff-*/`. Bias controls: deterministic CRIT-gate
scoring, n=3 runoff for variance, randomized run order, codex (GPT) adversarial co-author +
blind cross-score, per-run manifest/env-audit, quality scored independent of cost.
