import { describe, expect, test } from "bun:test";
import {
	GIT_MERGE_TREE_WRITE_TREE_MIN,
	compareGitVersions,
	parseGitVersion,
	parseLegacyMergeTreeOutput,
	supportsWriteTree,
} from "./git-version.ts";

// ── parseGitVersion ────────────────────────────────────────────────────────

describe("parseGitVersion", () => {
	test("parses standard output line", () => {
		const v = parseGitVersion("git version 2.34.1");
		expect(v).toEqual({ major: 2, minor: 34, patch: 1 });
	});

	test("parses Apple git variant", () => {
		const v = parseGitVersion("git version 2.39.3 (Apple Git-145)");
		expect(v).toEqual({ major: 2, minor: 39, patch: 3 });
	});

	test("parses windows git variant", () => {
		const v = parseGitVersion("git version 2.38.0.windows.1");
		expect(v).toEqual({ major: 2, minor: 38, patch: 0 });
	});

	test("parses exact minimum version string", () => {
		const v = parseGitVersion("git version 2.38.0");
		expect(v).toEqual({ major: 2, minor: 38, patch: 0 });
	});

	test("returns null for empty string", () => {
		expect(parseGitVersion("")).toBeNull();
	});

	test("returns null for non-version output", () => {
		expect(parseGitVersion("usage: git [--version] ...")).toBeNull();
	});
});

// ── compareGitVersions ────────────────────────────────────────────────────

describe("compareGitVersions", () => {
	test("equal versions return 0", () => {
		expect(compareGitVersions({ major: 2, minor: 38, patch: 0 }, { major: 2, minor: 38, patch: 0 })).toBe(0);
	});

	test("major difference dominates", () => {
		expect(compareGitVersions({ major: 3, minor: 0, patch: 0 }, { major: 2, minor: 99, patch: 99 })).toBeGreaterThan(0);
		expect(compareGitVersions({ major: 1, minor: 99, patch: 99 }, { major: 2, minor: 0, patch: 0 })).toBeLessThan(0);
	});

	test("minor difference (same major)", () => {
		expect(compareGitVersions({ major: 2, minor: 39, patch: 0 }, { major: 2, minor: 38, patch: 0 })).toBeGreaterThan(0);
		expect(compareGitVersions({ major: 2, minor: 37, patch: 9 }, { major: 2, minor: 38, patch: 0 })).toBeLessThan(0);
	});

	test("patch difference (same major and minor)", () => {
		expect(compareGitVersions({ major: 2, minor: 38, patch: 1 }, { major: 2, minor: 38, patch: 0 })).toBeGreaterThan(0);
		expect(compareGitVersions({ major: 2, minor: 38, patch: 0 }, { major: 2, minor: 38, patch: 1 })).toBeLessThan(0);
	});

	test("2.34.1 is below min (2.38.0)", () => {
		const old = { major: 2, minor: 34, patch: 1 };
		expect(compareGitVersions(old, GIT_MERGE_TREE_WRITE_TREE_MIN)).toBeLessThan(0);
	});

	test("2.38.0 meets min", () => {
		const exact = { major: 2, minor: 38, patch: 0 };
		expect(compareGitVersions(exact, GIT_MERGE_TREE_WRITE_TREE_MIN)).toBe(0);
	});

	test("2.54.0 is above min", () => {
		const newer = { major: 2, minor: 54, patch: 0 };
		expect(compareGitVersions(newer, GIT_MERGE_TREE_WRITE_TREE_MIN)).toBeGreaterThan(0);
	});
});

// ── supportsWriteTree ────────────────────────────────────────────────────

describe("supportsWriteTree", () => {
	test("returns true for git >= 2.38", async () => {
		const fakeRunGit = async (_root: string, args: string[]) => {
			if (args[0] === "--version") {
				return { stdout: "git version 2.38.0\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		expect(await supportsWriteTree(fakeRunGit, "/unused")).toBe(true);
	});

	test("returns true for git 2.54.0 (system default on this machine)", async () => {
		const fakeRunGit = async (_root: string, args: string[]) => {
			if (args[0] === "--version") {
				return { stdout: "git version 2.54.0\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		expect(await supportsWriteTree(fakeRunGit, "/unused")).toBe(true);
	});

	test("returns false for git 2.34.1 (old git)", async () => {
		const fakeRunGit = async (_root: string, args: string[]) => {
			if (args[0] === "--version") {
				return { stdout: "git version 2.34.1\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		expect(await supportsWriteTree(fakeRunGit, "/unused")).toBe(false);
	});

	test("returns false when git --version fails", async () => {
		const fakeRunGit = async (_root: string, _args: string[]) => {
			return { stdout: "", stderr: "git: command not found", exitCode: 127 };
		};
		expect(await supportsWriteTree(fakeRunGit, "/unused")).toBe(false);
	});

	test("returns false when version output is unparseable", async () => {
		const fakeRunGit = async (_root: string, args: string[]) => {
			if (args[0] === "--version") {
				return { stdout: "some weird output\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		expect(await supportsWriteTree(fakeRunGit, "/unused")).toBe(false);
	});
});

// ── parseLegacyMergeTreeOutput ────────────────────────────────────────────

describe("parseLegacyMergeTreeOutput", () => {
	test("empty output returns empty array (clean merge)", () => {
		expect(parseLegacyMergeTreeOutput("")).toEqual([]);
	});

	test("output without conflict markers returns empty array", () => {
		// Additions on both sides, no overlap — git emits nothing on stdout for clean merges
		// in the legacy form, but test whitespace-only content too.
		expect(parseLegacyMergeTreeOutput("\n\n")).toEqual([]);
	});

	// Helper: produce a 40-char hex SHA from a single hex char repeated.
	const sha40 = (c: string) => c.repeat(40);

	test("single conflict file detected from conflict-marker section", () => {
		// Fixture representing legacy git merge-tree output for one conflicting file.
		const fixture = [
			"changed in both",
			`  base   100644 ${sha40("a")}  src/test.ts`,
			`  our    100644 ${sha40("b")}  src/test.ts`,
			`  their  100644 ${sha40("c")}  src/test.ts`,
			"@@ -1 +1 @@",
			"+<<<<<<< .our",
			"+feature content",
			"+=======",
			"+main content",
			"+>>>>>>> .their",
			"",
		].join("\n");

		const result = parseLegacyMergeTreeOutput(fixture);
		expect(result).toEqual(["src/test.ts"]);
	});

	test("matches real git merge-tree legacy output format", () => {
		// Actual output captured from git 2.54.0 (one-file conflict).
		const fixture = [
			"changed in both",
			"  base   100644 4b48deed3a433909bfd6b6ab3d4b91348b6af464 file.ts",
			"  our    100644 bcb9dcad21591bd9284afbb6c21e6d69eafe8f15 file.ts",
			"  their  100644 e4f2b3f050b9e337d660fe47087d72e892668144 file.ts",
			"@@ -1 +1,5 @@",
			"+<<<<<<< .our",
			" main content",
			"+=======",
			"+feature content",
			"+>>>>>>> .their",
		].join("\n");

		const result = parseLegacyMergeTreeOutput(fixture);
		expect(result).toEqual(["file.ts"]);
	});

	test("multiple conflict files detected", () => {
		const fixture = [
			"changed in both",
			`  base   100644 ${sha40("a")}  src/a.ts`,
			`  our    100644 ${sha40("b")}  src/a.ts`,
			`  their  100644 ${sha40("c")}  src/a.ts`,
			"@@ -1 +1 @@",
			"+<<<<<<< .our",
			"+a feature",
			"+=======",
			"+a main",
			"+>>>>>>> .their",
			"",
			"changed in both",
			`  base   100644 ${sha40("d")}  src/b.ts`,
			`  our    100644 ${sha40("e")}  src/b.ts`,
			`  their  100644 ${sha40("f")}  src/b.ts`,
			"@@ -1 +1 @@",
			"+<<<<<<< .our",
			"+b feature",
			"+=======",
			"+b main",
			"+>>>>>>> .their",
			"",
		].join("\n");

		const result = parseLegacyMergeTreeOutput(fixture);
		expect(result).toHaveLength(2);
		expect(result).toContain("src/a.ts");
		expect(result).toContain("src/b.ts");
	});

	test("section with no conflict markers (non-conflicting change) is not reported", () => {
		// A "changed in both" section where git auto-resolved the hunk — no +<<<<<<< in diff.
		const fixture = [
			"changed in both",
			`  base   100644 ${sha40("a")}  src/safe.ts`,
			`  our    100644 ${sha40("b")}  src/safe.ts`,
			`  their  100644 ${sha40("c")}  src/safe.ts`,
			"@@ -1,2 +1,3 @@",
			" unchanged line",
			"+added by feature",
			"+added by main",
			"",
		].join("\n");

		// No conflict markers → section should NOT appear in result.
		const result = parseLegacyMergeTreeOutput(fixture);
		expect(result).toEqual([]);
	});

	test("deduplicates the same path appearing twice in the same section", () => {
		const fixture = [
			"changed in both",
			`  base   100644 ${sha40("a")}  src/dup.ts`,
			`  our    100644 ${sha40("b")}  src/dup.ts`,
			`  their  100644 ${sha40("c")}  src/dup.ts`,
			"@@ -1 +1 @@",
			"+<<<<<<< .our",
			"+=======",
			"+>>>>>>> .their",
			"@@ -5 +5 @@",
			"+<<<<<<< .our",
			"+=======",
			"+>>>>>>> .their",
			"",
		].join("\n");

		const result = parseLegacyMergeTreeOutput(fixture);
		expect(result).toEqual(["src/dup.ts"]);
	});

	test("output without trailing newline is handled", () => {
		const fixture = [
			"changed in both",
			`  base   100644 ${sha40("a")}  src/test.ts`,
			`  our    100644 ${sha40("b")}  src/test.ts`,
			`  their  100644 ${sha40("c")}  src/test.ts`,
			"+<<<<<<< .our",
			"+=======",
			"+>>>>>>> .their",
			// No trailing newline
		].join("\n");

		const result = parseLegacyMergeTreeOutput(fixture);
		expect(result).toEqual(["src/test.ts"]);
	});
});
