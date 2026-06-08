import { resolveBackend, trackerCliName } from "../tracker/factory.ts";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

interface ToolSpec {
	name: string;
	versionFlag: string;
	required: boolean;
	/** Short alias to check if the primary tool is available. */
	alias?: string;
	/** npm package name for install hint (e.g. "@os-eco/mulch-cli"). */
	installHint?: string;
}

/**
 * External dependency checks.
 * Validates that required CLI tools (git, bun, tmux, tracker, mulch, overstory)
 * and optional tools (cn) are available, including short alias availability.
 */
export const checkDependencies: DoctorCheckFn = async (
	config,
	_overstoryDir,
): Promise<DoctorCheck[]> => {
	// Determine which tracker CLI to check based on config backend (resolve "auto")
	const resolvedBackend = await resolveBackend(config.taskTracker.backend, config.project.root);
	const trackerName = trackerCliName(resolvedBackend);

	const tools: ToolSpec[] = [
		{ name: "git", versionFlag: "--version", required: true },
		{ name: "bun", versionFlag: "--version", required: true },
		{ name: "tmux", versionFlag: "-V", required: true },
		{
			name: trackerName,
			versionFlag: "--version",
			required: true,
			installHint: trackerName === "sd" ? "@os-eco/seeds-cli" : undefined,
		},
		{
			name: "mulch",
			versionFlag: "--version",
			required: true,
			alias: "ml",
			installHint: "@os-eco/mulch-cli",
		},
		{
			name: "ov",
			versionFlag: "--version",
			required: true,
			alias: "overstory",
			installHint: "@os-eco/overstory-cli",
		},
		{
			name: "cn",
			versionFlag: "--version",
			required: false,
			installHint: "@os-eco/canopy-cli",
		},
	];

	const checks: DoctorCheck[] = [];

	for (const tool of tools) {
		const check = await checkTool(tool.name, tool.versionFlag, tool.required, tool.installHint);
		checks.push(check);

		// Check short alias availability if the main tool is available
		if (tool.alias && check.status === "pass") {
			const aliasCheck = await checkAlias(tool.name, tool.alias, tool.installHint);
			checks.push(aliasCheck);
		}
	}

	// If bd is available, probe for CGO/Dolt backend functionality.
	// Only run for beads backend (CGO check is beads-specific).
	if (trackerName === "bd") {
		const bdCheck = checks.find((c) => c.name === "bd availability");
		if (bdCheck?.status === "pass") {
			const cgoCheck = await checkBdCgoSupport();
			checks.push(cgoCheck);
		}
	}

	// Check that the installed claude CLI supports --setting-sources (ISS-11 worker isolation).
	// Only run this check when claude is already known to be present — if the "claude availability"
	// check failed, we'd produce a confusing duplicate warning. Because claude is not in the tools
	// array above (it's spawned by overstory itself, not checked as a user-facing CLI dep), we
	// run this unconditionally and handle the "not found" case inside the helper by returning pass.
	const settingSourcesCheck = await checkClaudeSettingSources();
	checks.push(settingSourcesCheck);

	return checks;
};

/** Spawner abstraction for checkClaudeSettingSources — injected in tests to avoid real subprocess. */
export type HelpSpawner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

async function defaultHelpSpawner(args: string[]): Promise<{ stdout: string; stderr: string }> {
	const proc = Bun.spawn(args, {
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { stdout, stderr };
}

/**
 * Check that the installed claude CLI supports the --setting-sources flag (ISS-11).
 *
 * Worker spawns unconditionally pass `--setting-sources project,local` to isolate
 * workers from the operator's global ~/.claude config.  An older Claude Code build
 * that does not recognise the flag will fail every spawn with
 * "error: unknown option '--setting-sources'", which is hard to diagnose.
 *
 * Logic:
 * - claude not on PATH → pass/skip (the "claude availability" check in tools handles
 *   the missing-binary case; we must not produce a confusing duplicate here).
 * - claude present, flag present in --help → pass.
 * - claude present, flag absent → warn with remediation.
 *
 * No --fix handler: we cannot update the user's Claude Code installation.
 *
 * @param spawner - Optional subprocess abstraction; defaults to real Bun.spawn.
 *                  Injected in tests to avoid invoking the real claude binary.
 * @internal Exported for testing.
 */
export async function checkClaudeSettingSources(
	spawner: HelpSpawner = defaultHelpSpawner,
): Promise<DoctorCheck> {
	try {
		const { stdout, stderr } = await spawner(["claude", "--help"]);
		const combined = stdout + stderr;

		if (combined.includes("--setting-sources")) {
			return {
				name: "claude --setting-sources support",
				category: "dependencies",
				status: "pass",
				message: "claude CLI supports --setting-sources (ISS-11 worker isolation)",
				details: ["--setting-sources flag present in claude --help output"],
			};
		}

		// claude is present but the flag is missing — old build.
		return {
			name: "claude --setting-sources support",
			category: "dependencies",
			status: "warn",
			message:
				"Installed Claude Code does not support --setting-sources; every worker spawn will fail",
			details: [
				"Worker spawns pass --setting-sources project,local (ISS-11 isolation).",
				'Older Claude Code builds reject this flag with "error: unknown option".',
				"Remediation: update Claude Code to the latest version.",
			],
			fixable: true,
		};
	} catch {
		// claude is not on PATH or failed to spawn — skip; the tool-availability
		// check (added via tools array if present) handles the missing-binary case.
		return {
			name: "claude --setting-sources support",
			category: "dependencies",
			status: "pass",
			message: "claude CLI not found — skipping --setting-sources capability check",
			details: ["claude binary absent; capability check skipped"],
		};
	}
}

/**
 * Probe whether bd's Dolt database backend is functional.
 * The npm-distributed bd binary may be built without CGO, which causes
 * `bd init` and all database operations to fail even though `bd --version` succeeds.
 * We detect this by running `bd status` in a temp directory and checking for
 * the characteristic "without CGO support" error message.
 */
async function checkBdCgoSupport(): Promise<DoctorCheck> {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");

	let tempDir: string | undefined;
	try {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-bd-cgo-"));
		const proc = Bun.spawn(["bd", "status"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();

		if (stderr.includes("without CGO support")) {
			return {
				name: "bd CGO support",
				category: "dependencies",
				status: "fail",
				message: "bd binary was built without CGO — Dolt database operations will fail",
				details: [
					"The installed bd binary lacks CGO support required by its Dolt backend.",
					"Workaround: rebuild bd from source with CGO_ENABLED=1 and ICU headers.",
					"See: https://github.com/jayminwest/overstory/issues/10",
				],
				fixable: true,
			};
		}

		// Any other exit code is fine — bd status may fail for other reasons
		// (no .beads/ dir, etc.) but those aren't CGO issues
		if (exitCode === 0 || !stderr.includes("CGO")) {
			return {
				name: "bd CGO support",
				category: "dependencies",
				status: "pass",
				message: "bd has functional database backend",
				details: ["Dolt backend operational"],
			};
		}

		return {
			name: "bd CGO support",
			category: "dependencies",
			status: "warn",
			message: `bd status returned unexpected error (exit code ${exitCode})`,
			details: [stderr.trim().split("\n")[0] || "unknown error"],
		};
	} catch (error) {
		return {
			name: "bd CGO support",
			category: "dependencies",
			status: "warn",
			message: "Could not verify bd CGO support",
			details: [error instanceof Error ? error.message : String(error)],
		};
	} finally {
		if (tempDir) {
			await rm(tempDir, { recursive: true }).catch(() => {});
		}
	}
}

/**
 * Check if a short alias for a CLI tool is available.
 * @internal Exported for testing.
 */
export async function checkAlias(
	toolName: string,
	alias: string,
	installHint?: string,
): Promise<DoctorCheck> {
	try {
		const proc = Bun.spawn([alias, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;

		if (exitCode === 0) {
			return {
				name: `${alias} alias`,
				category: "dependencies",
				status: "pass",
				message: `${alias} alias for ${toolName} is available`,
				details: [`Short alias '${alias}' is configured`],
			};
		}

		const hint = installHint
			? `Reinstall ${installHint} to get the '${alias}' alias.`
			: `Ensure '${alias}' alias is in your PATH.`;
		return {
			name: `${alias} alias`,
			category: "dependencies",
			status: "warn",
			message: `${alias} alias for ${toolName} not working`,
			details: [hint],
			fixable: true,
		};
	} catch {
		const hint = installHint
			? `Reinstall ${installHint} to get the '${alias}' alias.`
			: `Ensure '${alias}' alias is in your PATH.`;
		return {
			name: `${alias} alias`,
			category: "dependencies",
			status: "warn",
			message: `${alias} alias for ${toolName} is not available`,
			details: [`'${toolName}' works but short alias '${alias}' was not found.`, hint],
			fixable: true,
		};
	}
}

/**
 * Check if a CLI tool is available by attempting to run it with a version flag.
 * @internal Exported for testing.
 */
export async function checkTool(
	name: string,
	versionFlag: string,
	required: boolean,
	installHint?: string,
): Promise<DoctorCheck> {
	try {
		const proc = Bun.spawn([name, versionFlag], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;

		if (exitCode === 0) {
			const stdout = await new Response(proc.stdout).text();
			const version = stdout.split("\n")[0]?.trim() || "version unknown";

			return {
				name: `${name} availability`,
				category: "dependencies",
				status: "pass",
				message: `${name} is available`,
				details: [version],
			};
		}

		// Non-zero exit code
		const stderr = await new Response(proc.stderr).text();
		const details: string[] = [];
		if (stderr) details.push(stderr.trim());
		if (installHint) details.push(`Install: npm install -g ${installHint}`);
		return {
			name: `${name} availability`,
			category: "dependencies",
			status: required ? "fail" : "warn",
			message: `${name} command failed (exit code ${exitCode})`,
			details: details.length > 0 ? details : undefined,
			fixable: true,
		};
	} catch (error) {
		// Command not found or spawn failed
		const details: string[] = [];
		if (installHint) {
			details.push(`Install: npm install -g ${installHint}`);
		} else {
			details.push(`Install ${name} or ensure it is in your PATH`);
		}
		details.push(error instanceof Error ? error.message : String(error));
		return {
			name: `${name} availability`,
			category: "dependencies",
			status: required ? "fail" : "warn",
			message: `${name} is not installed or not in PATH`,
			details,
			fixable: true,
		};
	}
}
