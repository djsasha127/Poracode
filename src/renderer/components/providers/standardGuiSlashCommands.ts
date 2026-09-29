import { msg } from "@lingui/core/macro";
import type { AgentSlashCommand } from "@/shared/contracts";
import { i18n } from "@/renderer/i18n/i18n";
import type { GuiSlashCommandContext, LocalSlashCommandAction } from "./providerSlashCommands";

// A slash command's label is its id followed by the (translated) description, so
// the description is translated once and the `/id` keyword stays untranslatable.
export const guiSlashCommand = (id: string, description: string): AgentSlashCommand => ({
  id,
  description,
  label: `${id} - ${description}`,
});

/**
 * The provider-agnostic GUI command set: composer-local actions every
 * structured-chat provider supports. Provider-specific extras (e.g. Codex
 * `/goal`) insert after the mode commands and before effort/fast.
 */
export function buildStandardGuiSlashCommands(
  { hasEffort, supportsFast }: GuiSlashCommandContext,
  extras: readonly AgentSlashCommand[] = [],
): AgentSlashCommand[] {
  return [
    guiSlashCommand("model", i18n._(msg`Open the model picker`)),
    guiSlashCommand("plan", i18n._(msg`Switch this chat to plan mode`)),
    guiSlashCommand("agent", i18n._(msg`Switch this chat to agent mode`)),
    guiSlashCommand("status", i18n._(msg`Open account, usage, and status details`)),
    guiSlashCommand("context", i18n._(msg`Inspect this chat's context usage`)),
    guiSlashCommand("review", i18n._(msg`Open the current Git changes for review`)),
    guiSlashCommand("diff", i18n._(msg`Open the current Git changes`)),
    guiSlashCommand("fork", i18n._(msg`Continue this chat in another agent`)),
    guiSlashCommand("side", i18n._(msg`Open a separate side chat`)),
    guiSlashCommand("btw", i18n._(msg`Open a separate side chat`)),
    guiSlashCommand("tasks", i18n._(msg`Open background tasks`)),
    guiSlashCommand("background", i18n._(msg`Open background tasks`)),
    guiSlashCommand("resume", i18n._(msg`Find and resume another chat`)),
    guiSlashCommand("new", i18n._(msg`Open a new chat`)),
    guiSlashCommand("archive", i18n._(msg`Archive this chat`)),
    guiSlashCommand("import", i18n._(msg`Import Codex or Claude sessions`)),
    guiSlashCommand("add-dir", i18n._(msg`Add a project directory`)),
    guiSlashCommand("permissions", i18n._(msg`Open this provider's permission settings`)),
    guiSlashCommand("mcp", i18n._(msg`Open MCP server settings`)),
    guiSlashCommand("plugins", i18n._(msg`Open the plugin marketplace`)),
    ...extras,
    ...(hasEffort ? [guiSlashCommand("effort", i18n._(msg`Open the effort picker`))] : []),
    ...(supportsFast ? [guiSlashCommand("fast", i18n._(msg`Toggle Fast mode`))] : []),
  ];
}

export function resolveStandardLocalSlashAction(typed: string): LocalSlashCommandAction | null {
  const normalized = typed.trim().toLowerCase();
  if (normalized === "/model") return { kind: "open-control", target: "model" };
  if (normalized === "/effort") return { kind: "open-control", target: "effort" };
  if (normalized === "/fast") return { kind: "toggle-fast" };
  if (normalized === "/plan") return { kind: "set-mode", mode: "plan" };
  if (normalized === "/agent") return { kind: "set-mode", mode: "agent" };
  if (normalized === "/status") return { kind: "open-surface", target: "status" };
  if (normalized === "/context") return { kind: "open-surface", target: "context" };
  if (normalized === "/review") return { kind: "open-surface", target: "review" };
  if (normalized === "/diff") return { kind: "open-surface", target: "diff" };
  if (normalized === "/fork") return { kind: "open-surface", target: "fork" };
  if (normalized === "/side" || normalized === "/btw") {
    return { kind: "open-surface", target: "side" };
  }
  if (normalized === "/tasks" || normalized === "/background") {
    return { kind: "open-surface", target: "tasks" };
  }
  if (normalized === "/resume") return { kind: "open-surface", target: "resume" };
  if (normalized === "/new") return { kind: "open-surface", target: "new" };
  if (normalized === "/archive") return { kind: "open-surface", target: "archive" };
  if (normalized === "/import") return { kind: "open-surface", target: "import" };
  if (normalized === "/add-dir") return { kind: "open-surface", target: "add-dir" };
  if (normalized === "/permissions") return { kind: "open-surface", target: "permissions" };
  if (normalized === "/mcp") return { kind: "open-surface", target: "mcp" };
  if (normalized === "/plugins") return { kind: "open-surface", target: "plugins" };
  return null;
}
