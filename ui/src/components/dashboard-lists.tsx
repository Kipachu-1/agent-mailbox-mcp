import { Activity, LockKeyhole, NotebookTabs, SearchCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatTime, statusTone } from "@/lib/format";
import type { Agent, Lock, Note, Task } from "@/types/dashboard";

export function OnlineAgentsCard({ agents }: { agents: Agent[] }) {
  return (
    <Panel title="Online agents" icon={<Activity size={18} aria-hidden />}>
      <div className="space-y-3">
        {agents.map((agent) => (
          <Row key={`${agent.workspace}:${agent.id}`}>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{agent.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {agent.id} · {agent.workspace}
              </p>
            </div>
            <Badge variant="info">{agent.status}</Badge>
          </Row>
        ))}
        {!agents.length ? <Empty label="No online agents" /> : null}
      </div>
    </Panel>
  );
}

export function WorkspacesCard({ workspaces }: { workspaces: string[] }) {
  return (
    <Panel title="Workspaces" icon={<NotebookTabs size={18} aria-hidden />}>
      <div className="flex flex-wrap gap-2">
        {workspaces.map((workspace) => (
          <Badge key={workspace} variant="outline" className="rounded-full">
            {workspace}
          </Badge>
        ))}
        {!workspaces.length ? <Empty label="No workspace data" /> : null}
      </div>
    </Panel>
  );
}

export function RecentTasksCard({ tasks }: { tasks: Task[] }) {
  const counts = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Panel title="Recent tasks" icon={<SearchCheck size={18} aria-hidden />}>
      <div className="mb-3 flex flex-wrap gap-2">
        {Object.entries(counts).map(([status, count]) => (
          <Badge key={status} variant="secondary">
            {status}: {count}
          </Badge>
        ))}
      </div>
      <div className="space-y-3">
        {tasks.slice(0, 8).map((task) => (
          <div key={task.id}>
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm font-medium">{task.title}</p>
              <Badge variant={statusTone(task.status)}>{task.status}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {task.workspace} · {task.assignee_id ?? "unassigned"} · {formatTime(task.updated_at)}
            </p>
            <Separator className="mt-3 last:hidden" />
          </div>
        ))}
        {!tasks.length ? <Empty label="No recent tasks" /> : null}
      </div>
    </Panel>
  );
}

export function ActiveLocksCard({ locks }: { locks: Lock[] }) {
  return (
    <Panel title="Active locks" icon={<LockKeyhole size={18} aria-hidden />}>
      <div className="space-y-3">
        {locks.slice(0, 10).map((lock) => (
          <div key={lock.id}>
            <p className="break-words text-sm font-medium">{lock.resource}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {lock.owner_agent_id} · {lock.workspace} · expires {formatTime(lock.expires_at)}
            </p>
            {lock.purpose ? <p className="mt-1 text-xs text-muted-foreground">{lock.purpose}</p> : null}
            <Separator className="mt-3" />
          </div>
        ))}
        {!locks.length ? <Empty label="No active locks" /> : null}
      </div>
    </Panel>
  );
}

export function PinnedNotesCard({ notes }: { notes: Note[] }) {
  return (
    <Panel title="Pinned notes" icon={<NotebookTabs size={18} aria-hidden />}>
      <div className="space-y-3">
        {notes.slice(0, 8).map((note) => (
          <div key={note.id}>
            <p className="text-sm font-medium">{note.title}</p>
            <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{note.body}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {note.workspace}
              {note.channel ? ` · ${note.channel}` : ""} · {formatTime(note.updated_at)}
            </p>
            <Separator className="mt-3" />
          </div>
        ))}
        {!notes.length ? <Empty label="No pinned notes" /> : null}
      </div>
    </Panel>
  );
}

function Panel({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <span className="text-muted-foreground">{icon}</span>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3 border-b pb-3 last:border-0 last:pb-0">{children}</div>;
}

function Empty({ label }: { label: string }) {
  return <p className="py-4 text-sm text-muted-foreground">{label}</p>;
}
