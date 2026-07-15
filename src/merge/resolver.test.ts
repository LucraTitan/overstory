import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { join } from "node:path";
import { MergeError } from "../errors.ts";
import type { MulchClient } from "../mulch/client.ts";
import {
	cleanupTempDir,
	commitFile,
	createTempGitRepo,
	getDefaultBranch,
	runGitInDir,
} from "../test-helpers.ts";
import type { MergeEntry, ParsedConflictPattern } from "../types.ts";
import {
	buildConflictHistory,
	createMergeResolver,
	hasContentfulCanonical,
	looksLikeProse,
	parseConflictPatterns,
	resolveConflictsUnion,
} from "./resolver.ts";

/**
 * Helper to create a mock Bun.spawn return value for claude CLI mocking.
 *
 * The resolver reads stdout/stderr via `new Response(proc.stdout).text()`
 * and `new Response(proc.stderr).text()`, so we need ReadableStreams.
 */
function mockSpawnResult(
	stdout: string,
	stderr: string,
	exitCode: number,
): {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	pid: number;
} {
	return {
		stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
		stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
		exited: Promise.resolve(exitCode),
		pid: 12345,
	};
}

function makeTestEntry(overrides?: Partial<MergeEntry>): MergeEntry {
	return {
		branchName: overrides?.branchName ?? "feature-branch",
		taskId: overrides?.taskId ?? "bead-123",
		agentName: overrides?.agentName ?? "test-agent",
		filesModified: overrides?.filesModified ?? ["src/test.ts"],
		enqueuedAt: overrides?.enqueuedAt ?? new Date().toISOString(),
		status: overrides?.status ?? "pending",
		resolvedTier: overrides?.resolvedTier ?? null,
	};
}

/**
 * Set up a clean merge scenario: feature branch adds a new file with no conflict.
 */
async function setupCleanMerge(dir: string, baseBranch: string): Promise<void> {
	await commitFile(dir, "src/main-file.ts", "main content\n");
	await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
	await commitFile(dir, "src/feature-file.ts", "feature content\n");
	await runGitInDir(dir, ["checkout", baseBranch]);
}

/**
 * Set up a real content conflict: create a file, branch, modify on both
 * branches. Both sides must diverge from the common ancestor to produce
 * conflict markers.
 */
async function setupContentConflict(dir: string, baseBranch: string): Promise<void> {
	await commitFile(dir, "src/test.ts", "original content\n");
	await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
	await commitFile(dir, "src/test.ts", "feature content\n");
	await runGitInDir(dir, ["checkout", baseBranch]);
	await commitFile(dir, "src/test.ts", "main modified content\n");
}

/**
 * Set up a conflict where the canonical (HEAD) side is empty in the conflict marker.
 * Main deletes a shared line; feature replaces it. Git produces a conflict with an
 * empty HEAD side, so hasContentfulCanonical returns false and auto-resolve can safely
 * keep the incoming content.
 */
async function setupEmptyCanonicalConflict(dir: string, baseBranch: string): Promise<void> {
	await commitFile(dir, "src/test.ts", "line1\nshared line\nline3\n");
	await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
	await commitFile(dir, "src/test.ts", "line1\nnew content\nline3\n");
	await runGitInDir(dir, ["checkout", baseBranch]);
	await commitFile(dir, "src/test.ts", "line1\nline3\n"); // main deletes "shared line"
}

/**
 * Create a delete/modify conflict: file is deleted on main but modified on
 * the feature branch. This produces a conflict with NO conflict markers in
 * the working copy, causing Tier 2 auto-resolve to fail (resolveConflictsKeepIncoming
 * returns null). This naturally escalates to Tier 3 or 4.
 */
async function setupDeleteModifyConflict(
	dir: string,
	baseBranch: string,
	branchName = "feature-branch",
): Promise<void> {
	await commitFile(dir, "src/test.ts", "original content\n");
	await runGitInDir(dir, ["checkout", "-b", branchName]);
	await commitFile(dir, "src/test.ts", "modified by agent\n");
	await runGitInDir(dir, ["checkout", baseBranch]);
	await runGitInDir(dir, ["rm", "src/test.ts"]);
	await runGitInDir(dir, ["commit", "-m", "delete src/test.ts"]);
}

/**
 * Set up a scenario where Tier 2 auto-resolve fails but Tier 4 reimagine can
 * succeed. We create a delete/modify conflict on one file (causes Tier 2 to fail)
 * and set entry.filesModified to a different file that exists on both branches
 * (so git show works for both in reimagine).
 */
async function setupReimagineScenario(dir: string, baseBranch: string): Promise<void> {
	await commitFile(dir, "src/conflict-file.ts", "original content\n");
	await commitFile(dir, "src/reimagine-target.ts", "main version of target\n");
	await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
	await commitFile(dir, "src/conflict-file.ts", "modified by agent\n");
	await commitFile(dir, "src/reimagine-target.ts", "feature version of target\n");
	await runGitInDir(dir, ["checkout", baseBranch]);
	await runGitInDir(dir, ["rm", "src/conflict-file.ts"]);
	await runGitInDir(dir, ["commit", "-m", "delete conflict file"]);
}

/**
 * Create a mock MulchClient for testing.
 * Optionally override the record method to track calls or simulate failures.
 */
function createMockMulchClient(
	recordImpl?: (domain: string, options: unknown) => Promise<void>,
): MulchClient {
	return {
		async prime() {
			return "";
		},
		async status() {
			return { domains: [] };
		},
		async record(domain: string, options: unknown) {
			if (recordImpl) {
				return recordImpl(domain, options);
			}
		},
		async query() {
			return "";
		},
		async search() {
			return "";
		},
		async diff() {
			return {
				success: true,
				command: "diff",
				since: "HEAD",
				domains: [],
				message: "",
			};
		},
		async learn() {
			return {
				success: true,
				command: "learn",
				changedFiles: [],
				suggestedDomains: [],
				unmatchedFiles: [],
			};
		},
		async prune() {
			return {
				success: true,
				command: "prune",
				dryRun: false,
				totalPruned: 0,
				results: [],
			};
		},
		async doctor() {
			return {
				success: true,
				command: "doctor",
				checks: [],
				summary: {
					pass: 0,
					warn: 0,
					fail: 0,
					totalIssues: 0,
					fixableIssues: 0,
				},
			};
		},
		async ready() {
			return {
				success: true,
				command: "ready",
				count: 0,
				entries: [],
			};
		},
		async compact() {
			return {
				success: true,
				command: "compact",
				action: "analyze",
			};
		},
		async appendOutcome() {
			// No-op stub: resolver tests don't exercise outcome appending
		},
	};
}

describe("createMergeResolver", () => {
	describe("Tier 1: Clean merge", () => {
		test("returns success with correct result shape and file content", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("clean-merge");
				expect(result.conflictFiles).toEqual([]);
				expect(result.errorMessage).toBeNull();

				// After merge, the feature file should exist on main
				const file = Bun.file(join(repoDir, "src/feature-file.ts"));
				const content = await file.text();
				expect(content).toBe("feature content\n");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Tier 1: Checkout failure", () => {
		// Both tests only attempt checkout of nonexistent branches -- no repo mutation.
		let repoDir: string;

		beforeAll(async () => {
			repoDir = await createTempGitRepo();
		});

		afterAll(async () => {
			await cleanupTempDir(repoDir);
		});

		test("throws MergeError if checkout fails", async () => {
			const entry = makeTestEntry();

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			await expect(resolver.resolve(entry, "nonexistent-branch", repoDir)).rejects.toThrow(
				MergeError,
			);
		});

		test("MergeError from checkout failure includes branch name", async () => {
			const entry = makeTestEntry();

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			try {
				await resolver.resolve(entry, "develop", repoDir);
				expect(true).toBe(false);
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(MergeError);
				const mergeErr = err as MergeError;
				expect(mergeErr.message).toContain("develop");
			}
		});
	});

	describe("Dirty working tree pre-check", () => {
		test("stashes unstaged changes and proceeds with clean merge", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				// Create a tracked file and then leave it modified (unstaged)
				await commitFile(repoDir, "src/main.ts", "original content\n");
				await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
				await commitFile(repoDir, "src/feature.ts", "feature content\n");
				await runGitInDir(repoDir, ["checkout", defaultBranch]);
				// Modify a tracked file without staging — should be stashed, not rejected
				await Bun.write(`${repoDir}/src/main.ts`, "modified content\n");

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("dirty non-state files are stashed, merge succeeds, files restored after", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await commitFile(repoDir, "src/main.ts", "original content\n");
				await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
				await commitFile(repoDir, "src/feature.ts", "feature content\n");
				await runGitInDir(repoDir, ["checkout", defaultBranch]);
				// Dirty file unrelated to the merge
				await Bun.write(`${repoDir}/src/main.ts`, "in-progress work\n");

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature.ts"],
				});

				const resolver = createMergeResolver({ aiResolveEnabled: false, reimagineEnabled: false });
				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");

				// After merge, the stashed modification should be restored
				const mainContent = await Bun.file(`${repoDir}/src/main.ts`).text();
				expect(mainContent).toBe("in-progress work\n");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("stash pop happens after failed merge too", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				// Set up a conflict that cannot be resolved (delete/modify)
				await setupDeleteModifyConflict(repoDir, defaultBranch);
				// Also leave an unrelated file dirty
				await Bun.write(`${repoDir}/src/other.ts`, "work in progress\n");
				await runGitInDir(repoDir, ["add", "src/other.ts"]);
				await runGitInDir(repoDir, ["commit", "-m", "add other.ts"]);
				await Bun.write(`${repoDir}/src/other.ts`, "modified but not committed\n");

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({ aiResolveEnabled: false, reimagineEnabled: false });
				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(false);

				// After failed merge, the stashed modification should be restored
				const otherContent = await Bun.file(`${repoDir}/src/other.ts`).text();
				expect(otherContent).toBe("modified but not committed\n");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("staged but uncommitted changes are stashed and merge proceeds", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await commitFile(repoDir, "src/main.ts", "original content\n");
				await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
				await commitFile(repoDir, "src/feature.ts", "feature content\n");
				await runGitInDir(repoDir, ["checkout", defaultBranch]);
				// Modify and stage (but don't commit) — should be stashed, not rejected
				await Bun.write(`${repoDir}/src/main.ts`, "staged but not committed\n");
				await runGitInDir(repoDir, ["add", "src/main.ts"]);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature.ts"],
				});

				const resolver = createMergeResolver({ aiResolveEnabled: false, reimagineEnabled: false });
				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("clean working tree proceeds normally to Tier 1", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({ aiResolveEnabled: false, reimagineEnabled: false });
				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Tier 1 fail -> Tier 2: Auto-resolve", () => {
		test("auto-resolves conflicts when canonical side is empty (keeps incoming)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				// Use empty-canonical setup: main deletes a line, feature replaces it.
				// The conflict marker has an empty HEAD side, so auto-resolve is safe.
				await setupEmptyCanonicalConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("auto-resolve");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("auto-resolve");
				expect(result.warnings).toEqual([]);

				// The resolved file should contain the incoming (feature branch) content
				const file = Bun.file(join(repoDir, "src/test.ts"));
				const content = await file.text();
				expect(content).toContain("new content");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Tier 3: AI-resolve", () => {
		// After the first test (aiResolve=false), the resolver aborts the merge and
		// leaves the repo clean. The second test can retry the merge on the same repo.
		let repoDir: string;
		let defaultBranch: string;

		beforeAll(async () => {
			repoDir = await createTempGitRepo();
			defaultBranch = await getDefaultBranch(repoDir);
			await setupDeleteModifyConflict(repoDir, defaultBranch);
		});

		afterAll(async () => {
			await cleanupTempDir(repoDir);
		});

		// This test MUST run first -- it fails to merge and aborts, leaving repo clean
		test("is skipped when aiResolveEnabled is false", async () => {
			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, defaultBranch, repoDir);

			expect(result.success).toBe(false);
			expect(result.entry.status).toBe("failed");
		});

		// This test runs second -- repo is clean from the abort, same conflict is available
		test("invokes claude when aiResolveEnabled is true and tier 2 fails", async () => {
			// Selective spy: mock only claude, let git commands through.
			const originalSpawn = Bun.spawn;
			let claudeCalled = false;

			const selectiveMock = (...args: unknown[]): unknown => {
				const cmd = args[0] as string[];
				if (cmd?.[0] === "claude") {
					claudeCalled = true;
					return mockSpawnResult("resolved content from AI\n", "", 0);
				}
				return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
			};

			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

			try {
				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: true,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(claudeCalled).toBe(true);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("ai-resolve");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("ai-resolve");
			} finally {
				spawnSpy.mockRestore();
			}
		});
	});

	describe("Tier 4: Re-imagine", () => {
		// After the first test (reimagine=false), the resolver aborts the merge and
		// leaves the repo clean. The second test can retry the merge on the same repo.
		let repoDir: string;
		let defaultBranch: string;

		beforeAll(async () => {
			repoDir = await createTempGitRepo();
			defaultBranch = await getDefaultBranch(repoDir);
			await setupReimagineScenario(repoDir, defaultBranch);
		});

		afterAll(async () => {
			await cleanupTempDir(repoDir);
		});

		// This test MUST run first -- it fails to merge and aborts, leaving repo clean
		test("is skipped when reimagineEnabled is false", async () => {
			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/reimagine-target.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, defaultBranch, repoDir);

			expect(result.success).toBe(false);
			expect(result.entry.status).toBe("failed");
		});

		// This test runs second -- repo is clean from the abort, same conflict is available
		test("aborts merge and reimplements when reimagineEnabled is true", async () => {
			// Selective spy: mock only claude, let git commands through.
			const originalSpawn = Bun.spawn;
			let claudeCalled = false;

			const selectiveMock = (...args: unknown[]): unknown => {
				const cmd = args[0] as string[];
				if (cmd?.[0] === "claude") {
					claudeCalled = true;
					return mockSpawnResult("reimagined content\n", "", 0);
				}
				return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
			};

			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

			try {
				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/reimagine-target.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: true,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(claudeCalled).toBe(true);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("reimagine");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("reimagine");

				// Verify the reimagined content was written
				const file = Bun.file(join(repoDir, "src/reimagine-target.ts"));
				const content = await file.text();
				expect(content).toBe("reimagined content\n");
			} finally {
				spawnSpy.mockRestore();
			}
		});
	});

	describe("All tiers fail", () => {
		test("returns failed status and repo is clean when all tiers fail", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(false);
				expect(result.entry.status).toBe("failed");
				expect(result.entry.resolvedTier).toBeNull();
				expect(result.errorMessage).not.toBeNull();
				expect(result.errorMessage).toContain("failed");

				// Verify the repo is in a clean state (merge was aborted)
				const status = await runGitInDir(repoDir, ["status", "--porcelain"]);
				expect(status.trim()).toBe("");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("result shape", () => {
		let repoDir: string;
		let defaultBranch: string;

		beforeEach(async () => {
			repoDir = await createTempGitRepo();
			defaultBranch = await getDefaultBranch(repoDir);
		});

		afterEach(async () => {
			await cleanupTempDir(repoDir);
		});

		test("successful result has correct MergeResult shape", async () => {
			await setupCleanMerge(repoDir, defaultBranch);

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(
				makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				}),
				defaultBranch,
				repoDir,
			);

			expect(result).toHaveProperty("entry");
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("tier");
			expect(result).toHaveProperty("conflictFiles");
			expect(result).toHaveProperty("errorMessage");
			expect(result).toHaveProperty("warnings");
		});

		test("failed result preserves original entry fields", async () => {
			await setupDeleteModifyConflict(repoDir, defaultBranch, "overstory/my-agent/bead-xyz");

			const entry = makeTestEntry({
				branchName: "overstory/my-agent/bead-xyz",
				taskId: "bead-xyz",
				agentName: "my-agent",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, defaultBranch, repoDir);

			expect(result.entry.branchName).toBe("overstory/my-agent/bead-xyz");
			expect(result.entry.taskId).toBe("bead-xyz");
			expect(result.entry.agentName).toBe("my-agent");
		});
	});

	describe("checkout skip when already on canonical branch", () => {
		test("succeeds when already on canonical branch (skips checkout)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				// Verify we're on the default branch
				const branch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
				expect(branch.trim()).toBe(defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("checks out canonical when on a different branch", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				// Switch to a different branch
				await runGitInDir(repoDir, ["checkout", "-b", "some-other-branch"]);
				const branch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
				expect(branch.trim()).toBe("some-other-branch");

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("looksLikeProse", () => {
		test("detects conversational prose", () => {
			expect(looksLikeProse("I need permission to edit the file")).toBe(true);
			expect(looksLikeProse("Here's the resolved content:")).toBe(true);
			expect(looksLikeProse("Here is the file")).toBe(true);
			expect(looksLikeProse("The conflict can be resolved by")).toBe(true);
			expect(looksLikeProse("Let me resolve this for you")).toBe(true);
			expect(looksLikeProse("Sure, here's the resolved file")).toBe(true);
			expect(looksLikeProse("I cannot access the file")).toBe(true);
			expect(looksLikeProse("I don't have access")).toBe(true);
			expect(looksLikeProse("To resolve this, we need to")).toBe(true);
			expect(looksLikeProse("Looking at the conflict")).toBe(true);
			expect(looksLikeProse("Based on both versions")).toBe(true);
		});

		test("detects markdown fencing", () => {
			expect(looksLikeProse("```typescript\nconst x = 1;\n```")).toBe(true);
			expect(looksLikeProse("```\nsome code\n```")).toBe(true);
		});

		test("detects empty output", () => {
			expect(looksLikeProse("")).toBe(true);
			expect(looksLikeProse("   ")).toBe(true);
		});

		test("accepts valid code", () => {
			expect(looksLikeProse("const x = 1;")).toBe(false);
			expect(looksLikeProse("import { foo } from 'bar';")).toBe(false);
			expect(looksLikeProse("export function resolve() {}")).toBe(false);
			expect(looksLikeProse("function hello() {\n  return 'world';\n}")).toBe(false);
			expect(looksLikeProse("// comment\nconst a = 1;")).toBe(false);
		});
	});

	describe("hasContentfulCanonical", () => {
		test("returns true when canonical side has content", () => {
			const content = [
				"<<<<<<< HEAD\n",
				"canonical content\n",
				"=======\n",
				"incoming content\n",
				">>>>>>> feature-branch\n",
			].join("");
			expect(hasContentfulCanonical(content)).toBe(true);
		});

		test("returns false when canonical side is empty", () => {
			const content = [
				"<<<<<<< HEAD\n",
				"=======\n",
				"incoming content\n",
				">>>>>>> feature-branch\n",
			].join("");
			expect(hasContentfulCanonical(content)).toBe(false);
		});

		test("returns false when canonical is whitespace only", () => {
			const content = [
				"<<<<<<< HEAD\n",
				"   \n",
				"\t\n",
				"=======\n",
				"incoming content\n",
				">>>>>>> feature-branch\n",
			].join("");
			expect(hasContentfulCanonical(content)).toBe(false);
		});

		test("returns false when no conflict markers", () => {
			expect(hasContentfulCanonical("no conflicts here\n")).toBe(false);
			expect(hasContentfulCanonical("")).toBe(false);
		});

		test("returns true if ANY block has canonical content (multiple blocks)", () => {
			const block1 = "<<<<<<< HEAD\n=======\nonly incoming\n>>>>>>> branch\n";
			const block2 = "<<<<<<< HEAD\ncanonical content\n=======\nincoming\n>>>>>>> branch\n";
			const content = `${block1}middle\n${block2}`;
			expect(hasContentfulCanonical(content)).toBe(true);
		});
	});

	describe("auto-resolve: content protection", () => {
		test("auto-resolve skips files with contentful canonical, result includes warning", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				// setupContentConflict: both canonical and incoming have content
				await setupContentConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				// AI and reimagine disabled — should FAIL because auto-resolve correctly refuses
				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(false);
				expect(result.warnings.length).toBeGreaterThan(0);
				expect(result.warnings[0]).toContain("src/test.ts");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("untracked files: no silent commit", () => {
		test("untracked overlapping files are deleted, not committed", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				// Place an untracked file at the path the feature branch will bring in
				await Bun.write(`${repoDir}/src/feature-file.ts`, "local untracked content\n");

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.warnings.some((w) => w.includes("src/feature-file.ts"))).toBe(true);

				// Verify git log does NOT contain the "commit untracked files before merge" commit
				const log = await runGitInDir(repoDir, ["log", "--oneline"]);
				expect(log).not.toContain("commit untracked files before merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Tier 3: AI-resolve prose rejection", () => {
		test("rejects prose output and falls through to failure", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const originalSpawn = Bun.spawn;
				const selectiveMock = (...args: unknown[]): unknown => {
					const cmd = args[0] as string[];
					if (cmd?.[0] === "claude") {
						// Return prose instead of code
						return mockSpawnResult(
							"I need permission to edit the file. Here's the resolved content:\n```\nresolved\n```",
							"",
							0,
						);
					}
					return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
				};

				const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

				try {
					const entry = makeTestEntry({
						branchName: "feature-branch",
						filesModified: ["src/test.ts"],
					});

					const resolver = createMergeResolver({
						aiResolveEnabled: true,
						reimagineEnabled: false,
					});

					const result = await resolver.resolve(entry, defaultBranch, repoDir);

					// Should fail because prose was rejected
					expect(result.success).toBe(false);
				} finally {
					spawnSpy.mockRestore();
				}
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Conflict pattern recording", () => {
		test("no recording when mulchClient is not provided (backward compatible)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				// Use empty-canonical setup so auto-resolve completes successfully
				await setupEmptyCanonicalConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				// No mulchClient passed — should work as before
				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("auto-resolve");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("records pattern on tier 2 auto-resolve success", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				// Use empty-canonical setup so auto-resolve completes successfully
				await setupEmptyCanonicalConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					taskId: "bead-abc-123",
					agentName: "test-builder",
					filesModified: ["src/test.ts"],
				});

				// Create a mock MulchClient with a spy on record
				const recordCalls: Array<{
					domain: string;
					options: {
						type: string;
						description?: string;
						tags?: string[];
						evidenceBead?: string;
					};
				}> = [];

				const mockMulchClient = createMockMulchClient(async (domain, options) => {
					recordCalls.push({
						domain,
						options: options as {
							type: string;
							description?: string;
							tags?: string[];
							evidenceBead?: string;
						},
					});
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("auto-resolve");

				// Verify record was called
				expect(recordCalls.length).toBe(1);
				const call = recordCalls[0];
				expect(call?.domain).toBe("architecture");
				expect(call?.options.type).toBe("pattern");
				expect(call?.options.tags).toContain("merge-conflict");
				expect(call?.options.evidenceBead).toBe("bead-abc-123");

				// Verify description contains key details
				const desc = call?.options.description ?? "";
				expect(desc).toContain("resolved");
				expect(desc).toContain("auto-resolve");
				expect(desc).toContain("feature-branch");
				expect(desc).toContain("test-builder");
				expect(desc).toContain("src/test.ts");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("records pattern on total failure", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					taskId: "bead-fail-456",
					agentName: "test-agent",
					filesModified: ["src/test.ts"],
				});

				const recordCalls: Array<{
					domain: string;
					options: {
						type: string;
						description?: string;
						tags?: string[];
						evidenceBead?: string;
					};
				}> = [];

				const mockMulchClient = createMockMulchClient(async (domain, options) => {
					recordCalls.push({
						domain,
						options: options as {
							type: string;
							description?: string;
							tags?: string[];
							evidenceBead?: string;
						},
					});
				});

				// AI and reimagine disabled — will fail at tier 2
				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(false);

				// Verify record was called for failure
				expect(recordCalls.length).toBe(1);
				const call = recordCalls[0];
				expect(call?.domain).toBe("architecture");
				expect(call?.options.type).toBe("pattern");
				expect(call?.options.evidenceBead).toBe("bead-fail-456");

				// Verify description contains "failed" not "resolved"
				const desc = call?.options.description ?? "";
				expect(desc).toContain("failed");
				expect(desc).not.toContain("resolved");
				expect(desc).toContain("auto-resolve"); // last attempted tier
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("recording failure does not affect merge result (fire-and-forget)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				// Use empty-canonical setup so auto-resolve completes successfully
				await setupEmptyCanonicalConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				// Mock mulchClient whose record rejects
				const mockMulchClient = createMockMulchClient(async () => {
					throw new Error("Mulch recording failed!");
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				// Should still succeed despite recording failure (fire-and-forget)
				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("auto-resolve");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("records pattern on tier 3 ai-resolve success", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					taskId: "bead-ai-789",
					filesModified: ["src/test.ts"],
				});

				const recordCalls: Array<{
					domain: string;
					options: {
						type: string;
						description?: string;
						tags?: string[];
						evidenceBead?: string;
					};
				}> = [];

				const mockMulchClient = createMockMulchClient(async (domain, options) => {
					recordCalls.push({
						domain,
						options: options as {
							type: string;
							description?: string;
							tags?: string[];
							evidenceBead?: string;
						},
					});
				});

				// Mock claude to succeed
				const originalSpawn = Bun.spawn;
				const selectiveMock = (...args: unknown[]): unknown => {
					const cmd = args[0] as string[];
					if (cmd?.[0] === "claude") {
						return mockSpawnResult("resolved content from AI\n", "", 0);
					}
					return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
				};

				const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

				try {
					const resolver = createMergeResolver({
						aiResolveEnabled: true,
						reimagineEnabled: false,
						mulchClient: mockMulchClient,
					});

					const result = await resolver.resolve(entry, defaultBranch, repoDir);

					expect(result.success).toBe(true);
					expect(result.tier).toBe("ai-resolve");

					// Verify record was called
					expect(recordCalls.length).toBe(1);
					const call = recordCalls[0];
					expect(call?.domain).toBe("architecture");
					expect(call?.options.evidenceBead).toBe("bead-ai-789");

					const desc = call?.options.description ?? "";
					expect(desc).toContain("resolved");
					expect(desc).toContain("ai-resolve");
				} finally {
					spawnSpy.mockRestore();
				}
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("records pattern on tier 4 reimagine success", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupReimagineScenario(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					taskId: "bead-reimagine-xyz",
					filesModified: ["src/reimagine-target.ts"],
				});

				const recordCalls: Array<{
					domain: string;
					options: {
						type: string;
						description?: string;
						tags?: string[];
						evidenceBead?: string;
					};
				}> = [];

				const mockMulchClient = createMockMulchClient(async (domain, options) => {
					recordCalls.push({
						domain,
						options: options as {
							type: string;
							description?: string;
							tags?: string[];
							evidenceBead?: string;
						},
					});
				});

				// Mock claude to succeed
				const originalSpawn = Bun.spawn;
				const selectiveMock = (...args: unknown[]): unknown => {
					const cmd = args[0] as string[];
					if (cmd?.[0] === "claude") {
						return mockSpawnResult("reimagined content\n", "", 0);
					}
					return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
				};

				const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

				try {
					const resolver = createMergeResolver({
						aiResolveEnabled: false,
						reimagineEnabled: true,
						mulchClient: mockMulchClient,
					});

					const result = await resolver.resolve(entry, defaultBranch, repoDir);

					expect(result.success).toBe(true);
					expect(result.tier).toBe("reimagine");

					// Verify record was called
					expect(recordCalls.length).toBe(1);
					const call = recordCalls[0];
					expect(call?.domain).toBe("architecture");
					expect(call?.options.evidenceBead).toBe("bead-reimagine-xyz");

					const desc = call?.options.description ?? "";
					expect(desc).toContain("resolved");
					expect(desc).toContain("reimagine");
				} finally {
					spawnSpy.mockRestore();
				}
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("no recording on tier 1 clean merge (no conflict)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const recordCalls: Array<unknown> = [];

				const mockMulchClient = createMockMulchClient(async (domain, options) => {
					recordCalls.push({ domain, options });
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");

				// No recording on clean merge (no conflict occurred)
				expect(recordCalls.length).toBe(0);
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("parseConflictPatterns", () => {
		test("parses successful resolution pattern", () => {
			const input =
				"Merge conflict resolved at tier auto-resolve. Branch: feature-branch. Agent: test-builder. Conflicting files: src/test.ts.";
			const patterns = parseConflictPatterns(input);
			expect(patterns.length).toBe(1);
			expect(patterns[0]?.tier).toBe("auto-resolve");
			expect(patterns[0]?.success).toBe(true);
			expect(patterns[0]?.files).toEqual(["src/test.ts"]);
			expect(patterns[0]?.agent).toBe("test-builder");
			expect(patterns[0]?.branch).toBe("feature-branch");
		});

		test("parses failed resolution pattern", () => {
			const input =
				"Merge conflict failed at tier ai-resolve. Branch: other-branch. Agent: my-agent. Conflicting files: src/foo.ts, src/bar.ts.";
			const patterns = parseConflictPatterns(input);
			expect(patterns.length).toBe(1);
			expect(patterns[0]?.tier).toBe("ai-resolve");
			expect(patterns[0]?.success).toBe(false);
			expect(patterns[0]?.files).toEqual(["src/foo.ts", "src/bar.ts"]);
		});

		test("parses multiple patterns from search output", () => {
			const input = [
				"Some mulch header text",
				"Merge conflict resolved at tier auto-resolve. Branch: b1. Agent: a1. Conflicting files: src/a.ts.",
				"Other text in between",
				"Merge conflict failed at tier reimagine. Branch: b2. Agent: a2. Conflicting files: src/b.ts, src/c.ts.",
			].join("\n");
			const patterns = parseConflictPatterns(input);
			expect(patterns.length).toBe(2);
		});

		test("returns empty array for no matches", () => {
			expect(parseConflictPatterns("")).toEqual([]);
			expect(parseConflictPatterns("no patterns here")).toEqual([]);
		});
	});

	describe("buildConflictHistory", () => {
		test("returns empty history when no patterns match entry files", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "auto-resolve",
					success: true,
					files: ["unrelated.ts"],
					agent: "a",
					branch: "b",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.skipTiers).toEqual([]);
			expect(history.pastResolutions).toEqual([]);
			expect(history.predictedConflictFiles).toEqual([]);
		});

		test("builds skip tier list when tier fails >= 2 times with no successes", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "ai-resolve",
					success: false,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b1",
				},
				{
					tier: "ai-resolve",
					success: false,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b2",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.skipTiers).toContain("ai-resolve");
		});

		test("does not skip tier if it has any successes", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "ai-resolve",
					success: false,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b1",
				},
				{
					tier: "ai-resolve",
					success: false,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b2",
				},
				{
					tier: "ai-resolve",
					success: true,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b3",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.skipTiers).not.toContain("ai-resolve");
		});

		test("does not skip tier with only 1 failure", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "reimagine",
					success: false,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b1",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.skipTiers).not.toContain("reimagine");
		});

		test("collects past successful resolutions", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "auto-resolve",
					success: true,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b1",
				},
				{
					tier: "ai-resolve",
					success: true,
					files: ["src/test.ts", "src/other.ts"],
					agent: "b",
					branch: "b2",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.pastResolutions.length).toBe(2);
			expect(history.pastResolutions[0]).toContain("auto-resolve");
			expect(history.pastResolutions[1]).toContain("ai-resolve");
		});

		test("predicts conflict files from historical patterns", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "auto-resolve",
					success: true,
					files: ["src/test.ts", "src/utils.ts"],
					agent: "a",
					branch: "b1",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.predictedConflictFiles).toContain("src/test.ts");
			expect(history.predictedConflictFiles).toContain("src/utils.ts");
		});

		test("returns empty history for empty patterns array", () => {
			const history = buildConflictHistory([], ["src/test.ts"]);
			expect(history.skipTiers).toEqual([]);
			expect(history.pastResolutions).toEqual([]);
			expect(history.predictedConflictFiles).toEqual([]);
		});
	});

	describe("Conflict history tier skipping", () => {
		test("skips auto-resolve tier when history says it always fails for these files", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				// Mock mulchClient that returns history showing auto-resolve always fails
				const mockMulchClient = createMockMulchClient();
				mockMulchClient.search = async () => {
					return [
						"Merge conflict failed at tier auto-resolve. Branch: b1. Agent: a1. Conflicting files: src/test.ts.",
						"Merge conflict failed at tier auto-resolve. Branch: b2. Agent: a2. Conflicting files: src/test.ts.",
					].join("\n");
				};

				// AI and reimagine disabled, auto-resolve should be skipped -> fails immediately
				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				// Should fail, and the last tier should NOT be auto-resolve (it was skipped)
				expect(result.success).toBe(false);
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("resolveConflictsUnion", () => {
		test("returns null when no conflict markers are present", () => {
			expect(resolveConflictsUnion("no conflicts here\n")).toBeNull();
			expect(resolveConflictsUnion("")).toBeNull();
		});

		test("keeps both canonical and incoming content for a single conflict", () => {
			const content = [
				"<<<<<<< HEAD\n",
				'{"id":"a"}\n',
				'{"id":"c"}\n',
				"=======\n",
				'{"id":"a"}\n',
				'{"id":"b"}\n',
				">>>>>>> feature-branch\n",
			].join("");
			const result = resolveConflictsUnion(content);
			expect(result).not.toBeNull();
			expect(result).toContain('{"id":"a"}\n{"id":"c"}\n');
			expect(result).toContain('{"id":"a"}\n{"id":"b"}\n');
			// No conflict markers remain
			expect(result).not.toContain("<<<<<<<");
			expect(result).not.toContain("=======");
			expect(result).not.toContain(">>>>>>>");
		});

		test("resolves multiple conflict blocks with union strategy", () => {
			const block = (canonical: string, incoming: string): string =>
				`<<<<<<< HEAD\n${canonical}\n=======\n${incoming}\n>>>>>>> branch\n`;
			const content = `${block("line-a\n", "line-b\n")}middle\n${block("line-c\n", "line-d\n")}`;
			const result = resolveConflictsUnion(content);
			expect(result).not.toBeNull();
			expect(result).toContain("line-a\n");
			expect(result).toContain("line-b\n");
			expect(result).toContain("middle\n");
			expect(result).toContain("line-c\n");
			expect(result).toContain("line-d\n");
			expect(result).not.toContain("<<<<<<<");
		});
	});

	describe("merge=union gitattribute support", () => {
		test("union strategy preserves lines from both sides (git handles cleanly or via auto-resolve)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);

				// Set up .gitattributes with merge=union for *.jsonl files so that
				// both git's built-in union driver AND overstory's Tier 2 union path
				// are configured to keep all lines from both sides.
				await commitFile(repoDir, ".gitattributes", "*.jsonl merge=union\n");
				// Common ancestor: one line
				await commitFile(repoDir, "data.jsonl", '{"id":"a"}\n');

				// Feature branch: adds line b
				await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
				await commitFile(repoDir, "data.jsonl", '{"id":"a"}\n{"id":"b"}\n');

				// Back to main: adds line c (diverges from ancestor)
				await runGitInDir(repoDir, ["checkout", defaultBranch]);
				await commitFile(repoDir, "data.jsonl", '{"id":"a"}\n{"id":"c"}\n');

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["data.jsonl"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				// With merge=union, git either resolves cleanly (Tier 1) or
				// overstory's union path handles it (Tier 2). Either way, success
				// and both sides' content must be preserved.
				expect(result.success).toBe(true);
				expect(result.entry.status).toBe("merged");

				// Both sides' lines must be present — no lines dropped
				const file = Bun.file(join(repoDir, "data.jsonl"));
				const content = await file.text();
				expect(content).toContain('{"id":"a"}');
				expect(content).toContain('{"id":"b"}');
				expect(content).toContain('{"id":"c"}');
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("Tier 2 union auto-resolve keeps both sides when git produces conflict markers", async () => {
			// This test verifies the Tier 2 code path: when git produces conflict
			// markers for a file that has merge=union set in .gitattributes,
			// overstory resolves it by keeping both canonical and incoming content.
			// We produce conflict markers by doing a content conflict on a file whose
			// attribute is set to merge=union AFTER the conflict state exists, then
			// run only the auto-resolve path via a standalone resolver call.
			//
			// To force conflict markers despite merge=union: we DON'T commit
			// .gitattributes before the merge, so git uses the default driver and
			// produces conflict markers. Then we write .gitattributes to the working
			// tree (not committed) so git check-attr sees it and our code detects union.
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);

				// Common ancestor
				await commitFile(repoDir, "data.jsonl", '{"id":"a"}\n');

				// Feature branch: adds line b (also appends to same position as main)
				await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
				await commitFile(repoDir, "data.jsonl", '{"id":"a"}\n{"id":"b"}\n');

				// Back to main: adds line c — diverges from ancestor at same position
				await runGitInDir(repoDir, ["checkout", defaultBranch]);
				await commitFile(repoDir, "data.jsonl", '{"id":"a"}\n{"id":"c"}\n');

				// Now WRITE .gitattributes to working tree (not committed).
				// git check-attr reads from the working tree during Tier 2.
				await Bun.write(`${repoDir}/.gitattributes`, "*.jsonl merge=union\n");

				// Attempt merge — git uses default driver (no committed .gitattributes)
				// so it WILL produce conflict markers if branches diverge at same position.
				// (If git resolves cleanly, the test still passes because content is preserved.)
				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["data.jsonl"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.entry.status).toBe("merged");

				const file = Bun.file(join(repoDir, "data.jsonl"));
				const content = await file.text();
				expect(content).toContain('{"id":"a"}');
				expect(content).toContain('{"id":"b"}');
				expect(content).toContain('{"id":"c"}');
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("queryConflictHistory uses sortByScore", () => {
		test("passes sortByScore: true to mulch search when querying conflict history", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupContentConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				// Capture search call options
				let capturedSearchOptions: unknown;
				const mockMulchClient = createMockMulchClient();
				mockMulchClient.search = async (_query, options) => {
					capturedSearchOptions = options;
					return "";
				};

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				await resolver.resolve(entry, defaultBranch, repoDir);

				// Verify sortByScore was passed to search
				expect(capturedSearchOptions).toMatchObject({ sortByScore: true });
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("AI-resolve with history context", () => {
		test("includes historical context in AI prompt when available", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				// Mock mulchClient that returns successful resolution history
				const mockMulchClient = createMockMulchClient();
				mockMulchClient.search = async () => {
					return "Merge conflict resolved at tier ai-resolve. Branch: old-branch. Agent: old-agent. Conflicting files: src/test.ts.";
				};

				// Capture the prompt sent to claude
				let capturedPrompt = "";
				const originalSpawn = Bun.spawn;
				const selectiveMock = (...args: unknown[]): unknown => {
					const cmd = args[0] as string[];
					if (cmd?.[0] === "claude") {
						// The prompt is the argument after `-p` (the print runtime prepends
						// flags like `--setting-sources`/`--disable-slash-commands`, so a
						// fixed index is brittle). Locate it by the flag instead.
						const pIdx = cmd.indexOf("-p");
						capturedPrompt = (pIdx >= 0 ? cmd[pIdx + 1] : undefined) ?? "";
						return mockSpawnResult("resolved content\n", "", 0);
					}
					return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
				};

				const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

				try {
					const resolver = createMergeResolver({
						aiResolveEnabled: true,
						reimagineEnabled: false,
						mulchClient: mockMulchClient,
					});

					const result = await resolver.resolve(entry, defaultBranch, repoDir);

					expect(result.success).toBe(true);
					expect(result.tier).toBe("ai-resolve");
					// Verify historical context was included in the prompt
					expect(capturedPrompt).toContain("Historical context");
					expect(capturedPrompt).toContain("ai-resolve");
				} finally {
					spawnSpy.mockRestore();
				}
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("onMergeSuccess callback", () => {
		test("callback is invoked on successful clean merge", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				let callbackCalled = false;
				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					onMergeSuccess: async (mergedEntry) => {
						callbackCalled = true;
						expect(mergedEntry.status).toBe("merged");
						expect(mergedEntry.resolvedTier).toBe("clean-merge");
					},
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(true);
				expect(callbackCalled).toBe(true);
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("callback is invoked on auto-resolve success", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				// Use empty-canonical setup so auto-resolve completes successfully
				await setupEmptyCanonicalConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				let callbackCalled = false;
				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					onMergeSuccess: async (mergedEntry) => {
						callbackCalled = true;
						expect(mergedEntry.resolvedTier).toBe("auto-resolve");
					},
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(true);
				expect(callbackCalled).toBe(true);
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("callback is NOT invoked on merge failure", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				let callbackCalled = false;
				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					onMergeSuccess: async () => {
						callbackCalled = true;
					},
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(false);
				expect(callbackCalled).toBe(false);
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("callback errors are swallowed and merge result is unaffected", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					onMergeSuccess: async () => {
						throw new Error("callback failure");
					},
				});

				// Should succeed despite the callback throwing
				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Untracked files blocking merge", () => {
		test("untracked files in merge path are auto-committed and merge succeeds", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);

				// Feature branch adds src/new-feature.ts
				await runGitInDir(repoDir, ["checkout", "-b", "feature-branch"]);
				await commitFile(repoDir, "src/new-feature.ts", "feature content\n");
				await runGitInDir(repoDir, ["checkout", defaultBranch]);

				// Create the same file as untracked in the working directory —
				// without our fix, git merge would fail: "untracked file would be overwritten"
				await Bun.write(`${repoDir}/src/new-feature.ts`, "feature content\n");

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/new-feature.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("untracked files NOT in entry.filesModified are left alone", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				// Untracked file NOT in filesModified — should not be touched
				await Bun.write(`${repoDir}/src/scratch.ts`, "scratch work\n");

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(true);

				// Untracked file should still exist and be untracked
				const scratchContent = await Bun.file(`${repoDir}/src/scratch.ts`).text();
				expect(scratchContent).toBe("scratch work\n");
				const status = await runGitInDir(repoDir, ["status", "--porcelain"]);
				expect(status).toContain("src/scratch.ts");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});
});
