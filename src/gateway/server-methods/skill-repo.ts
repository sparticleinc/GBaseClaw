import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillRepoStatusParams,
  validateSkillRepoInitParams,
  validateSkillRepoPushParams,
  validateSkillRepoPullParams,
  validateSkillRepoTagParams,
  validateSkillRepoAuthParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const CMD_TIMEOUT_MS = 30_000;

function resolveRepoDir(cfg: OpenClawConfig): string {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  return path.resolve(workspaceDir, "custom-skills");
}

// Resolve GH_TOKEN from config or environment
function resolveGhToken(cfg: OpenClawConfig): string | undefined {
  const configToken = (cfg.skills as Record<string, unknown> | undefined)?.repoGhToken;
  if (typeof configToken === "string" && configToken.trim()) {
    return configToken.trim();
  }
  return process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? undefined;
}

async function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommandWithTimeout(["git", ...args], {
    cwd,
    timeoutMs: CMD_TIMEOUT_MS,
    env,
  });
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function gh(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommandWithTimeout(["gh", ...args], {
    cwd,
    timeoutMs: CMD_TIMEOUT_MS,
    env,
  });
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

// Build env object with GH_TOKEN injected if available
function buildGhEnv(cfg: OpenClawConfig): Record<string, string> | undefined {
  const token = resolveGhToken(cfg);
  if (!token) {
    return undefined;
  }
  return { ...process.env, GH_TOKEN: token } as Record<string, string>;
}

export const skillRepoHandlers: GatewayRequestHandlers = {
  "skills.repo.status": async ({ params, respond }) => {
    if (!validateSkillRepoStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.repo.status params: ${formatValidationErrors(validateSkillRepoStatusParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const repoDir = resolveRepoDir(cfg);
    const ghEnv = buildGhEnv(cfg);

    // Check gh auth status (use home dir as cwd since repoDir may not exist yet)
    let ghAuth = false;
    try {
      const authResult = await gh(["auth", "status"], os.homedir(), ghEnv);
      ghAuth = authResult.ok;
    } catch {
      ghAuth = false;
    }

    // Check if a token is configured (even if gh auth status fails)
    const hasToken = !!resolveGhToken(cfg);

    // Check if git repo is initialized
    let initialized = false;
    try {
      const gitDirResult = await git(["rev-parse", "--git-dir"], repoDir);
      initialized = gitDirResult.ok;
    } catch {
      initialized = false;
    }

    if (!initialized) {
      respond(true, { initialized, dirty: false, ghAuth: ghAuth || hasToken, repoDir }, undefined);
      return;
    }

    // Get branch
    let branch: string | undefined;
    try {
      const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
      if (branchResult.ok && branchResult.stdout) {
        branch = branchResult.stdout;
      }
    } catch {
      // ignore
    }

    // Get remote URL and derive repo name
    let remote: string | undefined;
    let repoName: string | undefined;
    try {
      const remoteResult = await git(["remote", "get-url", "origin"], repoDir);
      if (remoteResult.ok && remoteResult.stdout) {
        remote = remoteResult.stdout;
        const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
        if (match) {
          repoName = match[1];
        }
      }
    } catch {
      // ignore
    }

    // Check dirty status
    let dirty = false;
    try {
      const statusResult = await git(["status", "--porcelain"], repoDir);
      dirty = statusResult.ok && statusResult.stdout.length > 0;
    } catch {
      // ignore
    }

    // Get last commit
    let lastCommit: string | undefined;
    try {
      const logResult = await git(["log", "-1", "--format=%H %s"], repoDir);
      if (logResult.ok && logResult.stdout) {
        lastCommit = logResult.stdout;
      }
    } catch {
      // ignore
    }

    // Get last tag
    let lastTag: string | undefined;
    try {
      const tagResult = await git(["describe", "--tags", "--abbrev=0"], repoDir);
      if (tagResult.ok && tagResult.stdout) {
        lastTag = tagResult.stdout;
      }
    } catch {
      // ignore
    }

    respond(
      true,
      {
        initialized,
        remote,
        branch,
        repoName,
        dirty,
        lastCommit,
        lastTag,
        ghAuth: ghAuth || hasToken,
        repoDir,
      },
      undefined,
    );
  },

  "skills.repo.auth": async ({ params, respond }) => {
    if (!validateSkillRepoAuthParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.repo.auth params: ${formatValidationErrors(validateSkillRepoAuthParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as { token: string };
    const token = normalizeSecretInput(p.token);

    const cfg = loadConfig();
    const skills = cfg.skills ? { ...cfg.skills } : {};

    if (token) {
      (skills as Record<string, unknown>).repoGhToken = token;
    } else {
      delete (skills as Record<string, unknown>).repoGhToken;
    }

    const nextConfig: OpenClawConfig = { ...cfg, skills };
    await writeConfigFile(nextConfig);

    // Verify the token works
    let valid = false;
    if (token) {
      try {
        const env = { ...process.env, GH_TOKEN: token } as Record<string, string>;
        const result = await gh(["auth", "status"], os.homedir(), env);
        valid = result.ok;
      } catch {
        valid = false;
      }
    }

    respond(
      true,
      {
        ok: true,
        valid,
        message: token
          ? valid
            ? "Token saved and verified"
            : "Token saved but verification failed"
          : "Token removed",
      },
      undefined,
    );
  },

  "skills.repo.init": async ({ params, respond }) => {
    if (!validateSkillRepoInitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.repo.init params: ${formatValidationErrors(validateSkillRepoInitParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as { org: string; repoName: string; isPrivate?: boolean };
    const cfg = loadConfig();
    const repoDir = resolveRepoDir(cfg);
    const ghEnv = buildGhEnv(cfg);
    const visibility = p.isPrivate === false ? "--public" : "--private";
    const fullName = `${p.org}/${p.repoName}`;

    try {
      await mkdir(repoDir, { recursive: true });

      const createResult = await gh(["repo", "create", fullName, visibility], repoDir, ghEnv);
      if (!createResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `gh repo create failed: ${createResult.stderr}`),
        );
        return;
      }

      const initResult = await git(["init"], repoDir);
      if (!initResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git init failed: ${initResult.stderr}`),
        );
        return;
      }

      const remoteUrl = `https://github.com/${fullName}.git`;
      const addRemoteResult = await git(["remote", "add", "origin", remoteUrl], repoDir);
      if (!addRemoteResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git remote add failed: ${addRemoteResult.stderr}`),
        );
        return;
      }

      const readmeContent = `# ${p.repoName}\n\nCustom skills repository.\n`;
      await writeFile(path.join(repoDir, "README.md"), readmeContent, "utf-8");

      await git(["add", "."], repoDir);
      await git(["commit", "-m", "Initial commit"], repoDir);

      // Push with token-authenticated URL
      const token = resolveGhToken(cfg);
      const pushEnv = token
        ? ({ ...process.env, GH_TOKEN: token } as Record<string, string>)
        : ghEnv;
      const pushResult = await git(["push", "-u", "origin", "HEAD"], repoDir, pushEnv);
      if (!pushResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git push failed: ${pushResult.stderr}`),
        );
        return;
      }

      // Auto-register repoDir in skills.load.extraDirs config
      const updatedCfg = loadConfig();
      const skills = updatedCfg.skills ? { ...updatedCfg.skills } : {};
      const load = skills.load ? { ...skills.load } : {};
      const extraDirs: string[] = Array.isArray(load.extraDirs) ? [...load.extraDirs] : [];
      if (!extraDirs.includes(repoDir)) {
        extraDirs.push(repoDir);
      }
      load.extraDirs = extraDirs;
      skills.load = load;
      const nextConfig: OpenClawConfig = { ...updatedCfg, skills };
      await writeConfigFile(nextConfig);

      respond(true, { ok: true, repoDir, remote: remoteUrl, repoName: p.repoName }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `init failed: ${message}`));
    }
  },

  "skills.repo.push": async ({ params, respond }) => {
    if (!validateSkillRepoPushParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.repo.push params: ${formatValidationErrors(validateSkillRepoPushParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as { message?: string };
    const cfg = loadConfig();
    const repoDir = resolveRepoDir(cfg);
    const ghEnv = buildGhEnv(cfg);
    const commitMessage = p.message || "Update custom skills";

    try {
      const addResult = await git(["add", "."], repoDir);
      if (!addResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git add failed: ${addResult.stderr}`),
        );
        return;
      }

      const statusResult = await git(["status", "--porcelain"], repoDir);
      if (statusResult.ok && statusResult.stdout.length === 0) {
        respond(true, { ok: true, message: "nothing to commit, working tree clean" }, undefined);
        return;
      }

      const commitResult = await git(["commit", "-m", commitMessage], repoDir);
      if (!commitResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git commit failed: ${commitResult.stderr}`),
        );
        return;
      }

      const pushResult = await git(["push"], repoDir, ghEnv);
      if (!pushResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git push failed: ${pushResult.stderr}`),
        );
        return;
      }

      respond(true, { ok: true, message: commitResult.stdout }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `push failed: ${message}`));
    }
  },

  "skills.repo.pull": async ({ params, respond }) => {
    if (!validateSkillRepoPullParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.repo.pull params: ${formatValidationErrors(validateSkillRepoPullParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const repoDir = resolveRepoDir(cfg);
    const ghEnv = buildGhEnv(cfg);

    try {
      const pullResult = await git(["pull"], repoDir, ghEnv);
      if (!pullResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git pull failed: ${pullResult.stderr}`),
        );
        return;
      }
      respond(true, { ok: true, message: pullResult.stdout }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `pull failed: ${message}`));
    }
  },

  "skills.repo.tag": async ({ params, respond }) => {
    if (!validateSkillRepoTagParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.repo.tag params: ${formatValidationErrors(validateSkillRepoTagParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as { tag: string; message?: string };
    const cfg = loadConfig();
    const repoDir = resolveRepoDir(cfg);
    const ghEnv = buildGhEnv(cfg);
    const tagMessage = p.message || p.tag;

    try {
      const tagResult = await git(["tag", "-a", p.tag, "-m", tagMessage], repoDir);
      if (!tagResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git tag failed: ${tagResult.stderr}`),
        );
        return;
      }

      const pushResult = await git(["push", "origin", p.tag], repoDir, ghEnv);
      if (!pushResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git push tag failed: ${pushResult.stderr}`),
        );
        return;
      }

      respond(true, { ok: true, tag: p.tag }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, `tag failed: ${message}`));
    }
  },
};
