// ACP (Agent Client Protocol) types — subset covering Devin CLI's surface,
// plus Devin's `cognition.ai/*` extensions observed on the wire.

export type SessionId = string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ---------- Content ----------

export type ContentBlock =
  | { type: "text"; text: string; _meta?: Record<string, unknown> | null }
  | { type: "image"; data: string; mimeType: string; uri?: string; _meta?: Record<string, unknown> | null }
  | { type: "audio"; data: string; mimeType: string; _meta?: Record<string, unknown> | null }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string; title?: string; description?: string; _meta?: Record<string, unknown> | null }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string }; _meta?: Record<string, unknown> | null };

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string | null; newText: string; _meta?: Record<string, unknown> | null }
  | { type: "terminal"; terminalId: string; _meta?: Record<string, unknown> | null };

export type ToolKind =
  | "read" | "edit" | "delete" | "move" | "search" | "execute" | "think"
  | "fetch" | "switch_mode" | "other" | string;

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | string;

export interface ToolCallUpdate {
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: { path: string; line?: number | null }[];
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Record<string, unknown> | null;
}

export interface ToolCall extends ToolCallUpdate {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
}

// ---------- Session updates ----------

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low" | string;
  status?: "pending" | "in_progress" | "completed" | string;
  _meta?: Record<string, unknown> | null;
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string } | null;
  _meta?: Record<string, unknown> | null;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: "select" | "boolean";
  currentValue?: string | boolean;
  options?: { value: string; name: string; description?: string; _meta?: Record<string, unknown> | null }[];
  _meta?: Record<string, unknown> | null;
}

export interface Usage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call" } & ToolCall)
  | ({ sessionUpdate: "tool_call_update" } & ToolCallUpdate)
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "config_option_update"; configOptions: SessionConfigOption[] }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null }
  | { sessionUpdate: "usage_update"; used: number; size: number; _meta?: Record<string, unknown> | null }
  | ({ sessionUpdate: string } & Record<string, unknown>);

export interface SessionNotification {
  sessionId: SessionId;
  update: SessionUpdate;
  _meta?: Record<string, unknown> | null;
}

// ---------- Initialize ----------

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  /** cognition.ai/* feature flags — the agent echoes back the ones it
   *  enabled (revert must be client-advertised to unlock the surface) */
  _meta?: Record<string, unknown>;
}

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
  clientInfo?: { name: string; version: string };
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
    sessionCapabilities?: { list?: object; resume?: object; fork?: object; delete?: object; additionalDirectories?: object };
    auth?: object;
    _meta?: Record<string, unknown> | null;
  };
  authMethods?: AuthMethod[];
  agentInfo?: { name: string; title?: string; version: string };
  _meta?: Record<string, unknown> | null;
}

// ---------- Session lifecycle ----------

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown> | null;
}

export interface SessionInfoEntry {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  _meta?: Record<string, unknown> | null;
}

export interface NewSessionResult {
  sessionId: SessionId;
  modes?: { currentModeId: string; availableModes: SessionMode[] } | null;
  models?: { currentModelId: string; availableModels: { modelId: string; name: string }[] } | null;
  configOptions?: SessionConfigOption[] | null;
  _meta?: Record<string, unknown> | null;
}

// ---------- Permission ----------

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
  _meta?: Record<string, unknown> | null;
}

export interface RequestPermissionRequest {
  sessionId: SessionId;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
  _meta?: Record<string, unknown> | null;
}

export type RequestPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

// ---------- Elicitation ----------

export interface ElicitationRequest {
  mode: "form" | "url" | string;
  message: string;
  url?: string;
  elicitationId?: string;
  requestedSchema?: {
    type: "object";
    properties?: Record<string, { type?: string; title?: string; description?: string; enum?: unknown[]; items?: unknown; default?: unknown; [k: string]: unknown }>;
    required?: string[];
    [k: string]: unknown;
  };
  sessionId?: SessionId;
  toolCallId?: string;
  _meta?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface ElicitationResponse {
  action: "accept" | "decline" | "cancel" | string;
  content?: Record<string, unknown> | null;
  _meta?: Record<string, unknown> | null;
  [k: string]: unknown;
}

// ---------- fs / terminal client methods ----------

export interface ReadTextFileRequest {
  sessionId: SessionId;
  path: string;
  line?: number | null;
  limit?: number | null;
}
export interface WriteTextFileRequest {
  sessionId: SessionId;
  path: string;
  content: string;
}
export interface TerminalCreateRequest {
  sessionId: SessionId;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: { name: string; value: string }[] | null;
  outputByteLimit?: number | null;
  _meta?: Record<string, unknown> | null;
}
export interface TerminalRequest {
  sessionId: SessionId;
  terminalId: string;
}

// ---------- Wire constants ----------

export const METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionList: "session/list",
  sessionDelete: "session/delete",
  sessionFork: "session/fork",
  sessionResume: "session/resume",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetMode: "session/set_mode",
  sessionSetModel: "session/set_model",
  sessionSetConfigOption: "session/set_config_option",
  sessionUpdate: "session/update",
  // client-side (agent -> client)
  requestPermission: "session/request_permission",
  fsRead: "fs/read_text_file",
  fsWrite: "fs/write_text_file",
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalWaitForExit: "terminal/wait_for_exit",
  terminalKill: "terminal/kill",
  terminalRelease: "terminal/release",
  elicitationCreate: "elicitation/create",
  elicitationComplete: "elicitation/complete",
  // devin-private revert surface — extension methods, hence the leading
  // underscore (ACP `_`-method convention). Enabled by advertising
  // clientCapabilities._meta["cognition.ai/revert"]=true at initialize;
  // devin echoes the flag back in agentCapabilities._meta when callable.
  revertListSteps: "_cognition.ai/revert/listSteps",
  revertForkFromStep: "_cognition.ai/revert/forkFromStep",
} as const;

/** One entry from `_cognition.ai/revert/listSteps` — a history step with
 *  its revert/fork anchor node ids (forkTargetNodeId = the node a fork
 *  clones up to). Fields per the CLI's RevertStepInfo; all but the
 *  identity fields are optional on the wire. */
export interface RevertStepInfo {
  stepId: string;
  stepNumber: number;
  kind?: string;
  summary?: string;
  userMessageId?: string;
  toolCallId?: string;
  questionNodeId?: number;
  revertTargetNodeId?: number;
  forkTargetNodeId?: number;
}
