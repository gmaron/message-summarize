import type { Summarizer } from '../../../application/ports/summarizer.js'
import { err, type Result } from '../../../domain/result.js'
import { describeUnverified } from './cli-summarizer.js'
import type { CliVerification } from './verify.js'

/**
 * Presets shipped DISABLED (RF-49). A CLI is only used when we can verify that it runs without tools, and the
 * documentation of these two offers no way to do that:
 *
 * - `gemini-cli` (Gemini CLI, github.com/google-gemini/gemini-cli): there is no flag that turns the tools off.
 *   `--allowed-tools` is deprecated, `--allowed-mcp-server-names` and `--extensions` only select, and `--approval-mode
 *   plan` is read-only but still has tools (file reads, web fetch and search), which prompt injection could use to send
 *   the chat out. A deny-all policy (`toolName = "*"`, `decision = "deny"`) exists, but its documented flag
 *   (`--admin-policy`) does not say whether it takes a file or a directory, and it is ignored when policy files exist in
 *   the system location. Sessions cannot be turned off either (`--resume`/`--delete-session` only). Output: `-o json`
 *   gives `{response, stats, error}`; there is no native schema flag.
 * - `codex-cli` (Codex CLI, github.com/openai/codex): `codex exec --sandbox read-only --ephemeral --ignore-user-config
 *   --output-schema <file>` restricts what the model's commands may write, avoids saving the session and forces a
 *   schema, but the shell tool stays available (the documentation says `--sandbox` restricts "model-generated shell
 *   commands", not that it removes them), and no documented switch turns off the shell, MCP and web search together
 *   (`--disable <feature>` needs feature names the documentation does not map to them).
 *
 * To enable one: a flag (or setting) that disables the tools must be documented and `verify` must check it in `--help`.
 * Until then the generic CLI covers them, with the risk acknowledged.
 */
export const DISABLED_PRESETS = ['gemini-cli', 'codex-cli'] as const
export type DisabledPreset = (typeof DISABLED_PRESETS)[number]

export const verifyDisabledPreset = (): CliVerification => ({ ok: false, kind: 'disabled' })

/** Fails every call at once, without running anything: the reason says the preset is disabled. */
export class DisabledCliSummarizer implements Summarizer {
  constructor(private readonly preset: DisabledPreset) {}

  async summarize(): Promise<Result<unknown, string>> {
    return err(describeUnverified(this.preset, { ok: false, kind: 'disabled' }))
  }
}
