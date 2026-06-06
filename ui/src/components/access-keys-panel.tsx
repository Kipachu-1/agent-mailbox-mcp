import { type FormEvent } from "react";
import { Check, ClipboardCopy, KeyRound, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime } from "@/lib/format";
import type { AccessKey, CreateAccessKeyForm, CreatedAccessKeyResponse } from "@/types/dashboard";

export function AccessKeysPanel({
  keys,
  form,
  createdToken,
  copied,
  onFormChange,
  onCreateKey,
  onCopyToken,
  onRevokeKey,
}: {
  keys: AccessKey[];
  form: CreateAccessKeyForm;
  createdToken: CreatedAccessKeyResponse | null;
  copied: boolean;
  onFormChange: (form: CreateAccessKeyForm) => void;
  onCreateKey: (event: FormEvent) => void;
  onCopyToken: () => void;
  onRevokeKey: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <KeyRound size={18} aria-hidden className="text-muted-foreground" />
        <CardTitle>Access keys</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onCreateKey} className="grid gap-3 border-b pb-5 lg:grid-cols-5">
          <TextField
            label="Name"
            value={form.name}
            onChange={(value) => onFormChange({ ...form, name: value })}
            required
          />
          <TextField
            label="Agent id"
            value={form.agent_id}
            onChange={(value) => onFormChange({ ...form, agent_id: value })}
            required
          />
          <TextField
            label="Agent name"
            value={form.agent_name}
            onChange={(value) => onFormChange({ ...form, agent_name: value })}
          />
          <TextField
            label="Workspace"
            value={form.workspace}
            onChange={(value) => onFormChange({ ...form, workspace: value })}
          />
          <Button type="submit" className="self-end">
            <Plus size={17} aria-hidden />
            Create key
          </Button>
        </form>

        {createdToken ? (
          <Alert variant="success" className="mt-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <AlertTitle>{createdToken.key.name}</AlertTitle>
                <AlertDescription>
                  <code className="block overflow-x-auto whitespace-nowrap text-sm">{createdToken.token}</code>
                </AlertDescription>
              </div>
              <Button type="button" variant="outline" size="icon" title="Copy token" aria-label="Copy token" onClick={onCopyToken}>
                {copied ? <Check size={18} aria-hidden /> : <ClipboardCopy size={18} aria-hidden />}
              </Button>
            </div>
          </Alert>
        ) : null}

        <div className="mt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead aria-label="Actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium text-foreground">{key.name}</TableCell>
                  <TableCell>
                    <div className="font-medium text-foreground">{key.agent_name}</div>
                    <div className="text-xs text-muted-foreground">{key.agent_id}</div>
                  </TableCell>
                  <TableCell>{key.workspace}</TableCell>
                  <TableCell className="font-mono text-xs">{key.token_prefix}</TableCell>
                  <TableCell>{formatTime(key.last_used_at)}</TableCell>
                  <TableCell>
                    <Badge variant={key.enabled ? "success" : "muted"}>{key.enabled ? "Enabled" : "Revoked"}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title="Revoke key"
                      aria-label="Revoke key"
                      disabled={!key.enabled}
                      onClick={() => onRevokeKey(key.id)}
                    >
                      <Trash2 size={17} aria-hidden />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function TextField({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const id = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} required={required} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
