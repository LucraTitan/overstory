/**
 * CLI command: ov ingest
 *
 * Consumes a normalized-plan JSON (from /ov-ingest skill) and drives `sd` to
 * create or reconcile seeds. Implements the behavior table from contract §3.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { classifySource, loadManifest, saveManifest } from "../ingest/manifest.ts";
import { renderOperations } from "../ingest/render.ts";
import type {
	IngestionManifest,
	ManifestGroupEntry,
	ManifestPlanEntry,
	ManifestSourceEntry,
	ManifestStandaloneEntry,
	NormalizedGroup,
	NormalizedPlan,
} from "../ingest/schema.ts";
import { validateNormalizedPlan } from "../ingest/validate.ts";
import { jsonOutput } from "../json.ts";
import type { SeedsPlanClient } from "../tracker/seeds-plan.ts";
import { createSeedsPlanClient } from "../tracker/seeds-plan.ts";

export interface IngestOptions {
	plan: string; // file path or "-" for stdin
	apply?: boolean;
	dryRun?: boolean; // alias for no --apply (contract §3)
	newPlan?: boolean;
	manifest?: string;
	cwd?: string;
	json?: boolean;
}

export type SourceState = "new" | "unchanged" | "changed";

export interface IngestResult {
	exitCode: number;
	mode: "apply" | "preview";
	sourceState: SourceState;
	created: string[];
	planIds: string[];
	commands: string[];
	warnings: string[];
	manifestPath: string;
}

/**
 * Main ingest handler. Accepts an injectable SeedsPlanClient for testing.
 */
export async function ingestCommand(
	opts: IngestOptions,
	clientOverride?: SeedsPlanClient,
): Promise<IngestResult> {
	const cwd = resolve(opts.cwd ?? process.cwd());
	const manifestPath = opts.manifest ?? join(cwd, ".overstory", "ingestion-manifest.json");
	// B3: --dry-run is an alias for "no --apply"
	const apply = (opts.apply ?? false) && !(opts.dryRun ?? false);
	const newPlan = opts.newPlan ?? false;
	const useJson = opts.json ?? false;

	// --- Load and parse plan JSON ---
	let rawPlan: NormalizedPlan;
	try {
		const planContent = await loadPlanContent(opts.plan);
		rawPlan = JSON.parse(planContent) as NormalizedPlan;
	} catch (err: unknown) {
		const msg =
			err instanceof SyntaxError
				? `Invalid plan JSON: ${err.message}`
				: `Failed to read plan: ${String(err)}`;
		if (useJson) {
			jsonOutput("ingest", { ok: false, error: msg });
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		return makeResult(1, "preview", "new", [], [], [], [msg], manifestPath);
	}

	// --- Validate ---
	const validation = validateNormalizedPlan(rawPlan);
	if (!validation.ok) {
		const errs = validation.errors;
		if (useJson) {
			jsonOutput("ingest", { ok: false, errors: errs });
		} else {
			for (const e of errs) {
				process.stderr.write(`Validation error: ${e}\n`);
			}
		}
		return makeResult(1, "preview", "new", [], [], [], errs, manifestPath);
	}

	// --- Compute content hash + classify source ---
	// Use the hash from the plan's source field (the skill-computed hash of the ORIGINAL doc)
	const sourceHash = rawPlan.source.contentHash;
	const sourcePath = rawPlan.source.path;

	const manifest = await loadManifest(manifestPath);
	const sourceState = classifySource(manifest, sourcePath, sourceHash);

	// Build warnings from ambiguities + low-confidence units
	const warnings = collectWarnings(rawPlan);

	// Build commands for preview/apply
	const existingManifestGroups =
		sourceState !== "new" ? buildManifestEntryMap(manifest, sourcePath) : {};

	const { operations, commands } = renderOperations(rawPlan, existingManifestGroups);

	const mode: "apply" | "preview" = apply ? "apply" : "preview";

	// --- Behavior table ---

	// --new-plan: top-level override — evaluated FIRST, before source classification.
	// Forces fresh-create for any source state (new/unchanged/changed).
	// Preview: render fresh-create + exit 0. Apply: fresh-create + overwrite manifest entry + exit 0.
	if (newPlan) {
		// Always render as fresh (no manifest entries passed → empty map)
		const { operations: freshOps, commands: freshCmds } = renderOperations(rawPlan, {});

		if (!apply) {
			if (!useJson) {
				process.stdout.write(`[--new-plan] Preview — would fresh-create for '${sourcePath}':\n`);
				for (const cmd of freshCmds) {
					process.stdout.write(`  ${cmd}\n`);
				}
				process.stdout.write("\nRe-run with --apply to execute.\n");
			} else {
				const result = makeResult(0, mode, sourceState, [], [], freshCmds, warnings, manifestPath);
				jsonOutput("ingest", toJsonEnvelope(result, false));
			}
			return makeResult(0, mode, sourceState, [], [], freshCmds, warnings, manifestPath);
		}

		// Apply with --new-plan: fresh-create, overwrite manifest entry
		for (const w of warnings) {
			process.stderr.write(`Warning: ${w}\n`);
		}
		const freshClient = clientOverride ?? createSeedsPlanClient(cwd);
		const freshCreated: string[] = [];
		const freshPlanIds: string[] = [];
		const freshLogicalIdToSeedId = new Map<string, string>();
		interface PlanInfo {
			planId: string;
			children: string[];
			obsolete: string[];
			unitIds: Map<string, string>;
		}
		const freshPlanInfoMap = new Map<string, PlanInfo>();

		// FIX 1: track started groups for partial-failure manifest (same atomicity fix as main loop).
		const freshStartedGroups: NormalizedGroup[] = [];

		let freshOpIndex = 0;
		try {
			for (const group of rawPlan.groups) {
				if (group.kind === "standalone") {
					const op = freshOps[freshOpIndex++];
					if (op === undefined || op.op !== "create") continue;
					const seedId = await freshClient.executeCreate(op);
					freshCreated.push(seedId);
					freshLogicalIdToSeedId.set(group.logicalId, seedId);
					freshStartedGroups.push(group);
				} else if (group.kind === "plan") {
					const createOp = freshOps[freshOpIndex++];
					if (createOp === undefined || createOp.op !== "create") continue;
					const parentId = await freshClient.executeCreate(createOp);
					freshCreated.push(parentId);
					freshLogicalIdToSeedId.set(group.logicalId, parentId);

					// FIX 1: record parent in startedGroups IMMEDIATELY after create succeeds, before
					// plan submit. If plan submit then fails, the partial manifest records the seedId
					// so a re-run can ADOPT the parent (no duplicate orphan).
					freshStartedGroups.push(group);

					const submitOp = freshOps[freshOpIndex++];
					if (submitOp === undefined || submitOp.op !== "planSubmit") continue;
					const submitResult = await freshClient.executePlanSubmit(parentId, submitOp);
					freshPlanIds.push(submitResult.planId);
					freshCreated.push(...submitResult.children);

					// B2: surface obsolete units as warnings
					for (const obsoleteId of submitResult.obsolete) {
						warnings.push(`obsolete unit ${obsoleteId} (dropped from plan)`);
					}

					const unitIdMap = new Map<string, string>();
					group.units.forEach((unit, i) => {
						const childId = submitResult.children[i];
						if (childId !== undefined) {
							unitIdMap.set(unit.logicalId, childId);
						}
					});
					freshPlanInfoMap.set(group.logicalId, {
						planId: submitResult.planId,
						children: submitResult.children,
						obsolete: submitResult.obsolete,
						unitIds: unitIdMap,
					});
				}
			}
		} catch (applyErr: unknown) {
			// B1: partial failure — write PARTIAL manifest for started groups, then re-throw.
			// partial:true ensures a re-run classifies as "changed" and reconciles (never no-ops).
			if (freshStartedGroups.length > 0) {
				const partialIngestedAt = new Date().toISOString();
				const partialManifest = updateManifest(
					manifest,
					sourcePath,
					sourceHash,
					partialIngestedAt,
					freshStartedGroups,
					freshLogicalIdToSeedId,
					freshPlanInfoMap,
					true, // partial — forces reconcile on re-run
				);
				try {
					await saveManifest(manifestPath, partialManifest);
				} catch {
					// Best-effort; suppress save error so original error propagates
				}
				const partialIds = freshCreated.join(", ");
				const errMsg = applyErr instanceof Error ? applyErr.message : String(applyErr);
				throw new Error(
					`Partial ingest failure after creating [${partialIds}]. ` +
						`Manifest written for started groups — re-run to reconcile remaining. ` +
						`Original error: ${errMsg}`,
				);
			}
			throw applyErr;
		}

		const freshIngestedAt = new Date().toISOString();
		const freshManifest = updateManifest(
			manifest,
			sourcePath,
			sourceHash,
			freshIngestedAt,
			rawPlan.groups,
			freshLogicalIdToSeedId,
			freshPlanInfoMap,
		);
		await saveManifest(manifestPath, freshManifest);

		if (!useJson) {
			process.stdout.write(
				`[--new-plan] Fresh-created '${sourcePath}': ${freshCreated.length} seeds.\n`,
			);
		} else {
			const result = makeResult(
				0,
				mode,
				sourceState,
				freshCreated,
				freshPlanIds,
				freshCmds,
				warnings,
				manifestPath,
			);
			jsonOutput("ingest", toJsonEnvelope(result, true));
		}
		return makeResult(
			0,
			mode,
			sourceState,
			freshCreated,
			freshPlanIds,
			freshCmds,
			warnings,
			manifestPath,
		);
	}

	// Unchanged: no-op regardless of apply flag
	if (sourceState === "unchanged") {
		if (!useJson) {
			process.stdout.write(
				`Source '${sourcePath}' already ingested (unchanged). No action needed.\n`,
			);
		} else {
			const result: IngestResult = makeResult(
				0,
				mode,
				"unchanged",
				[],
				[],
				commands,
				warnings,
				manifestPath,
			);
			jsonOutput("ingest", toJsonEnvelope(result, true));
		}
		return makeResult(0, mode, "unchanged", [], [], commands, warnings, manifestPath);
	}

	// Changed without --apply: refuse (exit non-zero)
	if (sourceState === "changed" && !apply && !newPlan) {
		const msg = `Source '${sourcePath}' has changed since last ingest. Re-run with --apply to reconcile.`;
		if (useJson) {
			jsonOutput("ingest", {
				ok: false,
				mode,
				sourceState,
				commands,
				warnings,
				manifestPath,
				message: msg,
			});
		} else {
			process.stderr.write(`${msg}\n`);
			process.stdout.write("Preview of reconcile commands:\n");
			for (const cmd of commands) {
				process.stdout.write(`  ${cmd}\n`);
			}
		}
		return makeResult(1, mode, "changed", [], [], commands, warnings, manifestPath);
	}

	// Preview only (no --apply): show commands and exit 0
	if (!apply) {
		if (!useJson) {
			process.stdout.write(`Preview — would run the following sd commands for '${sourcePath}':\n`);
			for (const cmd of commands) {
				process.stdout.write(`  ${cmd}\n`);
			}
			process.stdout.write("\nRe-run with --apply to execute.\n");
		} else {
			const result = makeResult(0, mode, sourceState, [], [], commands, warnings, manifestPath);
			jsonOutput("ingest", toJsonEnvelope(result, false));
		}
		return makeResult(0, mode, sourceState, [], [], commands, warnings, manifestPath);
	}

	// --- Apply ---

	// Emit ambiguity warnings to stderr
	for (const w of warnings) {
		process.stderr.write(`Warning: ${w}\n`);
	}

	const client = clientOverride ?? createSeedsPlanClient(cwd);
	const created: string[] = [];
	const planIds: string[] = [];

	// Track logicalId → seedId for manifest
	const logicalIdToSeedId = new Map<string, string>();

	// Track plan-level info
	interface PlanInfo {
		planId: string;
		children: string[];
		obsolete: string[];
		unitIds: Map<string, string>; // logicalId → seedId for units
	}
	const planInfoMap = new Map<string, PlanInfo>();

	// FIX 1: track started groups (includes plan groups whose parent was created but submit
	// hasn't completed yet). This is the set we write to the partial manifest on failure.
	// A plan group is added to startedGroups the moment its parent sd create succeeds, so if
	// plan submit then fails, the partial manifest records the parent seedId (pending entry,
	// no planId) and a re-run can ADOPT the existing parent rather than creating a duplicate.
	const startedGroups: NormalizedGroup[] = [];

	// Execute operations in order
	let opIndex = 0;
	try {
		for (const group of rawPlan.groups) {
			if (group.kind === "standalone") {
				const op = operations[opIndex++];
				if (op === undefined || op.op !== "create") continue;
				const seedId = await client.executeCreate(op);
				created.push(seedId);
				logicalIdToSeedId.set(group.logicalId, seedId);
				startedGroups.push(group);
			} else if (group.kind === "plan") {
				// Create (parent)
				const createOp = operations[opIndex++];
				if (createOp === undefined || createOp.op !== "create") continue;
				const parentId = await client.executeCreate(createOp);
				created.push(parentId);
				logicalIdToSeedId.set(group.logicalId, parentId);

				// FIX 1: record parent in startedGroups IMMEDIATELY after create succeeds, before
				// plan submit. If plan submit then fails, the partial manifest includes a pending
				// entry with seedId (no planId), so a re-run adopts the parent (no duplicate).
				startedGroups.push(group);

				const submitOp = operations[opIndex++];
				if (submitOp === undefined || submitOp.op !== "planSubmit") continue;
				const submitResult = await client.executePlanSubmit(parentId, submitOp);
				planIds.push(submitResult.planId);
				created.push(...submitResult.children);

				// B2: surface obsolete units as warnings
				for (const obsoleteId of submitResult.obsolete) {
					warnings.push(`obsolete unit ${obsoleteId} (dropped from plan)`);
				}

				// Map children back to units by step order
				const unitIdMap = new Map<string, string>();
				group.units.forEach((unit, i) => {
					const childId = submitResult.children[i];
					if (childId !== undefined) {
						unitIdMap.set(unit.logicalId, childId);
					}
				});

				planInfoMap.set(group.logicalId, {
					planId: submitResult.planId,
					children: submitResult.children,
					obsolete: submitResult.obsolete,
					unitIds: unitIdMap,
				});
			}
		}
	} catch (applyErr: unknown) {
		// B1: partial failure — write PARTIAL manifest for started groups, then re-throw.
		// partial:true ensures a re-run classifies as "changed" and reconciles (never no-ops).
		// Plan groups whose parent was created but submit failed get a pending manifest entry
		// (seedId, no planId) so re-runs adopt the parent instead of creating a duplicate.
		if (startedGroups.length > 0) {
			const partialIngestedAt = new Date().toISOString();
			const partialManifest = updateManifest(
				manifest,
				sourcePath,
				sourceHash,
				partialIngestedAt,
				startedGroups,
				logicalIdToSeedId,
				planInfoMap,
				true, // partial — forces reconcile on re-run
			);
			try {
				await saveManifest(manifestPath, partialManifest);
			} catch {
				// Best-effort; suppress save error so original error propagates
			}
			const partialIds = created.join(", ");
			const errMsg = applyErr instanceof Error ? applyErr.message : String(applyErr);
			throw new Error(
				`Partial ingest failure after creating [${partialIds}]. ` +
					`Manifest written for started groups — re-run to reconcile remaining. ` +
					`Original error: ${errMsg}`,
			);
		}
		throw applyErr;
	}

	// Write manifest
	const ingestedAt = new Date().toISOString();
	const newManifest = updateManifest(
		manifest,
		sourcePath,
		sourceHash,
		ingestedAt,
		rawPlan.groups,
		logicalIdToSeedId,
		planInfoMap,
	);
	await saveManifest(manifestPath, newManifest);

	if (!useJson) {
		process.stdout.write(`Ingested '${sourcePath}': ${created.length} seeds created.\n`);
	} else {
		const result = makeResult(
			0,
			mode,
			sourceState,
			created,
			planIds,
			commands,
			warnings,
			manifestPath,
		);
		jsonOutput("ingest", toJsonEnvelope(result, true));
	}

	return makeResult(0, mode, sourceState, created, planIds, commands, warnings, manifestPath);
}

// --- helpers ---

async function loadPlanContent(planArg: string): Promise<string> {
	if (planArg === "-") {
		// Read from stdin
		const chunks: Uint8Array[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(chunk as Uint8Array);
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	return readFile(planArg, "utf8");
}

function collectWarnings(plan: NormalizedPlan): string[] {
	const warnings: string[] = [];
	for (const ambiguity of plan.ambiguities) {
		warnings.push(`[${ambiguity.logicalId}] ${ambiguity.issue}`);
	}
	for (const group of plan.groups) {
		if (group.confidence === "low") {
			warnings.push(`Low confidence: group '${group.logicalId}' (${group.title})`);
		}
		if (group.kind === "plan") {
			for (const unit of group.units) {
				if (unit.confidence === "low") {
					warnings.push(`Low confidence: unit '${unit.logicalId}' in group '${group.logicalId}'`);
				}
			}
		}
	}
	return warnings;
}

function buildManifestEntryMap(
	manifest: IngestionManifest,
	sourcePath: string,
): Record<string, ManifestGroupEntry> {
	const entry = manifest.sources[sourcePath];
	if (entry === undefined) return {};
	const map: Record<string, ManifestGroupEntry> = {};
	for (const g of entry.groups) {
		map[g.logicalId] = g;
	}
	return map;
}

function updateManifest(
	manifest: IngestionManifest,
	sourcePath: string,
	contentHash: string,
	ingestedAt: string,
	groups: NormalizedGroup[],
	logicalIdToSeedId: Map<string, string>,
	planInfoMap: Map<
		string,
		{ planId: string; children: string[]; obsolete: string[]; unitIds: Map<string, string> }
	>,
	partial = false,
): IngestionManifest {
	const newGroups: ManifestGroupEntry[] = [];

	for (const group of groups) {
		if (group.kind === "standalone") {
			const seedId = logicalIdToSeedId.get(group.logicalId);
			if (seedId === undefined) continue;
			const entry: ManifestStandaloneEntry = {
				logicalId: group.logicalId,
				kind: "standalone",
				seedId,
			};
			newGroups.push(entry);
		} else if (group.kind === "plan") {
			const seedId = logicalIdToSeedId.get(group.logicalId);
			// seedId is required; planInfo may be absent for a pending entry (parent created
			// but plan submit failed). We still emit the entry so re-runs can adopt the parent.
			if (seedId === undefined) continue;

			const planInfo = planInfoMap.get(group.logicalId);
			if (planInfo === undefined) {
				// Pending plan entry: parent seed exists but plan submit hasn't run yet.
				// Record seedId only so the reconcile path can adopt the parent on re-run.
				const entry: ManifestPlanEntry = {
					logicalId: group.logicalId,
					kind: "plan",
					seedId,
					units: {},
				};
				newGroups.push(entry);
			} else {
				const units: Record<string, string> = {};
				for (const [lid, sid] of planInfo.unitIds) {
					units[lid] = sid;
				}
				const entry: ManifestPlanEntry = {
					logicalId: group.logicalId,
					kind: "plan",
					seedId,
					planId: planInfo.planId,
					units,
				};
				newGroups.push(entry);
			}
		}
	}

	const sourceEntry: ManifestSourceEntry = {
		contentHash,
		ingestedAt,
		groups: newGroups,
		// Only write `partial:true` when flagged — omit the field entirely on clean entries.
		...(partial ? { partial: true as const } : {}),
	};

	return {
		schemaVersion: 1,
		sources: {
			...manifest.sources,
			[sourcePath]: sourceEntry,
		},
	};
}

function makeResult(
	exitCode: number,
	mode: "apply" | "preview",
	sourceState: SourceState,
	created: string[],
	planIds: string[],
	commands: string[],
	warnings: string[],
	manifestPath: string,
): IngestResult {
	return { exitCode, mode, sourceState, created, planIds, commands, warnings, manifestPath };
}

function toJsonEnvelope(result: IngestResult, ok: boolean): Record<string, unknown> {
	return {
		ok,
		mode: result.mode,
		sourceState: result.sourceState,
		created: result.created,
		planIds: result.planIds,
		commands: result.commands,
		warnings: result.warnings,
		manifestPath: result.manifestPath,
	};
}

/** Commander command factory. */
export function createIngestCommand(): Command {
	return new Command("ingest")
		.description("Ingest a normalized-plan JSON and create/reconcile seeds via sd")
		.requiredOption("--plan <file|->", "Normalized-plan JSON file, or '-' to read from stdin")
		.option("--apply", "Actually write seeds (create/reconcile). Omit for dry-run preview.")
		.option("--dry-run", "Explicit alias for 'no --apply' (preview only, writes nothing).")
		.option(
			"--new-plan",
			"Force fresh creation even if the source is already in the manifest (duplicates ready work)",
		)
		.option(
			"--manifest <path>",
			"Manifest file location (default: <cwd>/.overstory/ingestion-manifest.json)",
		)
		.option("--cwd <dir>", "Repo root for sd invocation + manifest resolution")
		.option("--json", "Machine-readable result envelope on stdout")
		.action(async (opts: IngestOptions) => {
			const result = await ingestCommand(opts);
			process.exitCode = result.exitCode;
		});
}
