import type { GatewayBrowserClient } from "../gateway.ts";
import type { SkillRepoStatus } from "../types.ts";

export type SkillRepoMessage = {
  kind: "success" | "error";
  message: string;
};

export type SkillRepoState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  repoLoading: boolean;
  repoStatus: SkillRepoStatus | null;
  repoError: string | null;
  repoBusy: "init" | "push" | "pull" | "tag" | null;
  repoMessage: SkillRepoMessage | null;
};

function getErrorMessage(err: unknown) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export async function loadRepoStatus(state: SkillRepoState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.repoLoading) {
    return;
  }
  state.repoLoading = true;
  state.repoError = null;
  try {
    const res = await state.client.request<SkillRepoStatus | undefined>("skills.repo.status", {});
    if (res) {
      state.repoStatus = res;
    }
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
  if (!state.client || !state.connected) {
    return;
  }
  state.repoBusy = "init";
  state.repoError = null;
  state.repoMessage = null;
  try {
    await state.client.request("skills.repo.init", { org, repoName, isPrivate });
    state.repoMessage = { kind: "success", message: "Repository initialized" };
    await loadRepoStatus(state);
  } catch (err) {
    const message = getErrorMessage(err);
    state.repoError = message;
    state.repoMessage = { kind: "error", message };
  } finally {
    state.repoBusy = null;
  }
}

export async function pushSkills(state: SkillRepoState, message?: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.repoBusy = "push";
  state.repoError = null;
  state.repoMessage = null;
  try {
    await state.client.request("skills.repo.push", { message });
    state.repoMessage = { kind: "success", message: "Skills pushed" };
    await loadRepoStatus(state);
  } catch (err) {
    const msg = getErrorMessage(err);
    state.repoError = msg;
    state.repoMessage = { kind: "error", message: msg };
  } finally {
    state.repoBusy = null;
  }
}

export async function pullSkills(state: SkillRepoState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.repoBusy = "pull";
  state.repoError = null;
  state.repoMessage = null;
  try {
    await state.client.request("skills.repo.pull", {});
    state.repoMessage = { kind: "success", message: "Skills pulled" };
    await loadRepoStatus(state);
  } catch (err) {
    const message = getErrorMessage(err);
    state.repoError = message;
    state.repoMessage = { kind: "error", message };
  } finally {
    state.repoBusy = null;
  }
}

export async function tagRelease(state: SkillRepoState, tag: string, message?: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.repoBusy = "tag";
  state.repoError = null;
  state.repoMessage = null;
  try {
    await state.client.request("skills.repo.tag", { tag, message });
    state.repoMessage = { kind: "success", message: `Tagged ${tag}` };
    await loadRepoStatus(state);
  } catch (err) {
    const msg = getErrorMessage(err);
    state.repoError = msg;
    state.repoMessage = { kind: "error", message: msg };
  } finally {
    state.repoBusy = null;
  }
}
