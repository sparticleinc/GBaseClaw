# Skill Repo GitHub Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the "Browse Skills Store" (ClawHub) button with GitHub-based skill repository management — allowing each sandbox user to create a private GitHub repo, push/pull skills, and manage versions directly from the Skills UI page.

**Architecture:** Add a new gateway RPC method `skills.repo` that wraps `gh` CLI operations. Extend the Skills UI to replace the ClawHub link with a "Skill Repo" panel showing repo status, and buttons for init/push/pull/tag. The repo is stored per-sandbox in the workspace's `custom-skills/` directory and tracked via OpenClaw config (`skills.repo`).

**Tech Stack:** TypeScript (Lit for UI), `gh` CLI (via `child_process`), OpenClaw gateway RPC pattern, OpenClaw config system.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Skills UI Page (ui/src/ui/views/skills.ts)             │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Skill Repo Panel (replaces "Browse Skills Store") │  │
│  │  [Status] [Init Repo] [Push] [Pull] [Tag Release]  │  │
│  └────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Built-in Skills / Workspace Skills / ...           │  │
│  └────────────────────────────────────────────────────┘  │
└───────────────────┬─────────────────────────────────────┘
                    │ RPC
┌───────────────────▼─────────────────────────────────────┐
│  Gateway Server Methods                                 │
│  skills.repo.status  — git status + remote info         │
│  skills.repo.init    — gh repo create + git init        │
│  skills.repo.push    — git add/commit/push              │
│  skills.repo.pull    — git pull                         │
│  skills.repo.tag     — git tag + gh release create      │
└───────────────────┬─────────────────────────────────────┘
                    │ child_process
┌───────────────────▼─────────────────────────────────────┐
│  gh CLI + git CLI                                       │
└─────────────────────────────────────────────────────────┘
```

## File Map

| File                                                  | Action          | Purpose                              |
| ----------------------------------------------------- | --------------- | ------------------------------------ |
| `src/gateway/server-methods/skill-repo.ts`            | Create          | New RPC handlers for repo operations |
| `src/gateway/server-methods.ts`                       | Modify (L26,86) | Register `skillRepoHandlers`         |
| `src/gateway/protocol/schema/agents-models-skills.ts` | Modify (L209+)  | Add param/result schemas             |
| `src/gateway/protocol/schema/protocol-schemas.ts`     | Modify          | Export new schemas                   |
| `src/gateway/protocol/schema.ts`                      | Modify          | Add validators                       |
| `src/gateway/method-scopes.ts`                        | Modify          | Add method scopes                    |
| `ui/src/ui/views/skills.ts`                           | Modify (L51-58) | Replace ClawHub link with repo panel |
| `ui/src/ui/views/skill-repo-panel.ts`                 | Create          | New Lit component for repo panel     |
| `ui/src/ui/controllers/skill-repo.ts`                 | Create          | Frontend state + RPC calls for repo  |
| `ui/src/ui/types.ts`                                  | Modify (L608+)  | Add SkillRepoStatus type             |
| `ui/src/ui/app-render.ts`                             | Modify (L1235+) | Wire repo controller into skills tab |
| `src/config/types.skills.ts`                          | Modify          | Add `repo` config field              |

---

### Task 1: Add Gateway RPC — `skills.repo.status`

Returns the current git/GitHub status of the sandbox's skill repo directory.

**Files:**

- Create: `src/gateway/server-methods/skill-repo.ts`
- Modify: `src/gateway/protocol/schema/agents-models-skills.ts` (after line 209)
- Modify: `src/gateway/protocol/schema.ts` (add validator exports)
- Modify: `src/gateway/server-methods.ts` (line 26 + 86)
- Modify: `src/gateway/method-scopes.ts`

**Step 1: Add parameter & result schemas**

In `src/gateway/protocol/schema/agents-models-skills.ts`, after `SkillsUpdateParamsSchema` (line 209), add:

```typescript
export const SkillRepoStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillRepoStatusResultSchema = Type.Object(
  {
    initialized: Type.Boolean(),
    remote: Type.Optional(Type.String()),
    branch: Type.Optional(Type.String()),
    repoName: Type.Optional(Type.String()),
    dirty: Type.Boolean(),
    lastCommit: Type.Optional(Type.String()),
    lastTag: Type.Optional(Type.String()),
    ghAuth: Type.Boolean(),
    repoDir: Type.String(),
  },
  { additionalProperties: false },
);

export const SkillRepoInitParamsSchema = Type.Object(
  {
    org: NonEmptyString,
    repoName: NonEmptyString,
    isPrivate: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SkillRepoPushParamsSchema = Type.Object(
  {
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SkillRepoPullParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillRepoTagParamsSchema = Type.Object(
  {
    tag: NonEmptyString,
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
```

**Step 2: Export validators in schema.ts**

In `src/gateway/protocol/schema.ts`, add imports and `ajv.compile()` calls for each new schema, following the existing pattern for `validateSkillsStatusParams`, etc.

**Step 3: Create the handler file**

Create `src/gateway/server-methods/skill-repo.ts`:

```typescript
import path from "node:path";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
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

const GIT_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 60_000;

function resolveSkillRepoDir(): string {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return path.resolve(workspaceDir, "custom-skills");
}

async function runGit(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS) {
  return runCommandWithTimeout(["git", ...args], { cwd, timeoutMs });
}

async function runGh(args: string[], cwd: string, timeoutMs = GH_TIMEOUT_MS) {
  return runCommandWithTimeout(["gh", ...args], { cwd, timeoutMs });
}

async function getRepoStatus(repoDir: string) {
  const result: {
    initialized: boolean;
    remote?: string;
    branch?: string;
    repoName?: string;
    dirty: boolean;
    lastCommit?: string;
    lastTag?: string;
    ghAuth: boolean;
    repoDir: string;
  } = { initialized: false, dirty: false, ghAuth: false, repoDir };

  // Check gh auth
  const authRes = await runGh(["auth", "status"], repoDir);
  result.ghAuth = authRes.code === 0;

  // Check git init
  const gitCheck = await runGit(["rev-parse", "--git-dir"], repoDir);
  if (gitCheck.code !== 0) {
    return result;
  }
  result.initialized = true;

  // Branch
  const branchRes = await runGit(["branch", "--show-current"], repoDir);
  if (branchRes.code === 0) {
    result.branch = branchRes.stdout.trim() || undefined;
  }

  // Remote
  const remoteRes = await runGit(["remote", "get-url", "origin"], repoDir);
  if (remoteRes.code === 0) {
    result.remote = remoteRes.stdout.trim() || undefined;
    // Extract repo name from URL
    const match = result.remote?.match(/github\.com[/:](.+?)(?:\.git)?$/);
    if (match) {
      result.repoName = match[1];
    }
  }

  // Dirty check
  const statusRes = await runGit(["status", "--porcelain"], repoDir);
  result.dirty = statusRes.code === 0 && statusRes.stdout.trim().length > 0;

  // Last commit
  const logRes = await runGit(["log", "-1", "--format=%h %s"], repoDir);
  if (logRes.code === 0 && logRes.stdout.trim()) {
    result.lastCommit = logRes.stdout.trim();
  }

  // Last tag
  const tagRes = await runGit(["describe", "--tags", "--abbrev=0"], repoDir);
  if (tagRes.code === 0 && tagRes.stdout.trim()) {
    result.lastTag = tagRes.stdout.trim();
  }

  return result;
}

export const skillRepoHandlers: GatewayRequestHandlers = {
  "skills.repo.status": async ({ params, respond }) => {
    if (!validateSkillRepoStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateSkillRepoStatusParams.errors)}`,
        ),
      );
      return;
    }
    const repoDir = resolveSkillRepoDir();
    const status = await getRepoStatus(repoDir);
    respond(true, status, undefined);
  },

  "skills.repo.init": async ({ params, respond }) => {
    if (!validateSkillRepoInitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateSkillRepoInitParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { org: string; repoName: string; isPrivate?: boolean };
    const repoDir = resolveSkillRepoDir();

    // 1. Create directory
    const fs = await import("node:fs/promises");
    await fs.mkdir(repoDir, { recursive: true });

    // 2. Create GitHub repo
    const visibility = p.isPrivate !== false ? "--private" : "--public";
    const ghRes = await runGh(
      [
        "repo",
        "create",
        `${p.org}/${p.repoName}`,
        visibility,
        "--description",
        "OpenClaw custom skills",
      ],
      repoDir,
      GH_TIMEOUT_MS,
    );
    if (ghRes.code !== 0) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `gh repo create failed: ${ghRes.stderr.trim() || ghRes.stdout.trim()}`,
        ),
      );
      return;
    }

    // 3. git init + remote
    await runGit(["init"], repoDir);
    await runGit(
      ["remote", "add", "origin", `https://github.com/${p.org}/${p.repoName}.git`],
      repoDir,
    );

    // 4. Initial commit
    const readmePath = path.join(repoDir, "README.md");
    await fs.writeFile(readmePath, `# ${p.repoName}\n\nCustom skills for OpenClaw.\n`);
    await runGit(["add", "."], repoDir);
    await runGit(["commit", "-m", "Initial commit"], repoDir);
    await runGit(["branch", "-M", "main"], repoDir);
    await runGit(["push", "-u", "origin", "main"], repoDir);

    const status = await getRepoStatus(repoDir);
    respond(true, { ok: true, message: `Created ${p.org}/${p.repoName}`, ...status }, undefined);
  },

  "skills.repo.push": async ({ params, respond }) => {
    if (!validateSkillRepoPushParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateSkillRepoPushParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { message?: string };
    const repoDir = resolveSkillRepoDir();
    const msg = p.message?.trim() || `Update skills ${new Date().toISOString().slice(0, 10)}`;

    await runGit(["add", "."], repoDir);
    const commitRes = await runGit(["commit", "-m", msg], repoDir);
    if (commitRes.code !== 0 && !commitRes.stdout.includes("nothing to commit")) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, commitRes.stderr.trim()));
      return;
    }
    const pushRes = await runGit(["push"], repoDir);
    if (pushRes.code !== 0) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, pushRes.stderr.trim()));
      return;
    }
    respond(true, { ok: true, message: "Pushed to remote" }, undefined);
  },

  "skills.repo.pull": async ({ params, respond }) => {
    if (!validateSkillRepoPullParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateSkillRepoPullParams.errors)}`,
        ),
      );
      return;
    }
    const repoDir = resolveSkillRepoDir();
    const pullRes = await runGit(["pull"], repoDir);
    if (pullRes.code !== 0) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, pullRes.stderr.trim()));
      return;
    }
    respond(true, { ok: true, message: pullRes.stdout.trim() || "Up to date" }, undefined);
  },

  "skills.repo.tag": async ({ params, respond }) => {
    if (!validateSkillRepoTagParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid params: ${formatValidationErrors(validateSkillRepoTagParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { tag: string; message?: string };
    const repoDir = resolveSkillRepoDir();
    const msg = p.message?.trim() || `Release ${p.tag}`;

    const tagRes = await runGit(["tag", "-a", p.tag, "-m", msg], repoDir);
    if (tagRes.code !== 0) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, tagRes.stderr.trim()));
      return;
    }
    await runGit(["push", "origin", p.tag], repoDir);
    respond(true, { ok: true, message: `Tagged ${p.tag}` }, undefined);
  },
};
```

**Step 4: Register handlers in server-methods.ts**

In `src/gateway/server-methods.ts`:

```typescript
// Add import (around line 26)
import { skillRepoHandlers } from "./server-methods/skill-repo.js";

// Add to handler spread (around line 86)
...skillRepoHandlers,
```

**Step 5: Add method scopes in method-scopes.ts**

Follow the existing pattern to add `skills.repo.*` methods with appropriate scope (likely `"settings"` like other skills methods).

**Step 6: Commit**

```bash
scripts/committer "feat: add skills.repo.* gateway RPC methods for GitHub repo management" \
  src/gateway/server-methods/skill-repo.ts \
  src/gateway/server-methods.ts \
  src/gateway/protocol/schema/agents-models-skills.ts \
  src/gateway/protocol/schema.ts \
  src/gateway/method-scopes.ts
```

---

### Task 2: Add frontend controller for Skill Repo

**Files:**

- Create: `ui/src/ui/controllers/skill-repo.ts`
- Modify: `ui/src/ui/types.ts` (after line 608)

**Step 1: Add types**

In `ui/src/ui/types.ts`, after the `SkillStatusReport` type, add:

```typescript
export type SkillRepoStatus = {
  initialized: boolean;
  remote?: string;
  branch?: string;
  repoName?: string;
  dirty: boolean;
  lastCommit?: string;
  lastTag?: string;
  ghAuth: boolean;
  repoDir: string;
};
```

**Step 2: Create the controller**

Create `ui/src/ui/controllers/skill-repo.ts`:

```typescript
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SkillRepoStatus } from "../types.ts";

export type SkillRepoState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  repoLoading: boolean;
  repoStatus: SkillRepoStatus | null;
  repoError: string | null;
  repoBusy: string | null; // "init" | "push" | "pull" | "tag"
  repoMessage: { kind: "success" | "error"; message: string } | null;
};

function getErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export async function loadRepoStatus(state: SkillRepoState) {
  if (!state.client || !state.connected || state.repoLoading) return;
  state.repoLoading = true;
  state.repoError = null;
  try {
    const res = await state.client.request<SkillRepoStatus>("skills.repo.status", {});
    if (res) state.repoStatus = res;
  } catch (err) {
    state.repoError = getErrorMessage(err);
  } finally {
    state.repoLoading = false;
  }
}

export async function initRepo(
  state: SkillRepoState,
  org: string,
  repoName: string,
  isPrivate: boolean,
) {
  if (!state.client || !state.connected) return;
  state.repoBusy = "init";
  state.repoMessage = null;
  try {
    await state.client.request("skills.repo.init", { org, repoName, isPrivate });
    state.repoMessage = { kind: "success", message: `Created ${org}/${repoName}` };
    await loadRepoStatus(state);
  } catch (err) {
    state.repoMessage = { kind: "error", message: getErrorMessage(err) };
  } finally {
    state.repoBusy = null;
  }
}

export async function pushSkills(state: SkillRepoState, message?: string) {
  if (!state.client || !state.connected) return;
  state.repoBusy = "push";
  state.repoMessage = null;
  try {
    await state.client.request("skills.repo.push", { message });
    state.repoMessage = { kind: "success", message: "Pushed to GitHub" };
    await loadRepoStatus(state);
  } catch (err) {
    state.repoMessage = { kind: "error", message: getErrorMessage(err) };
  } finally {
    state.repoBusy = null;
  }
}

export async function pullSkills(state: SkillRepoState) {
  if (!state.client || !state.connected) return;
  state.repoBusy = "pull";
  state.repoMessage = null;
  try {
    await state.client.request("skills.repo.pull", {});
    state.repoMessage = { kind: "success", message: "Pulled from GitHub" };
    await loadRepoStatus(state);
  } catch (err) {
    state.repoMessage = { kind: "error", message: getErrorMessage(err) };
  } finally {
    state.repoBusy = null;
  }
}

export async function tagRelease(state: SkillRepoState, tag: string, message?: string) {
  if (!state.client || !state.connected) return;
  state.repoBusy = "tag";
  state.repoMessage = null;
  try {
    await state.client.request("skills.repo.tag", { tag, message });
    state.repoMessage = { kind: "success", message: `Tagged ${tag}` };
    await loadRepoStatus(state);
  } catch (err) {
    state.repoMessage = { kind: "error", message: getErrorMessage(err) };
  } finally {
    state.repoBusy = null;
  }
}
```

**Step 3: Commit**

```bash
scripts/committer "feat: add skill-repo frontend controller and types" \
  ui/src/ui/controllers/skill-repo.ts \
  ui/src/ui/types.ts
```

---

### Task 3: Build the Skill Repo UI panel

**Files:**

- Create: `ui/src/ui/views/skill-repo-panel.ts`

**Step 1: Create the panel component**

Create `ui/src/ui/views/skill-repo-panel.ts`:

```typescript
import { html, nothing } from "lit";
import type { SkillRepoStatus } from "../types.ts";

export type SkillRepoPanelProps = {
  connected: boolean;
  loading: boolean;
  status: SkillRepoStatus | null;
  busy: string | null;
  message: { kind: "success" | "error"; message: string } | null;
  onRefresh: () => void;
  onInit: (org: string, repoName: string, isPrivate: boolean) => void;
  onPush: (message?: string) => void;
  onPull: () => void;
  onTag: (tag: string, message?: string) => void;
};

function renderInitForm(props: SkillRepoPanelProps) {
  let orgValue = "";
  let repoValue = "";
  return html`
    <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
      <div class="muted">No skill repo configured. Create one:</div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <label class="field" style="flex: 1; min-width: 120px;">
          <input
            placeholder="GitHub org or user"
            @input=${(e: Event) => {
              orgValue = (e.target as HTMLInputElement).value;
            }}
          />
        </label>
        <label class="field" style="flex: 1; min-width: 120px;">
          <input
            placeholder="Repo name"
            @input=${(e: Event) => {
              repoValue = (e.target as HTMLInputElement).value;
            }}
          />
        </label>
        <button
          class="btn primary"
          ?disabled=${props.busy === "init"}
          @click=${() => props.onInit(orgValue, repoValue, true)}
        >
          ${props.busy === "init" ? "Creating..." : "Create Private Repo"}
        </button>
      </div>
    </div>
  `;
}

function renderRepoActions(props: SkillRepoPanelProps) {
  const s = props.status!;
  return html`
    <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
        <span class="chip chip-ok">${s.repoName ?? s.remote ?? "connected"}</span>
        ${s.branch ? html`<span class="chip">${s.branch}</span>` : nothing}
        ${s.lastTag ? html`<span class="chip">${s.lastTag}</span>` : nothing}
        ${s.dirty ? html`<span class="chip chip-warn">uncommitted changes</span>` : nothing}
      </div>
      ${s.lastCommit ? html`<div class="muted">Last commit: ${s.lastCommit}</div>` : nothing}
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="btn" ?disabled=${!!props.busy} @click=${() => props.onPush()}>
          ${props.busy === "push" ? "Pushing..." : "Push"}
        </button>
        <button class="btn" ?disabled=${!!props.busy} @click=${() => props.onPull()}>
          ${props.busy === "pull" ? "Pulling..." : "Pull"}
        </button>
        <button
          class="btn"
          ?disabled=${!!props.busy}
          @click=${() => {
            const tag = prompt("Version tag (e.g. v1.0.0):");
            if (tag) props.onTag(tag);
          }}
        >
          ${props.busy === "tag" ? "Tagging..." : "Tag Release"}
        </button>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>Refresh</button>
      </div>
    </div>
  `;
}

export function renderSkillRepoPanel(props: SkillRepoPanelProps) {
  const showInit = props.status && !props.status.initialized;
  const showActions = props.status?.initialized;
  const noGhAuth = props.status && !props.status.ghAuth;

  return html`
    <div style="margin-bottom: 4px;">
      <div style="font-weight: 600; font-size: 13px;">Skill Repository</div>
      ${noGhAuth
        ? html`<div class="callout danger" style="margin-top: 8px;">
            GitHub CLI not authenticated. Run <code>gh auth login</code> in terminal.
          </div>`
        : nothing}
      ${showInit && !noGhAuth ? renderInitForm(props) : nothing}
      ${showActions ? renderRepoActions(props) : nothing}
      ${!props.status && !props.loading
        ? html`<div class="muted" style="margin-top: 8px;">Not connected.</div>`
        : nothing}
      ${props.message
        ? html`<div
            style="margin-top: 8px; color: ${props.message.kind === "error"
              ? "var(--danger-color, #d14343)"
              : "var(--success-color, #0a7f5a)"};"
          >
            ${props.message.message}
          </div>`
        : nothing}
    </div>
  `;
}
```

**Step 2: Commit**

```bash
scripts/committer "feat: add skill-repo UI panel component" \
  ui/src/ui/views/skill-repo-panel.ts
```

---

### Task 4: Replace "Browse Skills Store" with Skill Repo Panel

**Files:**

- Modify: `ui/src/ui/views/skills.ts` (lines 12-27, 51-58)
- Modify: `ui/src/ui/app-render.ts` (around line 1235)

**Step 1: Update SkillsProps to include repo state**

In `ui/src/ui/views/skills.ts`, extend `SkillsProps` to add:

```typescript
import { renderSkillRepoPanel, type SkillRepoPanelProps } from "./skill-repo-panel.ts";

export type SkillsProps = {
  // ... existing props ...
  repo: SkillRepoPanelProps;
};
```

**Step 2: Replace the "Browse Skills Store" link**

In `ui/src/ui/views/skills.ts`, replace lines 51-58 (the `<a>` tag linking to clawhub.com) with:

```typescript
${renderSkillRepoPanel(props.repo)}
```

Keep the search input and "N shown" counter as-is.

**Step 3: Wire into app-render.ts**

In `ui/src/ui/app-render.ts`, where the skills tab renders (around line 1235), add the repo props. Import the controller functions and pass them through:

```typescript
m.renderSkills({
  // ... existing props ...
  repo: {
    connected: state.connected,
    loading: state.repoLoading,
    status: state.repoStatus,
    busy: state.repoBusy,
    message: state.repoMessage,
    onRefresh: () => loadRepoStatus(state),
    onInit: (org, name, priv) => initRepo(state, org, name, priv),
    onPush: (msg) => pushSkills(state, msg),
    onPull: () => pullSkills(state),
    onTag: (tag, msg) => tagRelease(state, tag, msg),
  },
});
```

**Step 4: Load repo status on tab switch**

Ensure `loadRepoStatus(state)` is called when the skills tab is opened, alongside the existing `loadSkills(state)` call.

**Step 5: Commit**

```bash
scripts/committer "feat: replace Browse Skills Store with Skill Repo panel" \
  ui/src/ui/views/skills.ts \
  ui/src/ui/app-render.ts
```

---

### Task 5: Add `custom-skills/` to `extraDirs` config automatically

When a skill repo is initialized, the `custom-skills/` directory should be automatically added to the skill loading path so skills in it are discovered.

**Files:**

- Modify: `src/gateway/server-methods/skill-repo.ts` (in the `init` handler)
- Modify: `src/config/types.skills.ts` (if needed, verify `extraDirs` field exists)

**Step 1: Auto-add extraDirs after repo init**

In the `skills.repo.init` handler, after the initial push succeeds, add:

```typescript
// Add custom-skills to extraDirs so skills are auto-loaded
const cfg = loadConfig();
const extraDirs = cfg.skills?.load?.extraDirs ?? [];
if (!extraDirs.includes(repoDir)) {
  const nextConfig = {
    ...cfg,
    skills: {
      ...cfg.skills,
      load: {
        ...cfg.skills?.load,
        extraDirs: [...extraDirs, repoDir],
      },
    },
  };
  await writeConfigFile(nextConfig);
}
```

**Step 2: Commit**

```bash
scripts/committer "feat: auto-register custom-skills dir in extraDirs on repo init" \
  src/gateway/server-methods/skill-repo.ts
```

---

### Task 6: Test the full flow

**Step 1: Build the project**

```bash
pnpm build
```

Expected: no TypeScript errors.

**Step 2: Run existing tests to verify no regressions**

```bash
pnpm test -- src/gateway/server.skills-status.test.ts -v
```

Expected: existing tests pass.

**Step 3: Manual end-to-end test**

1. Start the gateway: `pnpm dev`
2. Open the Skills page in the web UI
3. Verify "Browse Skills Store" is replaced with "Skill Repository" panel
4. Test "Create Private Repo" flow with a test org/name
5. Copy a SKILL.md into `custom-skills/` and test "Push"
6. Test "Pull" and "Tag Release"
7. Verify the skill appears in the skills list under "Extra Skills"

**Step 4: Commit any fixes**

```bash
scripts/committer "fix: address issues found in e2e testing"
```

---

### Task 7: Write unit tests

**Files:**

- Create: `src/gateway/server-methods/skill-repo.test.ts`

**Step 1: Write test for status handler**

```typescript
import { describe, it, expect, vi } from "vitest";
// Test that skills.repo.status returns correct shape
// Mock runCommandWithTimeout to simulate git/gh responses
```

Test cases:

- Returns `initialized: false` when no `.git` directory
- Returns `ghAuth: false` when `gh auth status` fails
- Returns correct branch, remote, dirty status
- Returns last commit and tag when available

**Step 2: Write test for init handler**

Test cases:

- Creates repo via `gh repo create`
- Initializes git and pushes initial commit
- Returns error when `gh` fails

**Step 3: Run tests**

```bash
pnpm test -- src/gateway/server-methods/skill-repo.test.ts -v
```

**Step 4: Commit**

```bash
scripts/committer "test: add unit tests for skill-repo gateway handlers" \
  src/gateway/server-methods/skill-repo.test.ts
```

---

## Summary of Changes

| Component     | What changes                                | Impact           |
| ------------- | ------------------------------------------- | ---------------- |
| Gateway RPC   | 5 new methods (`skills.repo.*`)             | Backend only     |
| UI View       | Replace ClawHub link with repo panel        | User-visible     |
| UI Controller | New `skill-repo.ts` controller              | Frontend logic   |
| Config        | Auto-add `extraDirs` on init                | Skill loading    |
| Skills        | New `skill-repo` SKILL.md (already created) | Agent capability |

## Customer Delivery Flow (end result)

```
Developer sandbox:                    Customer sandbox:
┌──────────────────┐                  ┌──────────────────┐
│ Skills UI        │                  │ Skills UI        │
│ [Push] [Tag]     │                  │ [Pull]           │
│                  │                  │                  │
│ custom-skills/   │ ──git push──►   │ vendor-skills/   │
│   skill-a/       │   GitHub repo   │   skill-a/       │
│   skill-b/       │ ◄──git pull──   │   skill-b/       │
└──────────────────┘                  └──────────────────┘
```
