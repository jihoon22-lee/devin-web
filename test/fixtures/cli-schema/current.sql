-- Devin CLI 3000.11.3 schema fixture; sqlite_master structure only, no user rows
CREATE TABLE app_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,           -- node_id within this session's forest
  parent_node_id INTEGER,             -- NULL for root nodes
  chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL, metadata TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, node_id)
);
CREATE TABLE prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  session_id TEXT NOT NULL
, is_shell INTEGER NOT NULL DEFAULT 0);
CREATE TABLE refinery_schema_history(
             version int4 PRIMARY KEY,
             name VARCHAR(255),
             applied_on VARCHAR(255),
             checksum VARCHAR(255));
CREATE TABLE rendered_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  rendered_html TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, sequence_number)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
CREATE TABLE subagent_heads (
    session_id    TEXT    NOT NULL,
    agent_id      TEXT    NOT NULL,
    chain_node_id INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (session_id, agent_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE TABLE tool_call_state (
    session_id    TEXT    NOT NULL,
    tool_call_id  TEXT    NOT NULL,
    -- Serialised acp::ToolCall JSON (the initial ToolCall event).
    -- Nullable: may be absent for interrupted sessions where the tool result
    -- was saved but resolve_and_commit did not complete.
    tool_call_json     TEXT,
    -- Serialised acp::ToolCallUpdate JSON (the final completion update).
    tool_call_update_json TEXT,
    PRIMARY KEY (session_id, tool_call_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_message_nodes_session
  ON message_nodes(session_id);
CREATE INDEX idx_prompt_history_session
  ON prompt_history(session_id);
CREATE INDEX idx_prompt_history_timestamp
  ON prompt_history(timestamp DESC);
CREATE INDEX idx_rendered_commits_session
  ON rendered_commits(session_id, sequence_number);
CREATE INDEX idx_sessions_activity
  ON sessions(last_activity_at DESC);
CREATE INDEX idx_sessions_hidden ON sessions(hidden);
