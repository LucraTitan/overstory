# swarm-ops

Operator tooling for the dual-machine (ThinkPad + Legion) overstory/warren swarm.
These files are **not** part of overstory's source — they're setup/observability helpers
for this fork, kept here so they travel with the repo via `git pull`.

## `cc-audit.sh` — surface your real Claude Code + os-eco setup

A **read-only** audit. It never modifies anything and auto-redacts secrets
(`sk-…`, `gh*_…`, and any `token`/`key`/`secret`/`password`/`auth` value). It never
prints `~/.claude/.credentials.json` and only reports env secrets as `[SET]`/`[unset]`.

Run it on the **ThinkPad**, from inside your overstory project dir (so it also captures
project-level `.claude/` and `.overstory/` config):

```bash
git pull                       # get this script onto the ThinkPad
bash swarm-ops/cc-audit.sh
```

It writes `~/cc-audit-report.txt` and prints it. **Eyeball the report**, then paste its
contents back into the planning session. It captures:

- System/hardware (CPU, RAM, GPU, distro, WSL detection)
- Claude Code version + **auth mode** (OAuth/subscription vs API key — values never shown)
- Global + project `settings.json` / `settings.local.json` (redacted)
- Parsed **hooks** (SessionStart, UserPromptSubmit, PostToolUse, Stop, …)
- **MCP servers** (`claude mcp list` + settings keys)
- Skills, plugins, slash-commands
- **claude-mem** footprint (dirs, DBs, vector store, hook references)
- **context-mode** footprint (CLI, `~/.context-mode/`, `context-mode doctor`)
- **overstory + os-eco** toolchain (`ov`/`ml`/`sd`/`cn`/`plot` versions, `.overstory/config.yaml`,
  agent manifest, `.mulch`/`.seeds`/`.canopy`/`.plot` presence)
- Runtime toolchain (bun/node/npm/git/tmux/docker)

> A full build-handoff document (the prompt you hand to your local Claude Code to *implement*
> the tailoring) will be added here once the remaining planning questions are answered.
