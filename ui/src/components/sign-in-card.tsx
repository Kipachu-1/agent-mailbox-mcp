import { type FormEvent } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignInCard({
  tokenInput,
  onTokenInputChange,
  onSubmit,
}: {
  tokenInput: string;
  onTokenInputChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 lg:px-8">
      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-xl items-center">
        <Card className="w-full shadow-panel">
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <div className="grid size-11 place-items-center rounded-lg bg-emerald-100 text-emerald-700">
              <ShieldCheck size={24} aria-hidden />
            </div>
            <div>
              <CardTitle className="text-2xl">Agent Mailbox</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Admin dashboard</p>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit}>
              <Label htmlFor="admin-token">Admin token</Label>
              <Input
                id="admin-token"
                type="password"
                value={tokenInput}
                onChange={(event) => onTokenInputChange(event.target.value)}
                className="mt-2"
                autoComplete="current-password"
              />
              <Button type="submit" className="mt-5 w-full">
                <KeyRound size={18} aria-hidden />
                Open dashboard
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
