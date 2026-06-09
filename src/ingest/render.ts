/**
 * Pure renderer: normalized plan → typed operations list.
 *
 * This is the SINGLE source of truth for both dry-run preview and apply execution.
 * Implements the dependsOn → blocks inversion per contract §4.
 */

import type {
	ManifestGroupEntry,
	ManifestPlanEntry,
	NormalizedGroup,
	NormalizedPlan,
	NormalizedUnit,
} from "./schema.ts";

// --- Operation types ---

export interface CreateOp {
	op: "create";
	logicalId: string;
	args: string[]; // sd create args (without "sd" prefix)
	existingSeedId?: string; // set when reconciling (adopt existing parent)
}

/** Plan JSON fed to `sd plan submit --plan -` */
export interface SdPlanStep {
	title: string;
	type?: string;
	priority?: number;
	blocks?: number[]; // 1-based indices of steps this step blocks
	labels?: string[];
	existing_seed?: string;
}

export interface SdPlanJson {
	template: "feature" | "bug" | "refactor";
	name?: string;
	sections: {
		context?: string;
		approach?: string;
		steps: SdPlanStep[];
		acceptance: string[];
	};
}

export interface PlanSubmitOp {
	op: "planSubmit";
	parentLogicalId: string;
	planJson: SdPlanJson;
	overwrite: boolean;
}

export type RenderOperation = CreateOp | PlanSubmitOp;

export interface RenderResult {
	operations: RenderOperation[];
	commands: string[]; // human-readable for dry-run preview
}

/**
 * Render operations for a normalized plan.
 *
 * @param plan - The normalized plan JSON.
 * @param manifestEntries - Map of logicalId → manifest entry for groups already in the manifest.
 *   Pass `{}` for a fresh (new) create; populate for reconcile.
 */
export function renderOperations(
	plan: NormalizedPlan,
	manifestEntries: Record<string, ManifestGroupEntry>,
): RenderResult {
	const operations: RenderOperation[] = [];
	const commands: string[] = [];

	for (const group of plan.groups) {
		const manifestEntry = manifestEntries[group.logicalId];
		renderGroup(group, manifestEntry, operations, commands);
	}

	return { operations, commands };
}

function renderGroup(
	group: NormalizedGroup,
	manifestEntry: ManifestGroupEntry | undefined,
	operations: RenderOperation[],
	commands: string[],
): void {
	if (group.kind === "standalone") {
		const args = buildCreateArgs(group.title, group.type, group.priority, group.description);
		const existingSeedId = manifestEntry?.kind === "standalone" ? manifestEntry.seedId : undefined;

		operations.push({
			op: "create",
			logicalId: group.logicalId,
			args,
			...(existingSeedId !== undefined ? { existingSeedId } : {}),
		});
		commands.push(`sd ${args.join(" ")}`);
	} else if (group.kind === "plan") {
		const planManifest = manifestEntry?.kind === "plan" ? manifestEntry : undefined;
		const existingSeedId = planManifest?.seedId;

		// Parent create op
		const createArgs = buildCreateArgs(group.title, group.type, group.priority, group.description);
		operations.push({
			op: "create",
			logicalId: group.logicalId,
			args: createArgs,
			...(existingSeedId !== undefined ? { existingSeedId } : {}),
		});
		commands.push(`sd ${createArgs.join(" ")}`);

		// Build steps with dependsOn → blocks inversion
		const steps = buildSteps(group.units, planManifest);

		const planJson: SdPlanJson = {
			template: group.template,
			sections: {
				steps,
				acceptance: group.acceptance,
			},
		};

		const overwrite = planManifest !== undefined;
		operations.push({
			op: "planSubmit",
			parentLogicalId: group.logicalId,
			planJson,
			overwrite,
		});

		const overwriteFlag = overwrite ? " --overwrite" : "";
		commands.push(`sd plan submit <parentId> --plan -${overwriteFlag} --json`);
	}
}

function buildCreateArgs(
	title: string,
	type: string,
	priority: number,
	description: string,
): string[] {
	return [
		"create",
		"--title",
		title,
		"--type",
		type,
		"--priority",
		String(priority),
		"--description",
		description,
		"--json",
	];
}

/**
 * Build the steps array for `sd plan submit`.
 * Applies the dependsOn → blocks inversion (contract §4):
 * For each unit U (1-based index iU) and each dep D in U.dependsOn (1-based index iD):
 *   add iU to step iD's blocks array.
 */
function buildSteps(
	units: NormalizedUnit[],
	planManifest: ManifestPlanEntry | undefined,
): SdPlanStep[] {
	// Initialize steps
	const steps: SdPlanStep[] = units.map((unit) => {
		const step: SdPlanStep = {
			title: unit.title,
			type: unit.type,
			priority: unit.priority,
		};

		// Reconcile: if unit was already mapped, adopt it
		if (planManifest !== undefined) {
			const existingSeed = planManifest.units[unit.logicalId];
			if (existingSeed !== undefined) {
				step.existing_seed = existingSeed;
			}
		}

		return step;
	});

	// Build logicalId → 1-based index map
	const idToIndex = new Map<string, number>();
	units.forEach((unit, i) => {
		idToIndex.set(unit.logicalId, i + 1); // 1-based
	});

	// Apply inversion: for each U at 1-based iU, each dep D at 1-based iD → add iU to steps[iD-1].blocks
	units.forEach((unit, i) => {
		const iU = i + 1;
		for (const depId of unit.dependsOn) {
			const iD = idToIndex.get(depId);
			if (iD !== undefined) {
				const depStep = steps[iD - 1];
				if (depStep !== undefined) {
					if (depStep.blocks === undefined) {
						depStep.blocks = [];
					}
					depStep.blocks.push(iU);
				}
			}
		}
	});

	return steps;
}
