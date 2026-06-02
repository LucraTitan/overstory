#!/usr/bin/env bash
# cc-audit.sh — READ-ONLY audit of your Claude Code + os-eco (overstory) swarm setup.
#
# WHAT IT DOES: surfaces your global + project Claude Code config, hooks, MCP servers,
# skills, plugins, claude-mem, context-mode, and overstory/mulch/seeds/canopy state so
# the swarm architecture can be tailored to your ACTUAL machine.
#
# SAFETY: never modifies anything. Auto-redacts obvious secrets (sk-..., gh*_..., and
# any token/key/secret/password/auth value). It NEVER prints ~/.claude/.credentials.json
# and only reports env secrets as [SET]/[unset]. STILL: eyeball the report before sharing.
#
# USAGE: run from INSIDE your overstory project dir so it also captures project-level
# (.claude/, .overstory/) config:
#     bash swarm-ops/cc-audit.sh
# Output -> ~/cc-audit-report.txt (also printed to stdout).

set -o pipefail
OUT="${1:-$HOME/cc-audit-report.txt}"
: > "$OUT"

have(){ command -v "$1" >/dev/null 2>&1; }
w(){ printf '%s\n' "$*" >> "$OUT"; }
hdr(){ printf '\n===== %s =====\n' "$*" >> "$OUT"; }
redact(){
  sed -E \
    -e 's/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/\1[REDACTED]/g' \
    -e 's/(gh[pousr]_[A-Za-z0-9]{4})[A-Za-z0-9]+/\1[REDACTED]/g' \
    -e 's/(("?[A-Za-z0-9_-]*(token|key|secret|password|auth|bearer|apikey)[A-Za-z0-9_-]*"?[[:space:]]*[:=][[:space:]]*"?)[^",}[:space:]]{0,4})[^",}[:space:]]*/\1[REDACTED]/Ig'
}
dumpf(){ if [ -f "$1" ]; then w "--- $1 ---"; redact < "$1" >> "$OUT"; w ""; else w "--- $1 (absent) ---"; fi; }

w "Claude Code / os-eco swarm audit — $(date -Is 2>/dev/null || date)"
w "Host: $(hostname)   User: $(whoami)   CWD: $(pwd)"

hdr "SYSTEM / HARDWARE"
have uname && w "$(uname -a)"
[ -f /etc/os-release ] && { . /etc/os-release 2>/dev/null; w "Distro: ${PRETTY_NAME:-unknown}"; }
have lscpu && w "CPU: $(lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p') (threads: $(nproc 2>/dev/null))"
have free && w "RAM: $(free -h 2>/dev/null | awk '/^Mem:/{print $2" total, "$7" avail"}')"
if have nvidia-smi; then
  w "GPU: $(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null)"
elif have lspci; then
  w "GPU: $(lspci 2>/dev/null | grep -Ei 'vga|3d|display' | sed 's/^[^:]*: //')"
fi
have systemd-detect-virt && w "Virt: $(systemd-detect-virt 2>/dev/null)"
grep -qi microsoft /proc/version 2>/dev/null && w "WSL: yes ($(grep -o 'WSL[0-9]*' /proc/version 2>/dev/null | head -1))"

hdr "CLAUDE CODE"
if have claude; then w "claude version: $(claude --version 2>/dev/null)"; else w "claude: NOT FOUND on PATH"; fi
w "Auth signals (values never printed):"
[ -f "$HOME/.claude/.credentials.json" ] && w "  ~/.claude/.credentials.json present (OAuth / subscription login likely)" || w "  ~/.claude/.credentials.json absent"
for v in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX; do
  if [ -n "${!v:-}" ]; then w "  env $v = [SET]"; else w "  env $v = [unset]"; fi
done

hdr "CLAUDE SETTINGS (redacted)"
for f in "$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json" "./.claude/settings.json" "./.claude/settings.local.json"; do dumpf "$f"; done

hdr "HOOKS (parsed)"
if have jq; then
  for f in "$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json" "./.claude/settings.json" "./.claude/settings.local.json"; do
    [ -f "$f" ] && { w "[$f]"; jq -r '.hooks // {} | to_entries[] | "  \(.key): " + ([.value[]?.hooks[]?.command] | join("  |  "))' "$f" 2>/dev/null | redact >> "$OUT"; }
  done
else
  w "(jq not installed — see raw settings above for hooks)"
fi

hdr "MCP SERVERS"
if have claude; then w "[claude mcp list]"; timeout 25 claude mcp list 2>&1 | redact >> "$OUT"; fi
if have jq; then
  for f in "$HOME/.claude/settings.json" "$HOME/.claude.json" "./.claude/settings.json" "./.mcp.json"; do
    [ -f "$f" ] && { names=$(jq -r '(.mcpServers // {}) | keys[]?' "$f" 2>/dev/null | tr '\n' ' '); [ -n "$names" ] && w "[$f] mcpServers: $names"; }
  done
fi

hdr "SKILLS / PLUGINS / COMMANDS"
w "global skills:   $(ls "$HOME/.claude/skills" 2>/dev/null | tr '\n' ' ')"
w "project skills:  $(ls ./.claude/skills 2>/dev/null | tr '\n' ' ')"
w "global plugins:  $(ls "$HOME/.claude/plugins" 2>/dev/null | tr '\n' ' ')"
w "global commands: $(ls "$HOME/.claude/commands" 2>/dev/null | tr '\n' ' ')"
have claude && { w "[claude plugin list]"; timeout 20 claude plugin list 2>&1 | redact >> "$OUT"; }

hdr "claude-mem (memory plugin)"
if [ -d "$HOME/.claude-mem" ]; then
  w "~/.claude-mem present"
  w "  size: $(du -sh "$HOME/.claude-mem" 2>/dev/null | cut -f1)"
  w "  dbs:  $(find "$HOME/.claude-mem" -name '*.db' 2>/dev/null | tr '\n' ' ')"
  w "  chroma/vector store: $(find "$HOME/.claude-mem" -iname '*chroma*' 2>/dev/null | head -1)"
else w "~/.claude-mem absent"; fi
have claude-mem && w "claude-mem CLI: $(claude-mem --version 2>/dev/null || echo present)"
grep -ril "claude-mem" "$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json" 2>/dev/null | sed 's/^/  referenced in: /' >> "$OUT"

hdr "context-mode (context optimizer)"
if have context-mode; then w "context-mode CLI: present ($(npm list -g context-mode 2>/dev/null | grep context-mode | tr -d ' '))"; else w "context-mode CLI: not on PATH"; fi
if [ -d "$HOME/.context-mode" ]; then
  w "~/.context-mode present  size: $(du -sh "$HOME/.context-mode" 2>/dev/null | cut -f1)"
  w "  session dbs: $(find "$HOME/.context-mode/sessions" -name '*.db' 2>/dev/null | wc -l) | content dbs: $(find "$HOME/.context-mode/content" -name '*.db' 2>/dev/null | wc -l)"
else w "~/.context-mode absent"; fi
for v in CONTEXT_MODE_DIR CONTEXT_MODE_PLATFORM; do [ -n "${!v:-}" ] && w "env $v = [SET]" || w "env $v = [unset]"; done
have context-mode && { w "[context-mode doctor]"; timeout 25 context-mode doctor 2>&1 | redact >> "$OUT"; }

hdr "OVERSTORY + os-eco TOOLCHAIN"
for t in ov ml sd bd cn plot; do
  if have "$t"; then w "$t: $({ "$t" --version 2>/dev/null || "$t" version 2>/dev/null; } | head -1)"; else w "$t: NOT FOUND"; fi
done
w ""
w "Nearest .overstory:"
d="$(pwd)"; found=""
while [ "$d" != "/" ]; do [ -d "$d/.overstory" ] && { found="$d/.overstory"; break; }; d="$(dirname "$d")"; done
if [ -n "$found" ]; then
  w "  $found"
  dumpf "$found/config.yaml"
  [ -f "$found/config.local.yaml" ] && dumpf "$found/config.local.yaml"
  have jq && [ -f "$found/agent-manifest.json" ] && w "  agents: $(jq -r '.agents[]?.name // (.[]?.name)' "$found/agent-manifest.json" 2>/dev/null | tr '\n' ' ')"
  dumpf "$found/hooks.json"
else w "  (none found above $(pwd) — run from inside your overstory project)"; fi
w "os-eco dirs here: .mulch=$( [ -d .mulch ] && echo yes || echo no )  .seeds=$( [ -d .seeds ] && echo yes || echo no )  .canopy=$( [ -d .canopy ] && echo yes || echo no )  .plot=$( [ -d .plot ] && echo yes || echo no )"

hdr "RUNTIME TOOLCHAIN"
for t in bun node npm git tmux docker; do have "$t" && w "$t: $($t --version 2>/dev/null | head -1)" || w "$t: NOT FOUND"; done

w ""
w "===== END OF REPORT ====="
echo "Report written to: $OUT"
echo "Secrets are auto-redacted — but please eyeball it before pasting back."
echo
cat "$OUT"
