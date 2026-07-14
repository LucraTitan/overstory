/**
 * Headless agent spawn helper for `ov drive`.
 *
 * `ov drive` needs to spawn exactly two kinds of agent itself: the seed top
 * agent (state-machine step 2) and, during reconcile, a reviewer for each
 * builder branch (step 4). Both need the same caller-side setup `ov sling`
 * performs before it hands off to `spawnHeadlessSession`
 * (`src/agents/headless-session.ts`, ov-drive-completion Phase 1) — worktree
 * creation, overlay generation, hook deployment, auto-dispatch mail, tracker
 * claim, and identity creation.
 *
 * DELIBERATE DESIGN DECISION (documented per the Phase 2 spec's explicit
 * "factor or replicate, and note it" permission): this module REPLICATES the
 * imperative sequencing rather than factoring it out of `sling.ts`, because
 * that sequencing is entangled with `sling.ts`'s CLI-option parsing and is
 * not itself reusable as a unit. It DOES reuse every already-exported *pure*
 * helper `sling.ts` offers for the pieces that overlap (`validateHierarchy`,
 * `checkRunSessionLimit`, `checkParentAgentLimit`, `checkTaskLock`,
 * `buildAutoDispatch`, `resolveUseHeadless`, `isTaskWorkable`) instead of
 * re-implementing their logic — only the glue is new.
 *
 * LEANER SCOPE (documented gaps, intentionally omitted vs. `ov sling`):
 *  - No mulch file-scope expertise fetch (`config.mulch` priming).
 *  - No canopy profile rendering.
 *  - No `siblings` propagation.
 *  - No spec-file loading (`ov drive` has no `--spec` flag).
 *  - No inter-spawn stagger delay (drive spawns at most a handful of agents
 *    per run — the burst-throttling stagger delay exists for swarms).
 *  - No `applied-records.json` mulch-outcome tracking (depends on mulch
 *    expertise, which is skipped above).
 * None of these affect correctness of the drive state machine; they trade
 * away supplementary context/telemetry that an interactive `ov sling` caller
 * would normally provide.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnHeadlessSession } from "../agents/headless-session.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { resolveModel } from "../agents/manifest.ts";
import { writeOverlay } from "../agents/overlay.ts";
import type { TurnResult, TurnSpawnFn } from "../agents/turn-runner.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { getRuntime } from "../runtimes/registry.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { TrackerClient } from "../tracker/types.ts";
import type { AgentManifest, AgentSession, OverlayConfig, OverstoryConfig } from "../types.ts";
import { createWorktree, rollbackWorktree } from "../worktree/manager.ts";
import {
	buildAutoDispatch,
	checkParentAgentLimit,
	checkRunSessionLimit,
	checkTaskLock,
	generateAgentName,
	isTaskWorkable,
	resolveUseHeadless,
	validateHierarchy,
} from "./sling.ts";

/** Everything {@link spawnDriveAgent} needs to spawn one headless agent under a drive run. */
export interface SpawnDriveAgentParams {
	/** Preferred agent name; de-duplicated against active sessions if taken. */
	requestedName: string;
	capability: string;
	taskId: string;
	/** Null for the seed top agent (direct spawn); the top agent's name for a reviewer. */
	parentAgent: string | null;
	depth: number;
	runId: string;
	baseBranch: string;
	config: OverstoryConfig;
	manifest: AgentManifest;
	store: SessionStore;
	tracker: TrackerClient;
	trackerCliName: string;
	trackerBackendName: string;
	/** `OVERSTORY_AGENT_NAME` of whatever is invoking drive (usually unset -> "orchestrator"). */
	slingerName: string | null;
	/** Skip the tracker workability check (mirrors `ov sling --skip-task-check`). */
	skipTaskCheck?: boolean;
	/** Test injection: forwarded to `runTurn` via `spawnHeadlessSession`. */
	_spawnFn?: TurnSpawnFn;
	/**
	 * Forwarded to `spawnHeadlessSession` -> `runTurn` (HIGH-2). `ov drive`
	 * arms one `AbortController` at its wall-clock deadline and threads it
	 * through every direct spawn so an in-flight turn is killed promptly at
	 * the deadline.
	 */
	abortSignal?: AbortSignal;
}

/** Result of a successful {@link spawnDriveAgent} call. */
export interface SpawnDriveAgentResult {
	agentName: string;
	branchName: string;
	worktreePath: string;
	firstTurn: TurnResult;
}

/**
 * Spawn one headless spawn-per-turn agent for an `ov drive` run, performing
 * the same pre-spawn guards `ov sling` enforces (hierarchy, per-run session
 * limit, concurrency ceiling, per-lead ceiling, task lock, task workability)
 * before creating the worktree and delegating to `spawnHeadlessSession`.
 *
 * Throws (never silently skips) on any guard violation — the caller decides
 * how to translate that into a drive outcome.
 */
export async function spawnDriveAgent(
	params: SpawnDriveAgentParams,
): Promise<SpawnDriveAgentResult> {
	const {
		requestedName,
		capability,
		taskId,
		parentAgent,
		depth,
		runId,
		baseBranch,
		config,
		manifest,
		store,
		tracker,
		trackerCliName,
		trackerBackendName,
		slingerName,
		skipTaskCheck,
		abortSignal,
	} = params;

	if (depth > config.agents.maxDepth) {
		throw new AgentError(
			`Depth limit exceeded: depth ${depth} > maxDepth ${config.agents.maxDepth}`,
			{ agentName: requestedName },
		);
	}
	validateHierarchy(parentAgent, capability, requestedName, depth, false);

	const agentDef = manifest.agents[capability];
	if (!agentDef) {
		throw new AgentError(
			`Unknown capability "${capability}". Available: ${Object.keys(manifest.agents).join(", ")}`,
			{ agentName: requestedName, capability },
		);
	}

	if (config.agents.maxSessionsPerRun > 0) {
		const runAgentCount = store.getByRun(runId).length;
		if (checkRunSessionLimit(config.agents.maxSessionsPerRun, runAgentCount)) {
			throw new AgentError(
				`Run session limit reached: ${runAgentCount}/${config.agents.maxSessionsPerRun} agents spawned in run "${runId}".`,
				{ agentName: requestedName },
			);
		}
	}

	const activeSessions = store.getActive();
	if (activeSessions.length >= config.agents.maxConcurrent) {
		throw new AgentError(
			`Max concurrent agent limit reached: ${activeSessions.length}/${config.agents.maxConcurrent} active agents`,
			{ agentName: requestedName },
		);
	}

	const takenNames = activeSessions.map((s) => s.agentName);
	const agentName = generateAgentName(capability, taskId, takenNames);

	const lockHolder = checkTaskLock(activeSessions, taskId);
	if (lockHolder !== null && lockHolder !== parentAgent) {
		throw new AgentError(`Task "${taskId}" is already being worked by agent "${lockHolder}".`, {
			agentName,
		});
	}

	if (parentAgent !== null) {
		if (checkParentAgentLimit(activeSessions, parentAgent, config.agents.maxAgentsPerLead)) {
			throw new AgentError(
				`Per-lead agent limit reached: "${parentAgent}" has reached ${config.agents.maxAgentsPerLead} active children.`,
				{ agentName },
			);
		}
	}

	if (config.taskTracker.enabled && !skipTaskCheck) {
		const issue = await tracker.show(taskId).catch((err) => {
			throw new AgentError(`Task "${taskId}" not found or inaccessible`, {
				agentName,
				cause: err instanceof Error ? err : undefined,
			});
		});
		if (!isTaskWorkable(issue.status, false)) {
			throw new ValidationError(`Task "${taskId}" is not workable (status: ${issue.status}).`, {
				field: "taskId",
				value: taskId,
			});
		}
	}

	const worktreeBaseDir = join(config.project.root, config.worktrees.baseDir);
	await mkdir(worktreeBaseDir, { recursive: true });

	const { path: worktreePath, branch: branchName } = await createWorktree({
		repoRoot: config.project.root,
		baseDir: worktreeBaseDir,
		agentName,
		baseBranch,
		taskId,
	});

	try {
		const agentDefPath = join(config.project.root, config.agents.baseDir, agentDef.file);
		const baseDefinition = await Bun.file(agentDefPath).text();

		const runtime = getRuntime(undefined, config, capability);
		if (runtime.prepareWorktree) {
			await runtime.prepareWorktree(worktreePath);
		}
		// ov drive is headless-only (no tmux path exists in this command).
		// resolveUseHeadless(runtime, true, config) throws a ValidationError
		// when the resolved runtime can't do a direct spawn; called here purely
		// for its validation side effect, matching `ov sling --headless`.
		resolveUseHeadless(runtime, true, config);

		const overlayConfig: OverlayConfig = {
			agentName,
			taskId,
			specPath: null,
			branchName,
			worktreePath,
			fileScope: [],
			mulchDomains: [],
			parentAgent,
			depth,
			canSpawn: agentDef.canSpawn,
			capability,
			baseDefinition,
			qualityGates: config.project.qualityGates,
			trackerCli: trackerCliName,
			trackerName: trackerBackendName,
			instructionPath: runtime.instructionPath,
		};
		await writeOverlay(worktreePath, overlayConfig, config.project.root, runtime.instructionPath);

		const resolvedModel = resolveModel(config, manifest, capability, agentDef.model);

		await runtime.deployConfig(worktreePath, undefined, {
			agentName,
			capability,
			worktreePath,
			qualityGates: config.project.qualityGates,
			isHeadless: true,
		});

		const overstoryDir = join(config.project.root, ".overstory");
		const dispatch = buildAutoDispatch({
			agentName,
			taskId,
			capability,
			specPath: null,
			parentAgent,
			slingerName,
			instructionPath: runtime.instructionPath,
		});
		const mailStore = createMailStore(join(overstoryDir, "mail.db"));
		try {
			createMailClient(mailStore).send({
				from: dispatch.from,
				to: dispatch.to,
				subject: dispatch.subject,
				body: dispatch.body,
				type: "dispatch",
				priority: "normal",
			});
		} finally {
			mailStore.close();
		}

		if (config.taskTracker.enabled && !skipTaskCheck) {
			try {
				await tracker.claim(taskId);
			} catch {
				// Non-fatal: issue may already be claimed.
			}
		}

		const identityBaseDir = join(overstoryDir, "agents");
		const existingIdentity = await loadIdentity(identityBaseDir, agentName);
		if (!existingIdentity) {
			await createIdentity(identityBaseDir, {
				name: agentName,
				capability,
				created: new Date().toISOString(),
				sessionsCompleted: 0,
				expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
				recentTasks: [],
			});
		}

		const existingSession: AgentSession | null = null;

		const { firstTurn } = await spawnHeadlessSession({
			agentName,
			capability,
			taskId,
			overstoryDir,
			worktreePath,
			projectRoot: config.project.root,
			branchName,
			parentAgent,
			depth,
			runtime,
			resolvedModel,
			runId,
			store,
			existingSession,
			_spawnFn: params._spawnFn,
			...(abortSignal !== undefined ? { abortSignal } : {}),
		});

		return { agentName, branchName, worktreePath, firstTurn };
	} catch (err) {
		await rollbackWorktree(config.project.root, worktreePath, branchName);
		// HIGH-5: spawnHeadlessSession upserts a "booting" session row BEFORE
		// driving the first turn; if the turn itself then throws, that row
		// survives pointing at the worktree just deleted above. The driver
		// (`ov drive`) is the sole owner of seed closure/session lifecycle for
		// its run — terminalize any such orphaned row here so a live session
		// never outlives its worktree.
		const staleSession = store.getByName(agentName);
		if (staleSession && staleSession.state !== "completed" && staleSession.state !== "zombie") {
			store.updateState(agentName, "zombie");
		}
		throw err;
	}
}
