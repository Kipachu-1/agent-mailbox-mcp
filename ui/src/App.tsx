import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Database, KeyRound, LockKeyhole, LogOut, RefreshCw, SearchCheck, Users } from "lucide-react";
import { AccessKeysPanel } from "@/components/access-keys-panel";
import {
  ActiveLocksCard,
  OnlineAgentsCard,
  PinnedNotesCard,
  RecentTasksCard,
  WorkspacesCard,
} from "@/components/dashboard-lists";
import { MetricCard } from "@/components/metric-card";
import { SignInCard } from "@/components/sign-in-card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { CreateAccessKeyForm, CreatedAccessKeyResponse, DashboardPayload } from "@/types/dashboard";

const storageKey = "agent-mailbox-admin-token";

const initialForm: CreateAccessKeyForm = {
  name: "",
  agent_id: "",
  agent_name: "",
  workspace: "default",
};

export function App() {
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem(storageKey) ?? "");
  const [tokenInput, setTokenInput] = useState(adminToken);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [form, setForm] = useState<CreateAccessKeyForm>(initialForm);
  const [createdToken, setCreatedToken] = useState<CreatedAccessKeyResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const api = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const response = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          localStorage.removeItem(storageKey);
          setAdminToken("");
          setDashboard(null);
        }
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
      }

      return response.json() as Promise<T>;
    },
    [adminToken],
  );

  const refresh = useCallback(async () => {
    if (!adminToken) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setDashboard(await api<DashboardPayload>("/api/dashboard"));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [adminToken, api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function signIn(event: FormEvent) {
    event.preventDefault();
    const token = tokenInput.trim();
    if (!token) {
      return;
    }
    localStorage.setItem(storageKey, token);
    setAdminToken(token);
  }

  function signOut() {
    localStorage.removeItem(storageKey);
    setAdminToken("");
    setTokenInput("");
    setDashboard(null);
  }

  async function createKey(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setCreatedToken(null);

    try {
      const created = await api<CreatedAccessKeyResponse>("/api/access-keys", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setCreatedToken(created);
      setForm({ ...initialForm, workspace: form.workspace || "default" });
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function revokeKey(id: string) {
    setError(null);
    try {
      await api(`/api/access-keys/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyToken() {
    if (!createdToken) {
      return;
    }
    await navigator.clipboard.writeText(createdToken.token);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  if (!adminToken) {
    return <SignInCard tokenInput={tokenInput} onTokenInputChange={setTokenInput} onSubmit={signIn} />;
  }

  return (
    <main className="min-h-screen">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-lg bg-emerald-100 text-emerald-700">
              <Database size={24} aria-hidden />
            </div>
            <div>
              <h1 className="text-2xl font-semibold">Agent Mailbox</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {dashboard ? `${dashboard.workspaces.length || 1} workspace view` : "Dashboard"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="icon" title="Refresh" aria-label="Refresh" onClick={refresh} disabled={loading}>
              <RefreshCw size={18} aria-hidden className={loading ? "animate-spin" : ""} />
            </Button>
            <Button type="button" variant="outline" size="icon" title="Sign out" aria-label="Sign out" onClick={signOut}>
              <LogOut size={18} aria-hidden />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {error ? <Alert variant="destructive" className="mb-5">{error}</Alert> : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={<KeyRound size={20} aria-hidden />}
            label="Enabled keys"
            value={dashboard?.summary.enabled_keys ?? 0}
            tone="emerald"
          />
          <MetricCard
            icon={<Users size={20} aria-hidden />}
            label="Online agents"
            value={dashboard?.summary.online_agents ?? 0}
            tone="blue"
          />
          <MetricCard
            icon={<SearchCheck size={20} aria-hidden />}
            label="Open tasks"
            value={dashboard?.summary.open_tasks ?? 0}
            tone="amber"
          />
          <MetricCard
            icon={<LockKeyhole size={20} aria-hidden />}
            label="Active locks"
            value={dashboard?.summary.active_locks ?? 0}
            tone="rose"
          />
        </section>

        <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <AccessKeysPanel
            keys={dashboard?.keys ?? []}
            form={form}
            createdToken={createdToken}
            copied={copied}
            onFormChange={setForm}
            onCreateKey={createKey}
            onCopyToken={() => void copyToken()}
            onRevokeKey={(id) => void revokeKey(id)}
          />
          <div className="grid gap-6">
            <OnlineAgentsCard agents={dashboard?.online_agents ?? []} />
            <WorkspacesCard workspaces={dashboard?.workspaces ?? []} />
          </div>
        </section>

        <section className="mt-6 grid gap-6 xl:grid-cols-3">
          <RecentTasksCard tasks={dashboard?.recent_tasks ?? []} />
          <ActiveLocksCard locks={dashboard?.active_locks ?? []} />
          <PinnedNotesCard notes={dashboard?.pinned_notes ?? []} />
        </section>
      </div>
    </main>
  );
}
