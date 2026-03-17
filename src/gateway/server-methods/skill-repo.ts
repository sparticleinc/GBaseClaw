import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillRepoStatusParams,
  validateSkillRepoInitParams,
  validateSkillRepoPushParams,
  validateSkillRepoPullParams,
  validateSkillRepoTagParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const CMD_TIMEOUT_MS = 30_000;

function resolveRepoDir(cfg: OpenClawConfig): string {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  return path.resolve(workspaceDir, "custom-skills");
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: CMD_TIMEOUT_MS });
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function gh(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommandWithTimeout(["gh", ...args], { cwd, timeoutMs: CMD_TIMEOUT_MS });
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
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

    // Check gh auth status
    let ghAuth = false;
    try {
      const authResult = await gh(["auth", "status"], repoDir);
      ghAuth = authResult.ok;
    } catch {
      ghAuth = false;
    }

    // Check if git repo is initialized
    let initialized = false;
    try {
      const gitDirResult = await git(["rev-parse", "--git-dir"], repoDir);
      initialized = gitDirResult.ok;
    } catch {
      initialized = false;
    }

    if (!initialized) {
      respond(true, { initialized, dirty: false, ghAuth, repoDir }, undefined);
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
        // Extract repo name from URL like git@github.com:org/repo.git or https://github.com/org/repo.git
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
      { initialized, remote, branch, repoName, dirty, lastCommit, lastTag, ghAuth, repoDir },
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
    const visibility = p.isPrivate === false ? "--public" : "--private";
    const fullName = `${p.org}/${p.repoName}`;

    try {
      // Create the directory
      await mkdir(repoDir, { recursive: true });

      // Create the GitHub repo
      const createResult = await gh(["repo", "create", fullName, visibility], repoDir);
      if (!createResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `gh repo create failed: ${createResult.stderr}`),
        );
        return;
      }

      // Initialize git
      const initResult = await git(["init"], repoDir);
      if (!initResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git init failed: ${initResult.stderr}`),
        );
        return;
      }

      // Add remote
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

      // Create README.md
      const readmeContent = `# ${p.repoName}\n\nCustom skills repository.\n`;
      await writeFile(path.join(repoDir, "README.md"), readmeContent, "utf-8");

      // Initial commit and push
      await git(["add", "."], repoDir);
      await git(["commit", "-m", "Initial commit"], repoDir);
      const pushResult = await git(["push", "-u", "origin", "HEAD"], repoDir);
      if (!pushResult.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, `git push failed: ${pushResult.stderr}`),
        );
        return;
      }

      // Auto-register repoDir in skills.load.extraDirs config
      const skills = cfg.skills ? { ...cfg.skills } : {};
      const load = skills.load ? { ...skills.load } : {};
      const extraDirs: string[] = Array.isArray(load.extraDirs) ? [...load.extraDirs] : [];
      if (!extraDirs.includes(repoDir)) {
        extraDirs.push(repoDir);
      }
      load.extraDirs = extraDirs;
      skills.load = load;
      const nextConfig: OpenClawConfig = { ...cfg, skills };
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

      // Check if there is anything to commit
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

      const pushResult = await git(["push"], repoDir);
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

    try {
      const pullResult = await git(["pull"], repoDir);
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

      const pushResult = await git(["push", "origin", p.tag], repoDir);
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
