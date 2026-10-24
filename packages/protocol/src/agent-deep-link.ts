export interface AgentDeepLinkTarget {
  serverId: string;
  agentId: string;
}

/** Desktop-only draft intake; opening this target never submits a message. */
export interface DraftDeepLinkTarget {
  path: string;
  prompt: string;
  draftId: string;
}

export type DesktopDeepLinkTarget = AgentDeepLinkTarget | DraftDeepLinkTarget;

export function parseDraftDeepLink(input: string): Omit<DraftDeepLinkTarget, "draftId"> | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const validScheme = url.protocol === "paseo:" || url.protocol === "paseo-review:";
  if (
    !validScheme ||
    url.hostname !== "new" ||
    url.pathname !== "" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !keys.includes("path") || !keys.includes("prompt")) return null;
  const path = url.searchParams.get("path") ?? "";
  const prompt = url.searchParams.get("prompt") ?? "";
  const absolutePath = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
  if (!absolutePath || path.includes("\0") || !prompt.trim()) return null;
  return { path, prompt };
}

export function buildDraftDeepLinkRoute(target: DraftDeepLinkTarget): string {
  const query = new URLSearchParams({
    dir: target.path,
    prompt: target.prompt,
    draftId: target.draftId,
    local: "1",
  });
  return `/new?${query.toString()}`;
}

function normalizeSegment(value: string): string {
  return value.trim();
}

function normalizeAgentDeepLinkTarget(target: AgentDeepLinkTarget): AgentDeepLinkTarget {
  const serverId = normalizeSegment(target.serverId);
  const agentId = normalizeSegment(target.agentId);
  if (!serverId || !agentId) {
    throw new Error("Agent deep links require a server ID and agent ID.");
  }
  return { serverId, agentId };
}

export function buildAgentDeepLinkRoute(
  target: AgentDeepLinkTarget,
): `/h/${string}/agent/${string}` {
  const { serverId, agentId } = normalizeAgentDeepLinkTarget(target);
  return `/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}

export function buildAgentDeepLink(target: AgentDeepLinkTarget): string {
  return `paseo:/${buildAgentDeepLinkRoute(target)}`;
}

export function parseAgentDeepLink(input: string): AgentDeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (
    url.protocol !== "paseo:" ||
    url.hostname !== "h" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 3 || segments[1] !== "agent") {
    return null;
  }

  try {
    const serverId = normalizeSegment(decodeURIComponent(segments[0] ?? ""));
    const agentId = normalizeSegment(decodeURIComponent(segments[2] ?? ""));
    return serverId && agentId ? { serverId, agentId } : null;
  } catch {
    return null;
  }
}
