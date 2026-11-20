# Using a CLI as a provider

If you already pay for a plan, or do not want to get an API key, a provider can be a program on your machine that uses the session you already signed in with. Back to the [README](../../README.md).

There are three presets, `claude-cli`, `gemini-cli` and `codex-cli`, and a `generic-cli` mode (any command). All of them are **external**, just like the APIs: conversations matching `localOnlyPatterns` never reach them.

## The rule (RF-49)

Chats are written by other people, and a CLI is an agent that can read files and run commands: text in a chat could try to make it do so (prompt injection). That is why a CLI preset is used only when it can be **verified** to run without tools.

- Before the first call, and in `msum doctor`, the program runs `<cli> --help` and `<cli> --version`. It never makes a model call, and does so in an empty temporary directory, with the environment described [below](#what-the-cli-receives).
- Every flag the hardening relies on has to be listed.
- If one is missing, the provider becomes unavailable with the reason "this version of X cannot be run without tools", and the conversation goes to the backup provider.
- The result is remembered by the program's path and modification date, so an update is checked again.

## The presets

| Preset | State | Flags and what for |
|---|---|---|
| `claude-cli` | enabled | `claude -p --model <m> --system-prompt <s> --json-schema <schema> --output-format json --tools '' --strict-mcp-config --no-session-persistence --safe-mode --disable-slash-commands`. See the list below. |
| `gemini-cli` | **disabled** | Gemini CLI (`-p`, `-o json`) documents no flag that turns its tools off: `--allowed-tools` is deprecated, `--allowed-mcp-server-names` and `--extensions` only select, `--approval-mode plan` is read-only but still has tools (reading files, fetching web pages), and sessions cannot be turned off. A policy that denies everything exists, but its flag (`--admin-policy`) is documented without saying whether it takes a file or a directory, and it is ignored when there are policy files in the system location. |
| `codex-cli` | **disabled** | `codex exec --sandbox read-only --ephemeral --ignore-user-config --output-schema <file>` restricts what commands can write, keeps no session and forces a schema, but the shell tool is still available: the documentation says the sandbox limits "model-generated shell commands", not that it removes them, and no documented switch turns off the shell, MCP and web search together. |

The flags of `claude-cli`:

- `-p` is headless mode.
- `--json-schema` forces the digest format natively.
- `--tools ''` turns off all tools.
- `--strict-mcp-config` loads no MCP server.
- `--no-session-persistence` saves no session.
- `--safe-mode` ignores your customizations (CLAUDE.md, skills, plugins, hooks, MCP), so no hook receives the chat.
- `--disable-slash-commands` turns off commands and skills.
- The chat goes through stdin, never as an argument.

A disabled preset makes every call fail immediately with that reason and `msum doctor` says so; nothing is run. They will be enabled when a documented way to turn tools off can be verified in `--help`. In the meantime the generic CLI can run them, with the risk described [below](#the-generic-cli).

Sources: the documentation of [Claude Code](https://code.claude.com/docs/en/network-config), [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md) and [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## What the CLI receives

Only these variables, when defined, and never one of your API keys:

| Variable | What for |
|---|---|
| `PATH` | Finding the program and its runtime. |
| `HOME`, `USER`, `LOGNAME` | Finding your existing session. |
| `CLAUDE_CONFIG_DIR` | A session stored elsewhere (Claude only). |
| `LANG`, `TZ` | Language and time zone. |

Proxy and certificate variables are not passed: define them where the CLI itself reads them. The CLI runs without a shell, in a new empty temporary directory that is deleted afterwards, with a timeout that kills the whole process group (grandchildren included), and at most 2 MB of output.

## Signing in

The CLI uses the session you already signed in for it. Inside a Docker container or sandbox the session is started inside, once, and kept in a volume. For Claude:

1. Run `claude` in the container (for example `docker exec -it <container> claude`, or `sbx claude` if you use `sbx`).
2. Sign in.
3. Keep its configuration directory (`~/.claude`, or the one in `CLAUDE_CONFIG_DIR`) in a volume so the daemon sees it.

With Docker Compose, the `cli` profile already ships the CLIs: `docker compose -f docker/compose.yaml --profile cli up -d` (Gemini CLI and Codex are disabled for now). Step by step in [Installing Claude Code and signing in](install-claude-and-login.md).

## The response format (RF-48)

- `claude-cli` forces the schema with `--json-schema`; if the response is still unusable, it is asked once more to fix it.
- A CLI with no native schema flag (the generic one) gets the schema in the prompt, the response is validated and, if invalid, it is asked ONE more time with a message saying what was wrong. If it fails again, the conversation goes to the backup provider (RF-42).

## The generic CLI

`generic-cli` runs any command that receives the prompt and prints text with the response:

```json
"provider": {
  "primary": "generic-cli",
  "genericCli": { "command": ["my-llm", "--json", "{{prompt}}"], "timeoutMs": 180000, "acknowledgeRisk": true }
}
```

- `command` is a list of arguments, with no shell and no interpolation inside an element. There is no default command.
- **By default the prompt goes through stdin, which is private.**
- An element that is exactly `{{prompt}}` receives the full prompt instead. Use it only for a tool that cannot read stdin, because **arguments are visible to other users of the machine** (`ps`) and a long chat can exceed the argument size limit. `msum doctor` warns when the command uses it. `{{prompt}}` is never the program nor part of a longer element.
- **It cannot be hardened:** the command may run tools on text written by third parties, so it is rejected unless you set `acknowledgeRisk` to `true`. `msum doctor`, `msum digest` and the daemon print this warning every time it is about to be used. Prefer a provider that runs without tools.

---

Back to the [README](../../README.md) · [Guides index](README.md)
