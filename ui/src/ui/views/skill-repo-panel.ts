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
  onSaveToken: (token: string) => void;
};

export function renderSkillRepoPanel(props: SkillRepoPanelProps) {
  const { status, loading, busy, message } = props;

  return html`
    <section class="card">
      <div class="card-title">Skill Repo</div>
      <div class="card-sub">Manage your custom skills Git repository.</div>

      ${renderMessage(message)}
      ${renderBody(props, status, loading, busy)}
    </section>
  `;
}

function renderMessage(message: SkillRepoPanelProps["message"]) {
  if (!message) {
    return nothing;
  }
  const color =
    message.kind === "error" ? "var(--danger-color, #d14343)" : "var(--success-color, #0a7f5a)";
  return html`<div class="muted" style="margin-top: 8px; color: ${color};">${message.message}</div>`;
}

function renderBody(
  props: SkillRepoPanelProps,
  status: SkillRepoStatus | null,
  loading: boolean,
  busy: string | null,
) {
  // Not connected
  if (!status && !loading) {
    return html`
      <div class="muted" style="margin-top: 12px">Not connected.</div>
    `;
  }

  if (!status) {
    return nothing;
  }

  // No gh auth — show token input
  if (!status.ghAuth) {
    return renderTokenForm(props, busy);
  }

  // Not initialized
  if (!status.initialized) {
    return renderInitForm(props, busy);
  }

  // Initialized
  return renderInitialized(props, status, busy);
}

function readInputValue(button: HTMLElement, name: string): string {
  const container = button.closest("section") ?? button.parentElement;
  if (!container) {
    return "";
  }
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  return input?.value?.trim() ?? "";
}

function renderTokenForm(props: SkillRepoPanelProps, busy: string | null) {
  return html`
    <div style="margin-top: 12px;">
      <div class="muted" style="margin-bottom: 8px;">
        Enter your GitHub Personal Access Token to connect.
        Create one at
        <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">github.com/settings/tokens</a>
        with <code>repo</code> scope.
      </div>
      <label class="field">
        <span>GitHub Token</span>
        <input
          type="password"
          name="repo-token"
          placeholder="ghp_..."
          autocomplete="off"
        />
      </label>
      <button
        class="btn primary"
        style="margin-top: 8px;"
        ?disabled=${busy === "auth"}
        @click=${(e: Event) => {
          const token = readInputValue(e.currentTarget as HTMLElement, "repo-token");
          if (token) {
            props.onSaveToken(token);
          }
        }}
      >
        ${busy === "auth" ? "Saving…" : "Save Token"}
      </button>
    </div>
  `;
}

function renderInitForm(props: SkillRepoPanelProps, busy: string | null) {
  return html`
    <div style="margin-top: 12px;">
      <label class="field">
        <span>GitHub org/user</span>
        <input
          type="text"
          name="repo-org"
          placeholder="my-org"
          autocomplete="off"
        />
      </label>
      <label class="field" style="margin-top: 8px;">
        <span>Repo name</span>
        <input
          type="text"
          name="repo-name"
          placeholder="my-skills"
          autocomplete="off"
        />
      </label>
      <button
        class="btn primary"
        style="margin-top: 12px;"
        ?disabled=${busy === "init"}
        @click=${(e: Event) => {
          const org = readInputValue(e.currentTarget as HTMLElement, "repo-org");
          const repoName = readInputValue(e.currentTarget as HTMLElement, "repo-name");
          if (org && repoName) {
            props.onInit(org, repoName, true);
          }
        }}
      >
        ${busy === "init" ? "Creating…" : "Create Private Repo"}
      </button>
    </div>
  `;
}

function renderInitialized(
  props: SkillRepoPanelProps,
  status: SkillRepoStatus,
  busy: string | null,
) {
  const isBusy = !!busy;

  return html`
    <div style="margin-top: 12px;">
      <!-- Chips row -->
      <div class="chip-row">
        ${status.repoName ? html`<span class="chip-ok">${status.repoName}</span>` : nothing}
        ${status.branch ? html`<span class="chip">${status.branch}</span>` : nothing}
        ${status.lastTag ? html`<span class="chip">${status.lastTag}</span>` : nothing}
        ${
          status.dirty
            ? html`
                <span class="chip-warn">uncommitted changes</span>
              `
            : nothing
        }
      </div>

      <!-- Last commit -->
      ${
        status.lastCommit
          ? html`<div class="muted" style="margin-top: 8px;">Last commit: ${status.lastCommit}</div>`
          : nothing
      }

      <!-- Action buttons -->
      <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${isBusy}
          @click=${() => props.onPush()}
        >
          ${busy === "push" ? "Pushing…" : "Push"}
        </button>
        <button
          class="btn"
          ?disabled=${isBusy}
          @click=${() => props.onPull()}
        >
          ${busy === "pull" ? "Pulling…" : "Pull"}
        </button>
        <button
          class="btn"
          ?disabled=${isBusy}
          @click=${() => {
            const tag = prompt("Enter version tag (e.g. v1.0.0):");
            if (tag) {
              props.onTag(tag);
            }
          }}
        >
          ${busy === "tag" ? "Tagging…" : "Tag Release"}
        </button>
        <button
          class="btn"
          ?disabled=${isBusy}
          @click=${props.onRefresh}
        >
          ${busy === "refresh" ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </div>
  `;
}
