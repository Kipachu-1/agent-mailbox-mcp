export function formatTime(value: string | null): string {
  if (!value) {
    return "Never";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function statusTone(status: string): "success" | "warning" | "info" | "muted" {
  if (status === "done") {
    return "success";
  }
  if (status === "blocked" || status === "claimed") {
    return "warning";
  }
  if (status === "open") {
    return "info";
  }
  return "muted";
}
