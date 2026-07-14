/**
 * Structured startup beacon shared by both spawn paths in `ov sling`
 * (tmux and headless spawn-per-turn). Extracted out of `src/commands/sling.ts`
 * (overstory ov-drive-completion Phase 1) so the headless spawn service
 * (`src/agents/headless-session.ts`) can build it without importing back into
 * the CLI command module — that would create a circular dependency, since
 * `sling.ts` imports `spawnHeadlessSession` from `headless-session.ts`.
 *
 * `sling.ts` re-exports `buildBeacon`/`BeaconOptions` from here so its public
 * API (and existing test imports) are unchanged.
 */

/**
 * Options for building the structured startup beacon.
 */
export interface BeaconOptions {
	agentName: string;
	capability: string;
	taskId: string;
	parentAgent: string | null;
	depth: number;
	instructionPath: string;
}

/**
 * Build a structured startup beacon for an agent.
 *
 * The beacon is the first user message sent to a Claude Code agent via
 * tmux send-keys (or, for headless spawn-per-turn agents, folded into the
 * initial prompt). It provides identity context and a numbered startup
 * protocol so the agent knows exactly what to do on boot.
 *
 * Format:
 *   [OVERSTORY] <agent-name> (<capability>) <ISO timestamp> task:<task-id>
 *   Depth: <n> | Parent: <parent-name|none>
 *   Startup protocol:
 *   1. Read your assignment in .claude/CLAUDE.md
 *   2. Load expertise: mulch prime
 *   3. Check mail: ov mail check --agent <name>
 *   4. Begin working on task <task-id>
 */
export function buildBeacon(opts: BeaconOptions): string {
	const timestamp = new Date().toISOString();
	const parent = opts.parentAgent ?? "none";
	const parts = [
		`[OVERSTORY] ${opts.agentName} (${opts.capability}) ${timestamp} task:${opts.taskId}`,
		`Depth: ${opts.depth} | Parent: ${parent}`,
		`Startup: read ${opts.instructionPath}, run mulch prime, check mail (ov mail check --agent ${opts.agentName}), then begin task ${opts.taskId}`,
	];
	return parts.join(" — ");
}
