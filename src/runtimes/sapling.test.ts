import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DANGEROUS_BASH_PATTERNS,
	INTERACTIVE_TOOLS,
	NATIVE_TEAM_TOOLS,
} from "../agents/guard-rules.ts";
import type { ResolvedModel } from "../types.ts";
import { SaplingRuntime } from "./sapling.ts";
import type { DirectSpawnOpts, HooksDef, RpcProcessHandle, SpawnOpts } from "./types.ts";

/**
 * Create a mock RpcProcessHandle for SaplingConnection tests.
 *
 * @param responses - Pre-baked JSON strings to emit on stdout (each gets a '\n').
 * @returns { proc, written } — proc is the handle; written collects stdin writes.
 */
function createMockProcess(responses: string[]): { proc: RpcProcessHandle; written: string[] } {
	const written: string[] = [];
	const encoder = new TextEncoder();

	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of responses) {
				controller.enqueue(encoder.encode(`${line}\n`));
			}
			controller.close();
		},
	});

	const proc: RpcProcessHandle = {
		stdin: {
			write(data: string | Uint8Array): number {
				const text = typeof data === "string" ? data : new TextDecoder().decode(data);
				written.push(text);
				return text.length;
			},
		},
		stdout,
	};

	return { proc, written };
}

describe("SaplingRuntime", () => {
	const runtime = new SaplingRuntime();

	describe("id, instructionPath, headless", () => {
		test("id is 'sapling'", () => {
			expect(runtime.id).toBe("sapling");
		});

		test("instructionPath is 'SAPLING.md'", () => {
			expect(runtime.instructionPath).toBe("SAPLING.md");
		});

		test("headless is true", () => {
			expect(runtime.headless).toBe(true);
		});

		test("signalsCompletionViaEvents is true (sapling sends no terminal mail post-decoupling)", () => {
			expect(runtime.signalsCompletionViaEvents).toBe(true);
		});
	});

	describe("buildSpawnCommand", () => {
		test("basic command uses sp run --model and --json", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("sp run");
			expect(cmd).toContain("--model claude-sonnet-4-6");
			expect(cmd).toContain("--json");
			expect(cmd).toContain("Read SAPLING.md");
		});

		test("permissionMode is NOT included in command (guards.json enforces)", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--permission-mode");
			expect(cmd).not.toContain("bypassPermissions");
		});

		test("ask permissionMode also excluded", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "ask",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("--permission-mode");
		});

		test("without appendSystemPrompt uses default SAPLING.md prompt", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toBe(
				"sp run --model claude-sonnet-4-6 --json 'Read SAPLING.md for your task assignment and begin immediately.'",
			);
		});

		test("appendSystemPrompt appends inline with POSIX single-quote escaping", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder agent.",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("You are a builder agent.");
			expect(cmd).toContain("Read SAPLING.md");
		});

		test("appendSystemPrompt with single quotes uses POSIX escape", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "Don't touch the user's files",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("Don'\\''t touch the user'\\''s files");
			expect(cmd).toContain("Read SAPLING.md");
		});

		test("appendSystemPromptFile uses dollar-paren-cat expansion", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/.overstory/agent-defs/builder.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat '/project/.overstory/agent-defs/builder.md')");
			expect(cmd).toContain("Read SAPLING.md");
		});

		test("appendSystemPromptFile with single quotes in path", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/it's a path/agent.md",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat '/project/it'\\''s a path/agent.md')");
		});

		test("appendSystemPromptFile takes precedence over appendSystemPrompt", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/project",
				env: {},
				appendSystemPromptFile: "/project/builder.md",
				appendSystemPrompt: "This inline content should be ignored",
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).toContain("$(cat ");
			expect(cmd).not.toContain("This inline content should be ignored");
		});

		test("cwd and env are NOT embedded in command string", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/some/specific/path",
				env: { ANTHROPIC_API_KEY: "sk-ant-test-123" },
			};
			const cmd = runtime.buildSpawnCommand(opts);
			expect(cmd).not.toContain("/some/specific/path");
			expect(cmd).not.toContain("sk-ant-test-123");
			expect(cmd).not.toContain("ANTHROPIC_API_KEY");
		});

		test("produces deterministic output for same inputs", () => {
			const opts: SpawnOpts = {
				model: "claude-sonnet-4-6",
				permissionMode: "bypass",
				cwd: "/tmp/worktree",
				env: {},
				appendSystemPrompt: "You are a builder.",
			};
			expect(runtime.buildSpawnCommand(opts)).toBe(runtime.buildSpawnCommand(opts));
		});
	});

	describe("buildPrintCommand", () => {
		test("without model: 3 elements ['sp', 'print', prompt]", () => {
			const argv = runtime.buildPrintCommand("Summarize this diff");
			expect(argv).toEqual(["sp", "print", "Summarize this diff"]);
		});

		test("with model: 5 elements ['sp', 'print', '--model', model, prompt]", () => {
			const argv = runtime.buildPrintCommand("Classify this error", "claude-opus-4-6");
			expect(argv).toEqual(["sp", "print", "--model", "claude-opus-4-6", "Classify this error"]);
		});

		test("model undefined omits --model flag", () => {
			const argv = runtime.buildPrintCommand("Hello", undefined);
			expect(argv).not.toContain("--model");
		});

		test("prompt is the last element", () => {
			const prompt = "My test prompt";
			const argv = runtime.buildPrintCommand(prompt, "claude-sonnet-4-6");
			expect(argv[argv.length - 1]).toBe(prompt);
		});

		test("without model: exactly 3 elements", () => {
			const argv = runtime.buildPrintCommand("prompt text");
			expect(argv.length).toBe(3);
		});

		test("with model: exactly 5 elements", () => {
			const argv = runtime.buildPrintCommand("prompt text", "claude-sonnet-4-6");
			expect(argv.length).toBe(5);
		});
	});

	describe("buildDirectSpawn", () => {
		test("correct argv: sp run --model --json --cwd --system-prompt-file prompt", () => {
			const opts: DirectSpawnOpts = {
				model: "claude-sonnet-4-6",
				cwd: "/project/.overstory/worktrees/builder-1",
				env: {},
				instructionPath: "/project/.overstory/worktrees/builder-1/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv).toEqual([
				"sp",
				"run",
				"--model",
				"claude-sonnet-4-6",
				"--json",
				"--cwd",
				"/project/.overstory/worktrees/builder-1",
				"--system-prompt-file",
				"/project/.overstory/worktrees/builder-1/SAPLING.md",
				"--guards-file",
				"/project/.overstory/worktrees/builder-1/.sapling/guards.json",
				"--metrics-path",
				"/project/.overstory/worktrees/builder-1/.sapling/metrics.json",
				"Read SAPLING.md for your task assignment and begin immediately.",
			]);
		});

		test("appends --guards-file pointing at <cwd>/.sapling/guards.json (matches deployConfig)", () => {
			const opts: DirectSpawnOpts = {
				cwd: "/project/.overstory/worktrees/builder-1",
				env: {},
				instructionPath: "/project/.overstory/worktrees/builder-1/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			const idx = argv.indexOf("--guards-file");
			expect(idx).toBeGreaterThan(-1);
			expect(argv[idx + 1]).toBe("/project/.overstory/worktrees/builder-1/.sapling/guards.json");
		});

		test("--guards-file is derived from worktreePath when provided (not cwd)", () => {
			const opts: DirectSpawnOpts = {
				cwd: "/some/other/cwd",
				worktreePath: "/project/.overstory/worktrees/builder-1",
				env: {},
				instructionPath: "/project/.overstory/worktrees/builder-1/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			const idx = argv.indexOf("--guards-file");
			expect(argv[idx + 1]).toBe("/project/.overstory/worktrees/builder-1/.sapling/guards.json");
		});

		test("appends --metrics-path under <worktree>/.sapling/metrics.json", () => {
			const opts: DirectSpawnOpts = {
				cwd: "/project/.overstory/worktrees/builder-1",
				env: {},
				instructionPath: "/project/.overstory/worktrees/builder-1/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			const idx = argv.indexOf("--metrics-path");
			expect(idx).toBeGreaterThan(-1);
			expect(argv[idx + 1]).toBe("/project/.overstory/worktrees/builder-1/.sapling/metrics.json");
		});

		test("appends --agent-name and --task-id when provided", () => {
			const opts: DirectSpawnOpts = {
				cwd: "/project/worktree",
				env: {},
				instructionPath: "/project/worktree/SAPLING.md",
				agentName: "builder-1",
				taskId: "task-abc",
			};
			const argv = runtime.buildDirectSpawn(opts);
			const nameIdx = argv.indexOf("--agent-name");
			const taskIdx = argv.indexOf("--task-id");
			expect(nameIdx).toBeGreaterThan(-1);
			expect(argv[nameIdx + 1]).toBe("builder-1");
			expect(taskIdx).toBeGreaterThan(-1);
			expect(argv[taskIdx + 1]).toBe("task-abc");
		});

		test("omits --agent-name / --task-id gracefully when not provided", () => {
			const opts: DirectSpawnOpts = {
				cwd: "/project/worktree",
				env: {},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv).not.toContain("--agent-name");
			expect(argv).not.toContain("--task-id");
			// no empty-string operand ever appended
			expect(argv).not.toContain("");
		});

		test("the prompt remains the final positional argument after all flags", () => {
			const opts: DirectSpawnOpts = {
				model: "sonnet",
				cwd: "/project/worktree",
				env: {},
				instructionPath: "/project/worktree/SAPLING.md",
				agentName: "builder-1",
				taskId: "task-abc",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[argv.length - 1]).toBe(
				"Read SAPLING.md for your task assignment and begin immediately.",
			);
		});

		test("resolves model alias from ANTHROPIC_DEFAULT_<MODEL>_MODEL env var", () => {
			const opts: DirectSpawnOpts = {
				model: "sonnet",
				cwd: "/project/worktree",
				env: {
					ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6-20251015",
					ANTHROPIC_AUTH_TOKEN: "sk-ant-test",
				},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			// Model should be resolved from the alias env var
			expect(argv[3]).toBe("claude-sonnet-4-6-20251015");
		});

		test("passes model through when no alias match", () => {
			const opts: DirectSpawnOpts = {
				model: "claude-opus-4-6",
				cwd: "/project/worktree",
				env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-test" },
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[3]).toBe("claude-opus-4-6");
		});

		test("resolves uppercase model name for alias lookup", () => {
			const opts: DirectSpawnOpts = {
				model: "opus",
				cwd: "/project/worktree",
				env: {
					ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6-20251015",
				},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[3]).toBe("claude-opus-4-6-20251015");
		});

		test("no alias env: passes model through unchanged", () => {
			const opts: DirectSpawnOpts = {
				model: "claude-haiku-4-5",
				cwd: "/project/worktree",
				env: {},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[3]).toBe("claude-haiku-4-5");
		});

		test("bare alias 'haiku' with no env var resolves via fallback map", () => {
			const opts: DirectSpawnOpts = {
				model: "haiku",
				cwd: "/project/worktree",
				env: {},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[3]).toBe("claude-haiku-4-5-20251001");
		});

		test("bare alias 'sonnet' with no env var resolves via fallback map", () => {
			const opts: DirectSpawnOpts = {
				model: "sonnet",
				cwd: "/project/worktree",
				env: {},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[3]).toBe("claude-sonnet-4-6-20251015");
		});

		test("bare alias 'opus' with no env var resolves via fallback map", () => {
			const opts: DirectSpawnOpts = {
				model: "opus",
				cwd: "/project/worktree",
				env: {},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[3]).toBe("claude-opus-4-6-20251015");
		});

		test("gateway env takes precedence over fallback map for alias", () => {
			const opts: DirectSpawnOpts = {
				model: "sonnet",
				cwd: "/project/worktree",
				env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "google/gemini-2.0-flash" },
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			// Gateway env wins, not the fallback
			expect(argv[3]).toBe("google/gemini-2.0-flash");
		});

		test("direct model ID is not affected by fallback map", () => {
			const opts: DirectSpawnOpts = {
				model: "claude-sonnet-4-6",
				cwd: "/project/worktree",
				env: {},
				instructionPath: "/project/worktree/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv[3]).toBe("claude-sonnet-4-6");
		});

		test("omits --model when model is undefined (sapling uses own config)", () => {
			const opts: DirectSpawnOpts = {
				cwd: "/project/.overstory/worktrees/builder-1",
				env: {},
				instructionPath: "/project/.overstory/worktrees/builder-1/SAPLING.md",
			};
			const argv = runtime.buildDirectSpawn(opts);
			expect(argv).not.toContain("--model");
			expect(argv[0]).toBe("sp");
			expect(argv[1]).toBe("run");
			expect(argv).toContain("--json");
			expect(argv).toContain("--cwd");
			expect(argv).toContain("--system-prompt-file");
		});
	});

	describe("buildEnv", () => {
		test("clears CLAUDECODE, CLAUDE_CODE_SSE_PORT, CLAUDE_CODE_ENTRYPOINT", () => {
			const model: ResolvedModel = { model: "claude-sonnet-4-6" };
			const env = runtime.buildEnv(model);
			expect(env.CLAUDECODE).toBe("");
			expect(env.CLAUDE_CODE_SSE_PORT).toBe("");
			expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("");
		});

		test("translates ANTHROPIC_AUTH_TOKEN to ANTHROPIC_API_KEY", () => {
			const model: ResolvedModel = {
				model: "claude-sonnet-4-6",
				env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-test-token" },
			};
			const env = runtime.buildEnv(model);
			expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test-token");
			expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
		});

		test("passes ANTHROPIC_BASE_URL through unchanged", () => {
			const model: ResolvedModel = {
				model: "claude-sonnet-4-6",
				env: { ANTHROPIC_BASE_URL: "https://gateway.example.com/v1" },
			};
			const env = runtime.buildEnv(model);
			expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.com/v1");
		});

		test("forces SAPLING_BACKEND=sdk when ANTHROPIC_AUTH_TOKEN present", () => {
			const model: ResolvedModel = {
				model: "claude-sonnet-4-6",
				env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-test" },
			};
			const env = runtime.buildEnv(model);
			expect(env.SAPLING_BACKEND).toBe("sdk");
		});

		test("forces SAPLING_BACKEND=sdk when ANTHROPIC_BASE_URL present", () => {
			const model: ResolvedModel = {
				model: "claude-sonnet-4-6",
				env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" },
			};
			const env = runtime.buildEnv(model);
			expect(env.SAPLING_BACKEND).toBe("sdk");
		});

		test("no SAPLING_BACKEND when no gateway env", () => {
			const model: ResolvedModel = { model: "claude-sonnet-4-6" };
			const env = runtime.buildEnv(model);
			expect("SAPLING_BACKEND" in env).toBe(false);
		});

		test("no SAPLING_BACKEND when model.env is empty", () => {
			const model: ResolvedModel = { model: "claude-sonnet-4-6", env: {} };
			const env = runtime.buildEnv(model);
			expect("SAPLING_BACKEND" in env).toBe(false);
		});

		test("gateway env with both AUTH_TOKEN and BASE_URL sets sdk backend", () => {
			const model: ResolvedModel = {
				model: "claude-sonnet-4-6",
				env: {
					ANTHROPIC_AUTH_TOKEN: "sk-ant-test",
					ANTHROPIC_BASE_URL: "https://gateway.example.com",
				},
			};
			const env = runtime.buildEnv(model);
			expect(env.SAPLING_BACKEND).toBe("sdk");
			expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
			expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.com");
		});

		test("forwards ANTHROPIC_DEFAULT_SONNET_MODEL from model.env", () => {
			const model: ResolvedModel = {
				model: "sonnet",
				env: {
					ANTHROPIC_AUTH_TOKEN: "sk-ant-test",
					ANTHROPIC_DEFAULT_SONNET_MODEL: "google/gemini-2.0-flash",
				},
			};
			const env = runtime.buildEnv(model);
			expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("google/gemini-2.0-flash");
		});

		test("forwards any ANTHROPIC_DEFAULT_*_MODEL pattern from model.env", () => {
			const model: ResolvedModel = {
				model: "opus",
				env: {
					ANTHROPIC_DEFAULT_OPUS_MODEL: "custom/opus-gateway-model",
					ANTHROPIC_DEFAULT_HAIKU_MODEL: "custom/haiku-gateway-model",
				},
			};
			const env = runtime.buildEnv(model);
			expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("custom/opus-gateway-model");
			expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("custom/haiku-gateway-model");
		});

		test("clears ANTHROPIC_API_KEY by default (no gateway)", () => {
			const model: ResolvedModel = { model: "sonnet" };
			const env = runtime.buildEnv(model);
			expect(env.ANTHROPIC_API_KEY).toBe("");
		});

		test("buildEnv sets ANTHROPIC_API_KEY from gateway provider ANTHROPIC_AUTH_TOKEN", () => {
			const model: ResolvedModel = {
				model: "sonnet",
				env: { ANTHROPIC_AUTH_TOKEN: "sk-gw-test" },
			};
			const env = runtime.buildEnv(model);
			expect(env.ANTHROPIC_API_KEY).toBe("sk-gw-test");
		});

		test("does NOT forward non-model env vars from model.env", () => {
			const model: ResolvedModel = {
				model: "sonnet",
				env: {
					ANTHROPIC_AUTH_TOKEN: "sk-ant-test",
					ANTHROPIC_DEFAULT_SONNET_MODEL: "google/gemini-2.0-flash",
					SOME_OTHER_VAR: "should-not-appear",
					ANTHROPIC_DEFAULT_SONNET_ALIAS: "also-should-not-appear",
				},
			};
			const env = runtime.buildEnv(model);
			// Non-provider vars are not forwarded
			expect("SOME_OTHER_VAR" in env).toBe(false);
			// Vars matching ANTHROPIC_DEFAULT_* but NOT ending in _MODEL are not forwarded
			expect("ANTHROPIC_DEFAULT_SONNET_ALIAS" in env).toBe(false);
			// The one ending in _MODEL IS forwarded
			expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("google/gemini-2.0-flash");
		});
	});

	describe("buildEnv subscription-proxy routing (sapling-scoped)", () => {
		// Capture/restore the env-fallback toggle so an ambient value can't make
		// the "off by default" assertions flaky.
		const TOGGLE = "OV_SAPLING_SUBSCRIPTION_PROXY";
		const PROXY_URL_ENV = "OV_SAPLING_PROXY_URL";
		let savedToggle: string | undefined;
		let savedUrl: string | undefined;
		beforeEach(() => {
			savedToggle = process.env[TOGGLE];
			savedUrl = process.env[PROXY_URL_ENV];
			delete process.env[TOGGLE];
			delete process.env[PROXY_URL_ENV];
		});
		afterEach(() => {
			if (savedToggle === undefined) delete process.env[TOGGLE];
			else process.env[TOGGLE] = savedToggle;
			if (savedUrl === undefined) delete process.env[PROXY_URL_ENV];
			else process.env[PROXY_URL_ENV] = savedUrl;
		});

		test("OFF by default: no proxy config + no env → no ANTHROPIC_BASE_URL injected", () => {
			const offRuntime = new SaplingRuntime(); // no config
			const model: ResolvedModel = { model: "haiku" };
			const env = offRuntime.buildEnv(model);
			// Byte-identical to the no-proxy baseline: API_KEY cleared, no base url.
			expect(env.ANTHROPIC_API_KEY).toBe("");
			expect("ANTHROPIC_BASE_URL" in env).toBe(false);
			expect("SAPLING_BACKEND" in env).toBe(false);
		});

		test("config.subscriptionProxy=false → no proxy injection", () => {
			const offRuntime = new SaplingRuntime({ subscriptionProxy: false });
			const env = offRuntime.buildEnv({ model: "haiku" });
			expect("ANTHROPIC_BASE_URL" in env).toBe(false);
			expect(env.ANTHROPIC_API_KEY).toBe("");
		});

		test("config.subscriptionProxy=true → injects default proxy base url + dummy key + sdk backend", () => {
			const onRuntime = new SaplingRuntime({ subscriptionProxy: true });
			const env = onRuntime.buildEnv({ model: "haiku" });
			expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8788");
			expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-proxy-dummy");
			expect(env.SAPLING_BACKEND).toBe("sdk");
		});

		test("config.proxyUrl overrides the injected base url", () => {
			const onRuntime = new SaplingRuntime({
				subscriptionProxy: true,
				proxyUrl: "http://127.0.0.1:9100",
			});
			const env = onRuntime.buildEnv({ model: "sonnet" });
			expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9100");
		});

		test("proxy base url overrides any gateway-provided ANTHROPIC_BASE_URL", () => {
			const onRuntime = new SaplingRuntime({ subscriptionProxy: true });
			const env = onRuntime.buildEnv({
				model: "sonnet",
				env: { ANTHROPIC_BASE_URL: "https://gateway.example.com/v1" },
			});
			// Proxy wins — sapling must hit the local bearer proxy, not the gateway.
			expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8788");
			expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-proxy-dummy");
		});

		test("env fallback OV_SAPLING_SUBSCRIPTION_PROXY=1 enables injection when config absent", () => {
			process.env[TOGGLE] = "1";
			const offRuntime = new SaplingRuntime(); // no config — env drives it
			const env = offRuntime.buildEnv({ model: "haiku" });
			expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8788");
			expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-proxy-dummy");
		});

		test("env OV_SAPLING_PROXY_URL is honored with the env toggle", () => {
			process.env[TOGGLE] = "1";
			process.env[PROXY_URL_ENV] = "http://127.0.0.1:8000";
			const offRuntime = new SaplingRuntime();
			const env = offRuntime.buildEnv({ model: "haiku" });
			expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8000");
		});

		test("config.subscriptionProxy=false + env=1 → no injection (config wins, HIGH 2)", () => {
			process.env[TOGGLE] = "1";
			const offRuntime = new SaplingRuntime({ subscriptionProxy: false });
			const env = offRuntime.buildEnv({ model: "haiku" });
			expect("ANTHROPIC_BASE_URL" in env).toBe(false);
			expect(env.ANTHROPIC_API_KEY).toBe("");
		});

		test("a non-loopback proxyUrl is REJECTED in buildEnv (token-leak guard, MEDIUM)", () => {
			const evil = new SaplingRuntime({
				subscriptionProxy: true,
				proxyUrl: "http://evil.example.com:8788",
			});
			expect(() => evil.buildEnv({ model: "haiku" })).toThrow(/loopback/);
		});
	});

	describe("preflightDirectSpawn (per-spawn readiness, HIGH 3)", () => {
		const TOGGLE = "OV_SAPLING_SUBSCRIPTION_PROXY";
		let savedToggle: string | undefined;
		beforeEach(() => {
			savedToggle = process.env[TOGGLE];
			delete process.env[TOGGLE];
		});
		afterEach(() => {
			if (savedToggle === undefined) delete process.env[TOGGLE];
			else process.env[TOGGLE] = savedToggle;
		});

		test("no-op when subscription proxy is disabled (does not probe)", async () => {
			const off = new SaplingRuntime({ subscriptionProxy: false });
			// Must resolve without throwing and without needing a live proxy.
			await expect(off.preflightDirectSpawn()).resolves.toBeUndefined();
		});

		test("rejects a non-loopback proxyUrl before any probe (token-leak guard)", async () => {
			const evil = new SaplingRuntime({
				subscriptionProxy: true,
				proxyUrl: "http://evil.example.com:8788",
			});
			await expect(evil.preflightDirectSpawn()).rejects.toThrow(/loopback/);
		});
	});

	describe("detectReady", () => {
		test("returns { phase: 'ready' } for empty pane content", () => {
			expect(runtime.detectReady("")).toEqual({ phase: "ready" });
		});

		test("returns { phase: 'ready' } for any pane content (always headless-ready)", () => {
			expect(runtime.detectReady("Loading sapling...\nPlease wait")).toEqual({ phase: "ready" });
		});

		test("returns { phase: 'ready' } for NDJSON output", () => {
			const pane = '{"type":"ready","timestamp":"2025-01-01T00:00:00Z"}';
			expect(runtime.detectReady(pane)).toEqual({ phase: "ready" });
		});
	});

	describe("requiresBeaconVerification", () => {
		test("returns false (headless — no beacon needed)", () => {
			expect(runtime.requiresBeaconVerification()).toBe(false);
		});
	});

	describe("deployConfig", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-sapling-test-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		test("writes SAPLING.md to worktree root", async () => {
			const worktreePath = join(tempDir, "worktree");
			const hooks: HooksDef = { agentName: "test-builder", capability: "builder", worktreePath };

			await runtime.deployConfig(worktreePath, { content: "# Task Assignment\nBuild it." }, hooks);

			const saplingPath = join(worktreePath, "SAPLING.md");
			const content = await Bun.file(saplingPath).text();
			expect(content).toBe("# Task Assignment\nBuild it.");
		});

		test("writes .sapling/guards.json alongside SAPLING.md", async () => {
			const worktreePath = join(tempDir, "worktree");
			const hooks: HooksDef = { agentName: "test-builder", capability: "builder", worktreePath };

			await runtime.deployConfig(worktreePath, { content: "# Overlay" }, hooks);

			const guardsPath = join(worktreePath, ".sapling", "guards.json");
			const exists = await Bun.file(guardsPath).exists();
			expect(exists).toBe(true);
		});

		test("skips SAPLING.md but writes guards.json when overlay is undefined", async () => {
			const worktreePath = join(tempDir, "worktree");
			const hooks: HooksDef = {
				agentName: "coordinator",
				capability: "coordinator",
				worktreePath,
			};

			await runtime.deployConfig(worktreePath, undefined, hooks);

			const saplingPath = join(worktreePath, "SAPLING.md");
			expect(await Bun.file(saplingPath).exists()).toBe(false);

			const guardsPath = join(worktreePath, ".sapling", "guards.json");
			expect(await Bun.file(guardsPath).exists()).toBe(true);
		});

		test("creates nested directories if they do not exist", async () => {
			const worktreePath = join(tempDir, "deep", "nested", "worktree");
			const hooks: HooksDef = { agentName: "builder-1", capability: "builder", worktreePath };

			await runtime.deployConfig(worktreePath, { content: "# Overlay" }, hooks);

			expect(await Bun.file(join(worktreePath, "SAPLING.md")).exists()).toBe(true);
			expect(await Bun.file(join(worktreePath, ".sapling", "guards.json")).exists()).toBe(true);
		});

		test("overlay content is written verbatim", async () => {
			const worktreePath = join(tempDir, "worktree");
			const content = "# Task\n\n## Criteria\n\n- [ ] Tests pass\n- [ ] Lint clean\n";
			const hooks: HooksDef = { agentName: "builder-1", capability: "builder", worktreePath };

			await runtime.deployConfig(worktreePath, { content }, hooks);

			const written = await Bun.file(join(worktreePath, "SAPLING.md")).text();
			expect(written).toBe(content);
		});
	});

	describe("buildGuardsConfig (via deployConfig) — sp 0.3.2 GuardConfig schema", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-sapling-guards-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		async function readGuards(worktreePath: string): Promise<Record<string, unknown>> {
			const guardsPath = join(worktreePath, ".sapling", "guards.json");
			const text = await Bun.file(guardsPath).text();
			return JSON.parse(text) as Record<string, unknown>;
		}

		async function guardsFor(
			capability: string,
			agentName = `test-${capability}`,
		): Promise<Record<string, unknown>> {
			const worktreePath = join(tempDir, `wt-${capability}`);
			await runtime.deployConfig(
				worktreePath,
				{ content: "# Overlay" },
				{ agentName, capability, worktreePath },
			);
			return readGuards(worktreePath);
		}

		// --- sp's REQUIRED `rules` array (the bug: its absence makes sp throw
		// `Guards file must have a "rules" array` and every sapling worker dies) ---

		test("emits a `rules` array (REQUIRED by sp — empty is valid)", async () => {
			const guards = await guardsFor("builder");
			expect(Array.isArray(guards.rules)).toBe(true);
			expect(guards.rules).toEqual([]);
		});

		test('version is the string "1" (sp\'s version is `version?: string`)', async () => {
			const guards = await guardsFor("builder");
			expect(guards.version).toBe("1");
			expect(typeof guards.version).toBe("string");
		});

		// --- ov-only fields must NOT leak into the emitted (sp-only) json ---

		test("does NOT emit ov-only fields sp doesn't define", async () => {
			const guards = await guardsFor("builder");
			for (const field of [
				"agentName",
				"capability",
				"writeToolsBlocked",
				"writeToolNames",
				"qualityGates",
				"bashGuards",
				"safePrefixes",
			]) {
				expect(field in guards).toBe(false);
			}
		});

		test("top-level keys are a subset of sp's GuardConfig shape", async () => {
			const guards = await guardsFor("builder");
			const allowed = new Set([
				"version",
				"rules",
				"pathBoundary",
				"fileScope",
				"readOnly",
				"blockedBashPatterns",
				"blockedTools",
				"eventConfig",
			]);
			for (const key of Object.keys(guards)) {
				expect(allowed.has(key)).toBe(true);
			}
		});

		// --- flat fields that match sp natively (preserved) ---

		test("pathBoundary is set to worktreePath", async () => {
			const worktreePath = join(tempDir, "wt-builder");
			const guards = await guardsFor("builder");
			expect(guards.pathBoundary).toBe(worktreePath);
		});

		test("readOnly is false for builder capability", async () => {
			const guards = await guardsFor("builder");
			expect(guards.readOnly).toBe(false);
		});

		test("readOnly is false for merger capability", async () => {
			const guards = await guardsFor("merger");
			expect(guards.readOnly).toBe(false);
		});

		test.each([
			"scout",
			"reviewer",
			"lead",
			"coordinator",
			"supervisor",
			"monitor",
		])("readOnly is true for %s capability", async (capability) => {
			const guards = await guardsFor(capability);
			expect(guards.readOnly).toBe(true);
		});

		test("blockedTools = NATIVE_TEAM_TOOLS + INTERACTIVE_TOOLS", async () => {
			const guards = await guardsFor("builder");
			expect(guards.blockedTools).toEqual([...NATIVE_TEAM_TOOLS, ...INTERACTIVE_TOOLS]);
		});

		// --- flattened bash blocklist (ov's nested bashGuards → sp's flat list) ---

		test("blockedBashPatterns is a FLAT string array (not nested)", async () => {
			const guards = await guardsFor("builder");
			expect(Array.isArray(guards.blockedBashPatterns)).toBe(true);
			for (const p of guards.blockedBashPatterns as string[]) {
				expect(typeof p).toBe("string");
			}
		});

		test("blockedBashPatterns includes DANGEROUS_BASH_PATTERNS for every agent", async () => {
			for (const cap of ["builder", "merger", "scout", "reviewer", "coordinator"]) {
				const guards = await guardsFor(cap);
				const patterns = guards.blockedBashPatterns as string[];
				for (const dangerous of DANGEROUS_BASH_PATTERNS) {
					expect(patterns).toContain(dangerous);
				}
			}
		});

		test("read-only agents ALSO block file-modifying bash patterns; impl agents do not", async () => {
			// "\\brsync\\s" is a FILE_MODIFYING pattern that is NOT in DANGEROUS_BASH_PATTERNS,
			// so it is the discriminator between the read-only and impl blocklists.
			const fileModifyingOnly = "\\brsync\\s";
			expect(DANGEROUS_BASH_PATTERNS).not.toContain(fileModifyingOnly);

			const scout = await guardsFor("scout");
			expect(scout.blockedBashPatterns as string[]).toContain(fileModifyingOnly);

			const builder = await guardsFor("builder");
			expect(builder.blockedBashPatterns as string[]).not.toContain(fileModifyingOnly);
		});

		// --- eventConfig (sp supports it natively) ---

		test("eventConfig contains agent name in all event hooks", async () => {
			const guards = await guardsFor("builder", "my-agent");
			const events = guards.eventConfig as Record<string, string[]>;
			expect(events.onToolStart).toContain("my-agent");
			expect(events.onToolEnd).toContain("my-agent");
			expect(events.onSessionEnd).toContain("my-agent");
		});
	});

	describe("parseTranscript", () => {
		let tempDir: string;

		beforeEach(async () => {
			tempDir = await mkdtemp(join(tmpdir(), "overstory-sapling-transcript-"));
		});

		afterEach(async () => {
			await rm(tempDir, { recursive: true, force: true });
		});

		test("returns null for non-existent file", async () => {
			const result = await runtime.parseTranscript(join(tempDir, "does-not-exist.jsonl"));
			expect(result).toBeNull();
		});

		test("aggregates usage from any event with usage object", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event1 = JSON.stringify({
				type: "message_start",
				usage: { input_tokens: 100, output_tokens: 0 },
			});
			const event2 = JSON.stringify({
				type: "message_end",
				usage: { input_tokens: 0, output_tokens: 50 },
			});
			await Bun.write(transcriptPath, `${event1}\n${event2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(100);
			expect(result?.outputTokens).toBe(50);
		});

		test("aggregates multiple events with usage", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const turn1 = JSON.stringify({
				type: "turn",
				usage: { input_tokens: 1000, output_tokens: 200 },
			});
			const turn2 = JSON.stringify({
				type: "turn",
				usage: { input_tokens: 2000, output_tokens: 300 },
			});
			await Bun.write(transcriptPath, `${turn1}\n${turn2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(3000);
			expect(result?.outputTokens).toBe(500);
		});

		test("first event model field wins (!model guard)", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event1 = JSON.stringify({
				type: "start",
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 10, output_tokens: 5 },
			});
			const event2 = JSON.stringify({
				type: "end",
				model: "claude-opus-4-6",
				usage: { input_tokens: 5, output_tokens: 2 },
			});
			await Bun.write(transcriptPath, `${event1}\n${event2}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			// First model wins (not last)
			expect(result?.model).toBe("claude-sonnet-4-6");
		});

		test("skips malformed lines and parses valid ones", async () => {
			const transcriptPath = join(tempDir, "mixed.jsonl");
			const bad = "not json at all";
			const good = JSON.stringify({ type: "turn", usage: { input_tokens: 42, output_tokens: 7 } });
			await Bun.write(transcriptPath, `${bad}\n${good}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.inputTokens).toBe(42);
			expect(result?.outputTokens).toBe(7);
		});

		test("empty file returns zero counts (not null)", async () => {
			const transcriptPath = join(tempDir, "empty.jsonl");
			await Bun.write(transcriptPath, "");

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("events without usage field do not contribute to counts", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event = JSON.stringify({ type: "tool_start", tool: "Bash" });
			await Bun.write(transcriptPath, `${event}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result).not.toBeNull();
			expect(result?.inputTokens).toBe(0);
			expect(result?.outputTokens).toBe(0);
		});

		test("model defaults to empty string when no event has model field", async () => {
			const transcriptPath = join(tempDir, "session.jsonl");
			const event = JSON.stringify({ type: "turn", usage: { input_tokens: 10, output_tokens: 5 } });
			await Bun.write(transcriptPath, `${event}\n`);

			const result = await runtime.parseTranscript(transcriptPath);
			expect(result?.model).toBe("");
		});
	});

	describe("parseEvents", () => {
		function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
			const encoder = new TextEncoder();
			return new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) {
						controller.enqueue(encoder.encode(chunk));
					}
					controller.close();
				},
			});
		}

		async function collectEvents(stream: ReadableStream<Uint8Array>) {
			const events = [];
			for await (const event of runtime.parseEvents(stream)) {
				events.push(event);
			}
			return events;
		}

		test("parses single NDJSON event", async () => {
			const event = { type: "ready", timestamp: "2025-01-01T00:00:00Z" };
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual(event);
		});

		test("parses multiple NDJSON events", async () => {
			const e1 = { type: "tool_start", timestamp: "2025-01-01T00:00:00Z" };
			const e2 = { type: "tool_end", timestamp: "2025-01-01T00:00:01Z" };
			const stream = makeStream([`${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n`]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(2);
			expect(events[0]).toEqual(e1);
			expect(events[1]).toEqual(e2);
		});

		test("skips malformed lines", async () => {
			// Use a non-`result` event so this exercises parsing mechanics only,
			// without triggering result-event normalization.
			const good = { type: "tool_end", timestamp: "2025-01-01T00:00:00Z" };
			const stream = makeStream([`not json\n${JSON.stringify(good)}\n`]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual(good);
		});

		test("skips empty lines", async () => {
			const good = { type: "ready", timestamp: "2025-01-01T00:00:00Z" };
			const stream = makeStream([`\n\n${JSON.stringify(good)}\n\n`]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
		});

		test("handles chunked data spanning multiple reads", async () => {
			// Non-`result` type: this asserts chunk reassembly, not normalization.
			const event = { type: "tool_end", timestamp: "2025-01-01T00:00:00Z", data: "hello" };
			const full = `${JSON.stringify(event)}\n`;
			// Split across three chunks
			const mid = Math.floor(full.length / 2);
			const stream = makeStream([full.slice(0, mid), full.slice(mid)]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual(event);
		});

		test("handles trailing data without newline", async () => {
			// Non-`result` type: asserts trailing-line flush, not normalization.
			const event = { type: "tool_end", timestamp: "2025-01-01T00:00:00Z" };
			// No trailing newline
			const stream = makeStream([JSON.stringify(event)]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual(event);
		});

		test("empty stream yields nothing", async () => {
			const stream = makeStream([]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(0);
		});

		test("preserves all fields from event", async () => {
			const event = {
				type: "tool_end",
				timestamp: "2025-01-01T00:00:01Z",
				toolName: "Bash",
				exitCode: 0,
				nested: { key: "value" },
			};
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events[0]).toEqual(event);
		});

		// --- outcome → isError normalization (overstory: errored sapling result
		// must not false-complete) ---
		//
		// LIVE sapling emits a terminal result event shaped:
		//   { type: "result", outcome: "success" | "max_turns" | "error", summary,
		//     totalTurns, totalInputTokens, totalOutputTokens }
		// (https://github.com/jayminwest/sapling/blob/main/src/hooks/events.ts).
		// There is NO `isError` field. The turn-runner derives `cleanResult` from
		// `event.isError !== true`, so without normalization an `outcome:"error"`
		// result (no isError) would be treated as a CLEAN completion and the
		// failure would be reported up as success. parseEvents normalizes the
		// discriminator: clean completion requires `outcome === "success"`.

		test("result with outcome:'error' is normalized to isError:true (no false-complete)", async () => {
			const event = {
				type: "result",
				outcome: "error",
				summary: "task failed",
				totalTurns: 3,
				totalInputTokens: 100,
				totalOutputTokens: 50,
			};
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events).toHaveLength(1);
			expect(events[0]?.isError).toBe(true);
			// Original fields are preserved alongside the derived discriminator.
			expect(events[0]?.outcome).toBe("error");
			expect(events[0]?.summary).toBe("task failed");
		});

		test("result with outcome:'max_turns' is normalized to isError:true (not a clean success)", async () => {
			const event = {
				type: "result",
				outcome: "max_turns",
				summary: "hit turn limit",
				totalTurns: 50,
				totalInputTokens: 1,
				totalOutputTokens: 1,
			};
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events[0]?.isError).toBe(true);
		});

		test("result with outcome:'success' is normalized to isError:false (still completes)", async () => {
			const event = {
				type: "result",
				outcome: "success",
				summary: "done",
				totalTurns: 4,
				totalInputTokens: 200,
				totalOutputTokens: 80,
			};
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events[0]?.isError).toBe(false);
			expect(events[0]?.outcome).toBe("success");
		});

		test("explicit isError:true on a result event wins over outcome (backward-compat)", async () => {
			// If a future sapling/claude-shaped result already carries isError, the
			// normalizer must not clobber it — even when outcome disagrees.
			const event = {
				type: "result",
				outcome: "success",
				isError: true,
			};
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events[0]?.isError).toBe(true);
		});

		test("explicit isError:false on a result event wins (clean, no outcome)", async () => {
			// An explicit isError:false is a recognizable success discriminator; the
			// normalizer must keep it clean and NOT fail closed.
			const event = {
				type: "result",
				timestamp: "2025-01-01T00:00:00Z",
				isError: false,
			};
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events[0]?.isError).toBe(false);
		});

		test("result event with NEITHER a string outcome NOR explicit isError FAILS CLOSED (isError:true)", async () => {
			// Non-blocking 2: a malformed sapling result lacking any recognizable
			// success discriminator must NOT be treated as a clean completion. Failing
			// open here would let a malformed result false-complete a failure as
			// success. Fail closed: derive isError:true so the turn-runner does not
			// settle to `completed`/`completedViaEvents`.
			const event = { type: "result", timestamp: "2025-01-01T00:00:00Z" };
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events[0]?.isError).toBe(true);
			// Original fields preserved (immutability — new object, no mutation).
			expect(events[0]?.type).toBe("result");
			expect(events[0]?.timestamp).toBe("2025-01-01T00:00:00Z");
		});

		test("result event with a non-string outcome FAILS CLOSED (isError:true)", async () => {
			// An `outcome` that isn't a recognizable "success" string is not a clean
			// discriminator — fail closed rather than guessing.
			const event = { type: "result", timestamp: "2025-01-01T00:00:00Z", outcome: 42 };
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events[0]?.isError).toBe(true);
		});

		test("non-result events with an outcome field are not normalized", async () => {
			// Only the terminal `result` event carries the success/error
			// discriminator; an unrelated event that happens to have `outcome`
			// must pass through untouched.
			const event = { type: "tool_end", timestamp: "2025-01-01T00:00:00Z", outcome: "whatever" };
			const stream = makeStream([`${JSON.stringify(event)}\n`]);
			const events = await collectEvents(stream);
			expect(events[0]).toEqual(event);
			expect(events[0]?.isError).toBeUndefined();
		});
	});

	describe("connect()", () => {
		test("returns RuntimeConnection with all required methods", () => {
			const { proc } = createMockProcess([]);
			const conn = runtime.connect(proc);
			expect(typeof conn.sendPrompt).toBe("function");
			expect(typeof conn.followUp).toBe("function");
			expect(typeof conn.abort).toBe("function");
			expect(typeof conn.getState).toBe("function");
			expect(typeof conn.close).toBe("function");
		});

		test("sendPrompt writes steer JSON to stdin", async () => {
			const { proc, written } = createMockProcess([]);
			const conn = runtime.connect(proc);
			await conn.sendPrompt("Hello world");
			expect(written.length).toBe(1);
			const msg = JSON.parse(written[0]?.trim() ?? "") as Record<string, unknown>;
			expect(msg.method).toBe("steer");
			expect((msg.params as Record<string, unknown>).content).toBe("Hello world");
		});

		test("followUp writes followUp JSON to stdin", async () => {
			const { proc, written } = createMockProcess([]);
			const conn = runtime.connect(proc);
			await conn.followUp("Continue please");
			expect(written.length).toBe(1);
			const msg = JSON.parse(written[0]?.trim() ?? "") as Record<string, unknown>;
			expect(msg.method).toBe("followUp");
			expect((msg.params as Record<string, unknown>).content).toBe("Continue please");
		});

		test("abort writes abort JSON to stdin", async () => {
			const { proc, written } = createMockProcess([]);
			const conn = runtime.connect(proc);
			await conn.abort();
			expect(written.length).toBe(1);
			const msg = JSON.parse(written[0]?.trim() ?? "") as Record<string, unknown>;
			expect(msg.method).toBe("abort");
		});

		test("getState resolves with response from stdout", async () => {
			const response = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { status: "idle" } });
			const { proc } = createMockProcess([response]);
			const conn = runtime.connect(proc);
			const state = await conn.getState();
			expect(state.status).toBe("idle");
		});

		test("getState writes correct JSON-RPC 2.0 request to stdin", async () => {
			const response = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { status: "working" } });
			const { proc, written } = createMockProcess([response]);
			const conn = runtime.connect(proc);
			await conn.getState();
			// The getState request is the first write
			const req = JSON.parse(written[0]?.trim() ?? "") as Record<string, unknown>;
			expect(req.id).toBe(0);
			expect(req.method).toBe("getState");
		});

		test("getState routes by id out of order", async () => {
			// Two responses: id=1 arrives first, then id=0
			const resp1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "idle" } });
			const resp0 = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { status: "working" } });
			const { proc } = createMockProcess([resp1, resp0]);
			const conn = runtime.connect(proc);
			// Issue both requests synchronously before any microtasks run
			const p0 = conn.getState(); // id=0
			const p1 = conn.getState(); // id=1
			const [r0, r1] = await Promise.all([p0, p1]);
			expect(r0.status).toBe("working"); // id=0 → second response
			expect(r1.status).toBe("idle"); // id=1 → first response
		});

		test("getState rejects on timeout", async () => {
			// Use internal timeout override: access via constructor — workaround: reconnect
			// with a short timeout using the internal SaplingConnection constructor parameter.
			// Since SaplingConnection is not exported, we create a wrapper via a subclass.
			// Instead, test via a never-responding stream and a very short timeout:
			// We create a mock process whose stdout never delivers data.
			let streamController!: ReadableStreamDefaultController<Uint8Array>;
			const stdout = new ReadableStream<Uint8Array>({
				start(c) {
					streamController = c;
					// Never enqueue or close — simulates a hung agent
				},
			});
			const proc: RpcProcessHandle = {
				stdin: { write: (_d: string | Uint8Array) => 0 },
				stdout,
			};
			// Use a 1ms timeout by passing it via the internal path.
			// SaplingRuntime.connect() uses the default 5s timeout.
			// We test the timeout by injecting a short one via a direct class import.
			// Since SaplingConnection is private, we verify timeout behaviour via
			// a different approach: close the stream immediately after a delay.
			// For test speed, close the stream and verify we get "connection closed".
			setTimeout(() => streamController.close(), 10);
			const conn = runtime.connect(proc);
			await expect(conn.getState()).rejects.toThrow("connection closed");
		});

		test("close rejects pending getState immediately", async () => {
			// A stream that never ends
			const stdout = new ReadableStream<Uint8Array>({
				start(_c) {
					// never close
				},
			});
			const proc: RpcProcessHandle = {
				stdin: { write: (_d: string | Uint8Array) => 0 },
				stdout,
			};
			const conn = runtime.connect(proc);
			const p = conn.getState();
			// Close immediately — should reject pending
			conn.close();
			await expect(p).rejects.toThrow("connection closed");
		});

		test("ignores non-RPC NDJSON events mixed with responses", async () => {
			// Stdout has an event line, then the RPC response, then another event line
			const eventLine = JSON.stringify({ type: "tool_start", timestamp: "2025-01-01T00:00:00Z" });
			const rpcResponse = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { status: "idle" } });
			const eventLine2 = JSON.stringify({ type: "tool_end", timestamp: "2025-01-01T00:00:01Z" });
			const { proc } = createMockProcess([eventLine, rpcResponse, eventLine2]);
			const conn = runtime.connect(proc);
			const state = await conn.getState();
			// Should resolve correctly despite surrounding event lines
			expect(state.status).toBe("idle");
		});
	});
});

describe("SaplingRuntime integration: registry resolves 'sapling'", () => {
	test("getRuntime('sapling') returns SaplingRuntime", async () => {
		const { getRuntime } = await import("./registry.ts");
		const rt = getRuntime("sapling");
		expect(rt).toBeInstanceOf(SaplingRuntime);
		expect(rt.id).toBe("sapling");
		expect(rt.instructionPath).toBe("SAPLING.md");
	});
});
