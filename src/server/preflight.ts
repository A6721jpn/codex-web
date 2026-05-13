import { spawn } from "node:child_process";

import { redactForReport } from "../m0/redaction.ts";

type CommandResult = {
  ok: boolean;
  stderr: string;
  stdout: string;
};

type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

export type PreflightCheckResult = {
  appServerHelp: {
    ok: boolean;
    stderrSummary?: string;
  };
  codexVersion: {
    ok: boolean;
    version?: string;
  };
  processCleanup: {
    docsRequired: true;
    status: "risk-carried";
  };
  shellProbe: {
    errorCode?: "WINDOWS_LOGON_RIGHT_1385" | "SHELL_PROBE_FAILED";
    ok: boolean;
    stderrSummary?: string;
  };
  windowsSandboxReadiness: {
    status: "optional-check-only";
  };
};

export async function runPreflightChecks(input: { codexBin: string; runCommand?: RunCommand }): Promise<PreflightCheckResult> {
  const runCommand = input.runCommand ?? runCommandDefault;
  const version = await runCommand(input.codexBin, ["--version"]);
  const help = await runCommand(input.codexBin, ["app-server", "--help"]);
  const shell = await runCommand("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]);

  return {
    appServerHelp: {
      ok: help.ok && help.stdout.includes("app-server"),
      stderrSummary: summarize(help.stderr),
    },
    codexVersion: {
      ok: version.ok,
      version: version.ok ? redactForReport(version.stdout.trim()) : undefined,
    },
    processCleanup: {
      docsRequired: true,
      status: "risk-carried",
    },
    shellProbe: {
      errorCode: shell.ok ? undefined : detectShellError(shell.stderr),
      ok: shell.ok,
      stderrSummary: summarize(shell.stderr),
    },
    windowsSandboxReadiness: {
      status: "optional-check-only",
    },
  };
}

async function runCommandDefault(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = tail(stdout + chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = tail(stderr + chunk);
    });
    child.on("error", (error) => {
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function detectShellError(stderr: string): "WINDOWS_LOGON_RIGHT_1385" | "SHELL_PROBE_FAILED" {
  return stderr.includes("1385") ? "WINDOWS_LOGON_RIGHT_1385" : "SHELL_PROBE_FAILED";
}

function summarize(value: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }
  const redacted = redactForReport(value)
    .replace(/<html>[\s\S]*/i, "<html redacted>")
    .replace(/failed with status ([0-9]{3} [^:]+):.*/i, "failed with status $1: <body redacted>");
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...<truncated>` : redacted;
}

function tail(value: string): string {
  return value.length > 32_768 ? value.slice(-32_768) : value;
}
