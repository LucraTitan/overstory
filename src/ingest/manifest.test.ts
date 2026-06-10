/**
 * Tests for the manifest module.
 * Tests: classifySource (new/unchanged/changed), hashContent determinism, B7 corrupt manifest.
 * File I/O is thin and separable from pure functions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySource, hashContent, loadManifest } from "./manifest.ts";
import type { IngestionManifest } from "./schema.ts";

// --- hashContent ---

describe("hashContent", () => {
	test("returns sha256:<hex> format", () => {
		const hash = hashContent(Buffer.from("hello world"));
		expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	test("deterministic: same bytes → same hash", () => {
		const bytes = Buffer.from("test content");
		expect(hashContent(bytes)).toBe(hashContent(bytes));
	});

	test("different bytes → different hash", () => {
		const h1 = hashContent(Buffer.from("content A"));
		const h2 = hashContent(Buffer.from("content B"));
		expect(h1).not.toBe(h2);
	});

	test("empty bytes produce a valid hash", () => {
		const hash = hashContent(Buffer.from(""));
		expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

// --- classifySource ---

describe("classifySource", () => {
	const emptyManifest: IngestionManifest = {
		schemaVersion: 1,
		sources: {},
	};

	const populatedManifest: IngestionManifest = {
		schemaVersion: 1,
		sources: {
			"docs/prd.md": {
				contentHash: "sha256:abc123",
				ingestedAt: "2026-06-09T12:00:00Z",
				groups: [],
			},
		},
	};

	test("path not in manifest → 'new'", () => {
		const result = classifySource(emptyManifest, "docs/prd.md", "sha256:abc123");
		expect(result).toBe("new");
	});

	test("path in manifest, same hash → 'unchanged'", () => {
		const result = classifySource(populatedManifest, "docs/prd.md", "sha256:abc123");
		expect(result).toBe("unchanged");
	});

	test("path in manifest, different hash → 'changed'", () => {
		const result = classifySource(populatedManifest, "docs/prd.md", "sha256:different");
		expect(result).toBe("changed");
	});

	test("path in manifest but different path key → 'new'", () => {
		const result = classifySource(populatedManifest, "docs/other.md", "sha256:abc123");
		expect(result).toBe("new");
	});

	test("entry with partial:true and MATCHING hash → 'changed' (not 'unchanged')", () => {
		// This is the core regression guard: a partial entry with the same hash must NOT no-op.
		const partialManifest: IngestionManifest = {
			schemaVersion: 1,
			sources: {
				"docs/prd.md": {
					contentHash: "sha256:abc123",
					ingestedAt: "2026-06-09T12:00:00Z",
					groups: [],
					partial: true,
				},
			},
		};
		const result = classifySource(partialManifest, "docs/prd.md", "sha256:abc123");
		expect(result).toBe("changed");
	});

	test("entry with partial:true and DIFFERENT hash → 'changed'", () => {
		const partialManifest: IngestionManifest = {
			schemaVersion: 1,
			sources: {
				"docs/prd.md": {
					contentHash: "sha256:abc123",
					ingestedAt: "2026-06-09T12:00:00Z",
					groups: [],
					partial: true,
				},
			},
		};
		const result = classifySource(partialManifest, "docs/prd.md", "sha256:different");
		expect(result).toBe("changed");
	});
});

// --- FIX 3: wrong-shape manifest → AgentError (not late TypeError) ---

describe("loadManifest — FIX 3: wrong-shape manifest throws AgentError", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-manifest-shape-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test('valid JSON but wrong shape {"foo":1} → AgentError with clear message', async () => {
		const shapePath = join(tempDir, "wrong-shape.json");
		await writeFile(shapePath, JSON.stringify({ foo: 1 }), "utf8");

		let thrownError: unknown;
		try {
			await loadManifest(shapePath);
		} catch (err) {
			thrownError = err;
		}

		expect(thrownError).toBeDefined();
		const msg = thrownError instanceof Error ? thrownError.message : String(thrownError);
		expect(msg).toContain("invalid shape");
		// Must NOT be a raw TypeError (the "late crash" path)
		expect(thrownError?.constructor?.name).not.toBe("TypeError");
	});

	test("valid JSON but null → AgentError", async () => {
		const nullPath = join(tempDir, "null.json");
		await writeFile(nullPath, "null", "utf8");

		let thrownError: unknown;
		try {
			await loadManifest(nullPath);
		} catch (err) {
			thrownError = err;
		}

		expect(thrownError).toBeDefined();
		const msg = thrownError instanceof Error ? thrownError.message : String(thrownError);
		expect(msg).toContain("invalid shape");
	});

	test("valid JSON with sources as array (wrong type) → AgentError", async () => {
		const arrPath = join(tempDir, "array-sources.json");
		await writeFile(arrPath, JSON.stringify({ schemaVersion: 1, sources: [] }), "utf8");

		let thrownError: unknown;
		try {
			await loadManifest(arrPath);
		} catch (err) {
			thrownError = err;
		}

		expect(thrownError).toBeDefined();
		const msg = thrownError instanceof Error ? thrownError.message : String(thrownError);
		expect(msg).toContain("invalid shape");
	});

	test("missing file still returns empty manifest (FIX 3 does not regress ENOENT handling)", async () => {
		const result = await loadManifest(join(tempDir, "does-not-exist.json"));
		expect(result.schemaVersion).toBe(1);
		expect(result.sources).toEqual({});
	});

	test("valid manifest shape passes without throwing", async () => {
		const validPath = join(tempDir, "valid.json");
		const validManifest = { schemaVersion: 1, sources: {} };
		await writeFile(validPath, JSON.stringify(validManifest), "utf8");

		const result = await loadManifest(validPath);
		expect(result.schemaVersion).toBe(1);
		expect(result.sources).toEqual({});
	});
});

// --- B7: corrupt manifest → clear AgentError ---

describe("loadManifest — B7: corrupt JSON throws AgentError with clear message", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-manifest-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("corrupt manifest file throws AgentError (not raw SyntaxError)", async () => {
		const corruptPath = join(tempDir, "corrupt-manifest.json");
		await writeFile(corruptPath, "{ this is not valid json }", "utf8");

		let thrownError: unknown;
		try {
			await loadManifest(corruptPath);
		} catch (err) {
			thrownError = err;
		}

		expect(thrownError).toBeDefined();
		// Must be an AgentError with a clear message, not a raw SyntaxError
		const msg = thrownError instanceof Error ? thrownError.message : String(thrownError);
		expect(msg).toContain("corrupt");
		expect(msg).toContain("JSON parse");
	});

	test("non-existent manifest returns empty manifest (not an error)", async () => {
		const missingPath = join(tempDir, "no-such-manifest.json");
		const result = await loadManifest(missingPath);
		expect(result.schemaVersion).toBe(1);
		expect(result.sources).toEqual({});
	});
});
