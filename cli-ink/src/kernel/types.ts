// What a slash-command handler can return. The CLI surface translates
// these to UI actions; future channels (Telegram, voice) will translate
// them to whatever they natively render.

export type ModalKind =
  | "model"
  | "config"
  | "sessions"
  | "update"
  | "onboarding"
  | "edit-soul"
  | "edit-user";

export type CommandResult =
  | { kind: "text"; text: string; color?: string; dim?: boolean }
  | { kind: "modal"; modal: ModalKind }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "error"; text: string }
  | { kind: "noop" };

export interface CommandContext {
  /** The full raw input (including leading slash). */
  raw: string;
  /** Whatever followed the command name, trimmed. */
  arg: string;
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult> | CommandResult;

export interface SlashCommand {
  /** Includes the leading slash. */
  name: string;
  description: string;
  handler: CommandHandler;
}
