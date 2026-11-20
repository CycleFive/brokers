import { spawn } from "node:child_process";
import { join } from "node:path";

export interface RunResult { code: number; stdout: string; stderr: string }
/** Runs wrangler with these arguments. `interactive` hands it the terminal (stdout and stderr then come back empty). */
export type Run = (args: string[], opts: { cwd: string; interactive?: boolean }) => Promise<RunResult>;

/** Spawns <repoRoot>/node_modules/.bin/wrangler. */
export function wranglerRunner(repoRoot: string): Run {
  const bin = join(repoRoot, "node_modules", ".bin", "wrangler");
  return (args, { cwd, interactive }) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd, stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

/** The JSON array between the first "[" and the last "]" of the text, or undefined. */
function jsonArray(text: string): unknown[] | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface KvItem { id: string; title: string }
interface SecretItem { name: string }

function tail(text: string, lines = 20): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/** title -> id */
export async function kvNamespaces(run: Run, cwd: string): Promise<Map<string, string>> {
  const r = await run(["kv", "namespace", "list"], { cwd });
  const items = jsonArray(r.stdout) as KvItem[] | undefined;
  if (r.code !== 0 || !items) throw new Error(`wrangler kv namespace list failed (exit ${r.code})\n${tail(r.stdout + r.stderr)}`);
  return new Map(items.map((i) => [i.title, i.id]));
}

export async function createKv(run: Run, cwd: string, title: string): Promise<string> {
  const r = await run(["kv", "namespace", "create", title], { cwd });
  if (r.code !== 0) throw new Error(`wrangler kv namespace create ${title} failed (exit ${r.code})\n${tail(r.stdout + r.stderr)}`);
  const id = (await kvNamespaces(run, cwd)).get(title);
  if (id === undefined) throw new Error(`created KV namespace "${title}" but it is not in the listing`);
  return id;
}

/** null when the Worker does not exist; otherwise the names of the secrets it has. */
export async function secretNames(run: Run, cwd: string, worker: string): Promise<string[] | null> {
  const r = await run(["secret", "list", "--name", worker], { cwd });
  const output = r.stdout + r.stderr;
  if (output.includes("not found")) return null;
  const items = r.code === 0 ? (jsonArray(r.stdout) as SecretItem[] | undefined) : undefined;
  if (!items) throw new Error(`wrangler secret list --name ${worker}: unexpected output (exit ${r.code})\n${tail(output)}`);
  return items.map((i) => i.name);
}

/** Repeats once when the output contains "10007" (the Worker was only just created). Returns the Version ID if printed. */
export async function deployConfig(run: Run, cwd: string, configPath: string): Promise<string | undefined> {
  let r = await run(["deploy", "-c", configPath], { cwd });
  if (r.code !== 0 && (r.stdout + r.stderr).includes("10007")) r = await run(["deploy", "-c", configPath], { cwd });
  const output = r.stdout + r.stderr;
  if (r.code !== 0) throw new Error(`wrangler deploy -c ${configPath} failed (exit ${r.code})\n${tail(output)}`);
  return /Current Version ID: (\S+)/.exec(output)?.[1];
}
