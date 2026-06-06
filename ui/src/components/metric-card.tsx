import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const toneClasses = {
  emerald: "bg-emerald-50 text-emerald-700",
  blue: "bg-blue-50 text-blue-700",
  amber: "bg-amber-50 text-amber-700",
  rose: "bg-rose-50 text-rose-700",
};

export function MetricCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone: keyof typeof toneClasses;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-4">
          <span className={cn("grid size-10 place-items-center rounded-md", toneClasses[tone])}>{icon}</span>
          <span className="text-3xl font-semibold tabular-nums text-foreground">{value}</span>
        </div>
        <p className="mt-3 text-sm font-medium text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
