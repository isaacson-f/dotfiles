import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, resolve } from "node:path";

const run = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "repository";

export interface RepositoryIdentity {
  scope: string;
  directory: string;
}

/** Normalize the remote format used by the previous memory extension. */
export function normalizeRemoteUrl(value: string): string | undefined {
  const raw = value.trim().replace(/\/$/, "");
  const match = /^git@([^:/]+):(.+)$/i.exec(raw) ?? /^ssh:\/\/git@([^/]+)\/(.+)$/i.exec(raw) ?? /^https?:\/\/([^/]+)\/(.+)$/i.exec(raw);
  if (!match) return;
  const host = match[1].toLowerCase();
  const path = match[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!/^[a-z0-9._-]{1,253}$/.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..") || !path || !path.split("/").every((part) => /^[A-Za-z0-9._-]{1,128}$/.test(part) && part !== "." && part !== "..")) return;
  return `${host}/${path}`;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], { timeout: 1000, maxBuffer: 8192 });
    return stdout.trim() || undefined;
  } catch {
    return;
  }
}

async function commonDirectory(cwd: string): Promise<string | undefined> {
  return git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

/** The first worktree is Git's primary worktree and anchors local worktree memory. */
async function primaryWorktree(cwd: string): Promise<string | undefined> {
  const output = await git(cwd, ["worktree", "list", "--porcelain"]);
  const first = output?.split("\n").find((line) => line.startsWith("worktree "));
  return first ? resolve(first.slice("worktree ".length)) : undefined;
}

/** Stable path names preserve the previous remote and linked-worktree repository stores. */
export async function repositoryIdentity(cwd: string): Promise<RepositoryIdentity> {
  const workspace = resolve(cwd);
  const top = await git(workspace, ["rev-parse", "--show-toplevel"]);
  const common = top ? await commonDirectory(workspace) : undefined;
  const origin = common ? await git(workspace, ["--git-dir", common, "config", "--local", "--get", "remote.origin.url"]) : await git(workspace, ["config", "--get", "remote.origin.url"]);
  const remote = top ? normalizeRemoteUrl(origin ?? "") : undefined;
  const anchor = top ? await primaryWorktree(workspace) ?? resolve(top) : workspace;
  const scope = remote ? `repo/${remote}` : top ? `git-local-${hash(anchor).slice(0, 16)}` : `cwd-${hash(workspace).slice(0, 16)}`;
  const label = remote ? slug(remote.replace(/\//g, "-")) : slug(basename(anchor).replace(/\.git$/i, "") || "repository");
  return { scope, directory: `${label}-${hash(scope).slice(0, 8)}` };
}
