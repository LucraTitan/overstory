/**
 * F2 — exactly-once metrics finalizer for `ov drive`.
 *
 * Headless spawn-per-turn agents never get a Stop-hook-driven session-end
 * metrics record the way tmux-mode agents do (`ov log session-end`, see
 * `src/commands/log.ts`) — a one-shot `claude -p` invocation has no
 * interactive "session end" to hook into. `ov drive` is the first caller
 * that needs a metrics row for a headless agent, so this module owns that.
 *
 * Token usage: each spawn-per-turn agent can get a DIFFERENT
 * `claudeSessionId` per turn (`TurnResult.resumeMismatch`), so correct
 * aggregation requires summing `parseTranscriptUsage()` across every
 * distinct session id observed for that agent (the caller tracks the set
 * across `spawnHeadlessSession`'s first turn + every `dispatchUnreadOnce`
 * turn and passes it in here at finalize time).
 *
 * Transcript path: constructed directly from the agent's WORKTREE path (not
 * the repo root) because spawn-per-turn turns run with `cwd: worktreePath`
 * (`src/agents/turn-runner.ts`), so that is the CWD Claude Code keys its
 * `~/.claude/projects/<cwd-with-slashes-as-dashes>/` transcript directory
 * on. `src/commands/log.ts`'s `resolveTranscriptPath` uses the repo root
 * instead (correct for the coordinator's own tmux-mode transcript) and
 * falls back to a full directory search when that misses. This finalizer
 * intentionally does NOT replicate that full-directory-search fallback
 * (leaner scope) — a transcript that can't be found at the direct
 * worktree-keyed path contributes zero usage for that turn rather than
 * triggering an exhaustive scan. Documented gap, not a silent bug.
 *
 * Schema note: `SessionMetrics` has no turn-count field. The `metrics.db`
 * `sessions` table's PK is `(agent_name, task_id, run_id)` (widened from
 * `(agent_name, task_id)` — see `metrics/store.ts`'s
 * `migrateCompositeKeyWithRunId` — so a second `ov drive` run of the same
 * seed no longer overwrites the first run's row via `INSERT OR REPLACE`)
 * this finalizer always populates `runId` so that key is meaningful (turn
 * counts are reported in `DriveResult.agents[].turns` instead, not
 * persisted to metrics.db — recording what's available, per spec).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolutionTier, SessionMetrics } from "../types.ts";
import { estimateCost, type TokenUsage } from "./pricing.ts";
import { parseTranscriptUsage, type TranscriptUsage } from "./transcript.ts";

/** Test-injectable seams. Production defaults to the real implementations. */
export interface DriveMetricsDeps {
	/** Required: production wires this to a real `MetricsStore.recordSession`. */
	recordSessionFn: (metrics: SessionMetrics) => void;
	/** Test injection: replaces `parseTranscriptUsage`. */
	parseTranscriptUsageFn?: (transcriptPath: string) => Promise<TranscriptUsage>;
	/** Test injection: replaces `estimateCost`. */
	estimateCostFn?: (usage: TokenUsage) => number | null;
	/** Test injection: time source for `completedAt`/`durationMs`. */
	now?: () => number;
}

/** Everything {@link finalizeAgentMetrics} needs to compose one `SessionMetrics` row. */
export interface FinalizeAgentMetricsParams {
	agentName: string;
	capability: string;
	taskId: string;
	runId: string | null;
	parentAgent: string | null;
	/** ISO timestamp the agent's first turn started. */
	startedAt: string;
	/** The agent's worktree path — used as the transcript-directory key. */
	worktreePath: string;
	/** Distinct `claudeSessionId`s observed across all of this agent's turns. */
	claudeSessionIds: readonly string[];
	/** Exit code of the agent's LAST turn (`null` if aborted before exit). */
	exitCode: number | null;
	mergeResult: ResolutionTier | null;
}

const ZERO_USAGE: TokenUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
	modelUsed: null,
};

/** Build the direct-construction transcript path for one turn's Claude session id. */
function transcriptPathFor(worktreePath: string, claudeSessionId: string): string {
	const projectKey = worktreePath.replace(/\//g, "-");
	return join(homedir(), ".claude", "projects", projectKey, `${claudeSessionId}.jsonl`);
}

/** Sum token usage across every transcript for the given session ids. Missing/unreadable transcripts contribute zero (non-fatal). */
async function aggregateUsage(
	worktreePath: string,
	claudeSessionIds: readonly string[],
	parseFn: (transcriptPath: string) => Promise<TranscriptUsage>,
): Promise<TokenUsage> {
	let usage: TokenUsage = { ...ZERO_USAGE };

	for (const sessionId of claudeSessionIds) {
		const transcriptPath = transcriptPathFor(worktreePath, sessionId);
		try {
			const turnUsage = await parseFn(transcriptPath);
			usage = {
				inputTokens: usage.inputTokens + turnUsage.inputTokens,
				outputTokens: usage.outputTokens + turnUsage.outputTokens,
				cacheReadTokens: usage.cacheReadTokens + turnUsage.cacheReadTokens,
				cacheCreationTokens: usage.cacheCreationTokens + turnUsage.cacheCreationTokens,
				modelUsed: usage.modelUsed ?? turnUsage.modelUsed,
			};
		} catch {
			// Transcript not found / unreadable — contributes zero usage for
			// this turn. See module doc comment: documented gap, not a bug.
		}
	}

	return usage;
}

/**
 * Record exactly one `metrics.db` session row for an agent that has reached
 * a terminal state (or for the run-end sweep of any agent that never did).
 *
 * Exactly-once guard: callers pass a `finalizedAgentNames` Set shared across
 * the whole `ov drive` invocation. A second call for the same agent name is
 * a silent no-op — this makes it safe to call both at per-agent-terminal
 * time AND once more at run-end without double-recording.
 */
export async function finalizeAgentMetrics(
	params: FinalizeAgentMetricsParams,
	finalizedAgentNames: Set<string>,
	deps: DriveMetricsDeps,
): Promise<void> {
	if (finalizedAgentNames.has(params.agentName)) {
		return;
	}

	const parseFn = deps.parseTranscriptUsageFn ?? parseTranscriptUsage;
	const estimateFn = deps.estimateCostFn ?? estimateCost;
	const now = deps.now ?? Date.now;

	const usage = await aggregateUsage(params.worktreePath, params.claudeSessionIds, parseFn);
	const estimatedCostUsd = usage.modelUsed !== null ? estimateFn(usage) : null;

	const completedAtMs = now();
	const completedAt = new Date(completedAtMs).toISOString();
	const startedAtMs = new Date(params.startedAt).getTime();
	const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, completedAtMs - startedAtMs) : 0;

	const metrics: SessionMetrics = {
		agentName: params.agentName,
		taskId: params.taskId,
		capability: params.capability,
		startedAt: params.startedAt,
		completedAt,
		durationMs,
		exitCode: params.exitCode,
		mergeResult: params.mergeResult,
		parentAgent: params.parentAgent,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheCreationTokens: usage.cacheCreationTokens,
		estimatedCostUsd,
		modelUsed: usage.modelUsed,
		runId: params.runId,
	};

	// Guard is set ONLY after a successful write (HIGH 6): a thrown
	// recordSessionFn must leave the agent name unmarked so a later retry
	// within the same run can still succeed, instead of being permanently
	// suppressed by a write that never actually landed.
	deps.recordSessionFn(metrics);
	finalizedAgentNames.add(params.agentName);
}
