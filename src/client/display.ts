export type WorkspaceDisplay = {
  fullPath: string;
  name: string;
  parent: string;
};

export type ThreadDisplay = {
  subtitle: string;
  title: string;
};

export function getWorkspaceDisplay(path: string | undefined): WorkspaceDisplay {
  const fullPath = (path ?? "").trim();
  if (!fullPath) {
    return { fullPath: "", name: "No project", parent: "Open a workspace folder" };
  }

  const trimmed = fullPath.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const name = parts.at(-1) ?? trimmed;
  const parent = trimmed.slice(0, Math.max(0, trimmed.length - name.length)).replace(/[\\/]+$/, "");

  return {
    fullPath,
    name,
    parent: parent || fullPath,
  };
}

export function getThreadDisplay(thread: { id: string; title?: string }): ThreadDisplay {
  const title = thread.title?.trim();
  if (title) {
    return { subtitle: thread.id, title };
  }
  return { subtitle: "Untitled thread", title: thread.id };
}

export function formatActivityTime(value?: number): string {
  if (!value) {
    return "No recent activity";
  }
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(milliseconds).toLocaleString();
}
