export interface AccessKey {
  id: string;
  name: string;
  token_prefix: string;
  agent_id: string;
  agent_name: string;
  workspace: string;
  enabled: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  name: string;
  workspace: string;
  status: string;
  current_task_id: string | null;
  last_seen_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  title: string;
  workspace: string;
  status: string;
  creator_id: string;
  assignee_id: string | null;
  priority: number;
  updated_at: string;
}

export interface Lock {
  id: string;
  workspace: string;
  resource: string;
  owner_agent_id: string;
  purpose: string | null;
  expires_at: string;
}

export interface Note {
  id: string;
  workspace: string;
  channel: string | null;
  title: string;
  body: string;
  updated_at: string;
}

export interface DashboardPayload {
  summary: Record<string, number>;
  keys: AccessKey[];
  agents: Agent[];
  online_agents: Agent[];
  recent_tasks: Task[];
  active_locks: Lock[];
  pinned_notes: Note[];
  workspaces: string[];
}

export interface CreatedAccessKeyResponse {
  key: AccessKey;
  token: string;
}

export interface CreateAccessKeyForm {
  name: string;
  agent_id: string;
  agent_name: string;
  workspace: string;
}
