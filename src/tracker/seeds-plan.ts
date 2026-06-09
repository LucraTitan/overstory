/**
 * SeedsPlanClient: executes render operations against the `sd` CLI.
 *
 * Handles create + planSubmit with optional --overwrite.
 * Injectable spawn for testing (no real sd calls in tests).
 */

import { AgentError } from "../errors.ts";
import type { CreateOp, PlanSubmitOp } from "../ingest/render.ts";

/** Envelope returned by `sd create --json` */
interface SdCreateEnvelope {
	success: boolean;
	command: string;
	id?: string;
	issue?: { id: string };
	error?: string;
}

/** Envelope returned by `sd plan submit --json` */
interface SdPlanSubmitEnvelope {
	success: boolean;
	command: string;
	plan_id: string;
	children: string[];
	parent_seed: string;
	revision: number;
	obsolete: string[];
	overwritten: boolean;
	error?: string;
}

export interface PlanSubmitResult {
	planId: string;
	children: string[];
	obsolete: string[];
}

type SpawnFn = typeof Bun.spawn;

export interface SeedsPlanClient {
	/**
	 * Execute a create operation. If `existingSeedId` is set, returns it without
	 * calling sd (reconcile adopt).
	 */
	executeCreate(op: CreateOp): Promise<string>;

	/**
	 * Execute a planSubmit operation, feeding the plan JSON via stdin.
	 */
	executePlanSubmit(parentId: string, op: PlanSubmitOp): Promise<PlanSubmitResult>;
}

/**
 * Parse JSON from sd output, stripping any non-JSON prefix lines.
 */
function parseSdJson<T>(stdout: string, context: string): T {
	const trimmed = stdout.trim();
	if (trimmed === "") {
		throw new AgentError(`Empty output from sd ${context}`);
	}
	const jsonStart = trimmed.search(/[{[]/);
	const jsonStr = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
	try {
		return JSON.parse(jsonStr) as T;
	} catch {
		throw new AgentError(
			`Failed to parse JSON output from sd ${context}: ${trimmed.slice(0, 200)}`,
		);
	}
}

/**
 * Create a SeedsPlanClient.
 *
 * @param cwd - Working directory for sd commands.
 * @param spawnFn - Injectable spawn function (defaults to Bun.spawn). Override in tests.
 */
export function createSeedsPlanClient(cwd: string, spawnFn: SpawnFn = Bun.spawn): SeedsPlanClient {
	async function runSd(
		args: string[],
		context: string,
		stdinPayload?: string,
	): Promise<{ stdout: string; stderr: string }> {
		const proc = spawnFn(["sd", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			stdin: stdinPayload !== undefined ? "pipe" : undefined,
		});

		// Write stdin if provided (FileSink API: .write() + .end())
		if (stdinPayload !== undefined && proc.stdin) {
			// Bun FileSink has .write(data) and .end()
			const sink = proc.stdin as {
				write: (data: string | Uint8Array) => number | Promise<number>;
				end: () => number | void | Promise<void>;
			};
			sink.write(stdinPayload);
			if (typeof sink.end === "function") {
				sink.end();
			}
		}

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			throw new AgentError(`sd ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
		}
		return { stdout, stderr };
	}

	return {
		async executeCreate(op: CreateOp): Promise<string> {
			// Reconcile adopt: skip sd call
			if (op.existingSeedId !== undefined) {
				return op.existingSeedId;
			}

			const { stdout } = await runSd(op.args, "create");
			const envelope = parseSdJson<SdCreateEnvelope>(stdout, "create");
			if (!envelope.success) {
				throw new AgentError(`sd create returned failure: ${envelope.error ?? "unknown error"}`);
			}
			const id = envelope.id ?? envelope.issue?.id;
			if (!id) {
				throw new AgentError("sd create did not return an issue ID");
			}
			return id;
		},

		async executePlanSubmit(parentId: string, op: PlanSubmitOp): Promise<PlanSubmitResult> {
			const planJsonStr = JSON.stringify(op.planJson);

			const args = ["plan", "submit", parentId, "--plan", "-", "--json"];
			if (op.overwrite) {
				args.push("--overwrite");
			}

			const { stdout } = await runSd(args, "plan submit", planJsonStr);
			const envelope = parseSdJson<SdPlanSubmitEnvelope>(stdout, "plan submit");
			if (!envelope.success) {
				throw new AgentError(
					`sd plan submit returned failure: ${envelope.error ?? "unknown error"}`,
				);
			}

			return {
				planId: envelope.plan_id,
				children: envelope.children,
				obsolete: envelope.obsolete,
			};
		},
	};
}
