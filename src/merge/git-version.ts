/**
 * Git version detection and capability probing for merge-tree fallback routing.
 *
 * `git merge-tree --write-tree` (the "new" form) requires git >= 2.38.
 * On older git the subcommand accepts only the 3-arg positional form:
 *   git merge-tree <base-tree> <branch1> <branch2>
 * which writes conflicted file content with `<<<<<<<`/`=======`/`>>>>>>>` markers
 * to stdout but does NOT mutate the index, working tree, or HEAD.
 */

/** Parsed git version triple. */
export interface GitVersion {
	major: number;
	minor: number;
	patch: number;
}

/**
 * Parse "git version X.Y.Z[.windows.N]" → GitVersion.
 * Returns null when the string cannot be parsed.
 */
export function parseGitVersion(versionLine: string): GitVersion | null {
	// e.g. "git version 2.34.1" or "git version 2.39.3 (Apple Git-145)"
	const match = /git version (\d+)\.(\d+)\.(\d+)/.exec(versionLine);
	if (!match) return null;
	// match[1..3] are defined because the regex has three capture groups.
	return {
		major: parseInt(match[1] as string, 10),
		minor: parseInt(match[2] as string, 10),
		patch: parseInt(match[3] as string, 10),
	};
}

/**
 * Compare two GitVersion objects.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareGitVersions(a: GitVersion, b: GitVersion): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	return a.patch - b.patch;
}

/** Minimum git version that supports `merge-tree --write-tree`. */
export const GIT_MERGE_TREE_WRITE_TREE_MIN: GitVersion = { major: 2, minor: 38, patch: 0 };

/**
 * Detect whether the installed git supports `merge-tree --write-tree`.
 *
 * Runs `git --version` and parses the semver. Falls back to `false` (conservative)
 * when parsing fails — the legacy 3-arg path will handle it.
 *
 * @param runGit - The same runGit helper used by the caller (avoids code duplication).
 */
export async function supportsWriteTree(
	runGit: (repoRoot: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>,
	repoRoot: string,
): Promise<boolean> {
	const { stdout, exitCode } = await runGit(repoRoot, ["--version"]);
	if (exitCode !== 0) return false;
	const parsed = parseGitVersion(stdout.trim());
	if (!parsed) return false;
	return compareGitVersions(parsed, GIT_MERGE_TREE_WRITE_TREE_MIN) >= 0;
}

/**
 * Parse legacy `git merge-tree <base> <ours> <theirs>` stdout to extract
 * the set of files that have conflict markers.
 *
 * The legacy form emits one or more sections per conflicting file:
 *   changed in both
 *     base   100644 <sha>  <path>
 *     our    100644 <sha>  <path>
 *     their  100644 <sha>  <path>
 *   @@ ...
 *   +<<<<<<< .our
 *   ...
 *   +======= ...
 *   +>>>>>>> .their
 *
 * The "changed in both" header line reliably identifies conflict sections
 * and is followed by three index lines (`base`/`our`/`their`) carrying the path.
 * We extract paths from those index lines and confirm a conflict marker exists
 * somewhere in the diff body for that section.
 *
 * Additionally, we scan for inline `<<<<<<<` / `>>>>>>>` conflict markers to
 * catch any output format variant that lacks the header block.
 *
 * Returns the set of files that have unresolved conflicts.
 */
export function parseLegacyMergeTreeOutput(stdout: string): string[] {
	if (stdout.trim().length === 0) return [];

	const conflictPaths = new Set<string>();
	const lines = stdout.split("\n");

	// Track whether we are inside a conflict section.
	let inConflictSection = false;
	let sectionPath: string | null = null;
	let sectionHasMarkers = false;

	for (const line of lines) {
		// "changed in both" starts a conflict section.
		if (line.trim() === "changed in both") {
			// Flush previous section.
			if (inConflictSection && sectionPath && sectionHasMarkers) {
				conflictPaths.add(sectionPath);
			}
			inConflictSection = true;
			sectionPath = null;
			sectionHasMarkers = false;
			continue;
		}

		// A blank line between sections — flush if we were in one.
		if (line.trim() === "" && inConflictSection && sectionPath) {
			if (sectionHasMarkers) conflictPaths.add(sectionPath);
			inConflictSection = false;
			sectionPath = null;
			sectionHasMarkers = false;
			continue;
		}

		if (inConflictSection) {
			// Pick up path from the index lines (base/our/their).
			// Format: "  base   100644 <sha>  <path>"
			const indexMatch = /^\s+(?:base|our|their)\s+\d{6}\s+[0-9a-f]{40}\s+(.+)$/.exec(line);
			// indexMatch[1] is defined when the regex matched (one capture group).
			if (indexMatch && !sectionPath) {
				sectionPath = (indexMatch[1] as string).trim();
			}

			// Detect conflict markers in the diff body (+<<<<<<< or bare <<<<<<<).
			if (/^[+]?<{7}/.test(line) || /^[+]?>{7}/.test(line)) {
				sectionHasMarkers = true;
			}
		} else {
			// Outside any labelled section, still catch stray conflict markers
			// (some git versions emit them without the "changed in both" header).
			if (/^<{7}/.test(line) || /^>{7}/.test(line)) {
				// Try to attribute to the last seen path in output — less reliable,
				// but better than silently missing a conflict.
				if (sectionPath) {
					conflictPaths.add(sectionPath);
				}
			}
		}
	}

	// Flush the final section if the output ended without a blank line.
	if (inConflictSection && sectionPath && sectionHasMarkers) {
		conflictPaths.add(sectionPath);
	}

	return [...conflictPaths];
}
