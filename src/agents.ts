import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { agentConfig } from "./config.js";
import { isEditor, openCodeRuntime } from "./integrations.js";

export function executable(agent: string, env = process.env): string | undefined {
  for (const directory of (env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""]) {
      const path = join(directory, `${agent}${suffix}`);
      try { accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return path; } catch { /* next PATH entry */ }
    }
  }
}

/** Session-scoped connection settings; never write to agent configuration or credential files. */
export function launchPlan(agent: string, auth: string, port: number, inherited = process.env) {
  agentConfig(agent, auth, "bash", port); // shared validation
  if (isEditor(agent)) throw new Error(`Use jev-classifier connect ${agent}, then open the editor normally. Its MCP integration provides routing advice.`);
  if (agent === "opencode" && auth !== "api-key") throw new Error("OpenCode proxy integration requires API-key providers. Use run opencode --auth api-key; subscription plugins can bypass the proxy.");
  const env = { ...inherited };
  const url = `http://127.0.0.1:${port}/${auth === "oauth" ? "oauth" : "api"}/${agent}`;
  const args: string[] = [];
  if (agent === "opencode") {
    env.OPENCODE_CONFIG_CONTENT = openCodeRuntime(port, env.OPENCODE_CONFIG_CONTENT);
  } else if (agent === "codex") {
    args.push("-c", 'model_provider="jev_session"', "-c",
      `model_providers.jev_session={name="Jev",base_url="${url}${auth === "oauth" ? "" : "/v1"}",wire_api="responses",supports_websockets=false,${auth === "oauth" ? "requires_openai_auth=true" : 'env_key="OPENAI_API_KEY"'}}`);
  } else if (agent === "claude") {
    env.ANTHROPIC_BASE_URL = url;
    if (auth === "oauth") { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
  } else if (auth === "oauth") {
    env.GROK_CLI_CHAT_PROXY_BASE_URL = `${url}/v1`;
    delete env.XAI_API_KEY;
    delete env.GROK_MODELS_BASE_URL;
  } else env.GROK_MODELS_BASE_URL = `${url}/v1`;
  if (auth === "api-key" && agent !== "opencode") {
    const key = { codex: "OPENAI_API_KEY", claude: "ANTHROPIC_API_KEY", grok: "XAI_API_KEY" }[agent as "codex" | "claude" | "grok"];
    if (!env[key]) throw new Error(`Set ${key} in this terminal, or choose existing-login authentication in setup.`);
  }
  for (const key of ["JEV_API_KEY", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "UPSTREAM_API_KEY"]) delete env[key];
  return { agent, env, args, url };
}

// Windows npm shims need a shell. Quote every argument as a PowerShell literal, never interpolate shell code.
export function spawnCommand(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform !== "win32" || /\.exe$/i.test(file)) return { file, args };
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = `& ${quote(file)} ${args.map(quote).join(" ")}; exit $LASTEXITCODE`;
  return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
}

export async function launchAgent(file: string, plan: ReturnType<typeof launchPlan>, extra: string[]): Promise<number> {
  const command = spawnCommand(file, [...plan.args, ...extra]);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { env: plan.env, stdio: "inherit" });
    // The foreground agent receives terminal interrupts too; keep the proxy alive until it exits.
    const interrupt = () => { if (process.platform !== "win32") child.kill("SIGINT"); };
    process.on("SIGINT", interrupt);
    const cleanup = () => process.off("SIGINT", interrupt);
    child.once("error", error => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => { cleanup(); resolve(code ?? (signal ? 130 : 1)); });
  });
}
