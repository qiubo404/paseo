import { describe, expect, it } from "vitest";
import {
  buildAgentDeepLink,
  buildAgentDeepLinkRoute,
  parseAgentDeepLink,
  parseDraftDeepLink,
  buildDraftDeepLinkRoute,
} from "./agent-deep-link.js";

describe("agent deep links", () => {
  it("opens a text-only draft without accepting submission options", () => {
    const prompt = "[$hm-dev](/项目/skills/hm-dev/SKILL.md) fxsj\u00a0\n补充 & #";
    const query = new URLSearchParams({ path: "/项目/app hub", prompt });
    for (const scheme of ["paseo", "paseo-review"]) {
      expect(parseDraftDeepLink(`${scheme}://new?${query}`)).toEqual({
        path: "/项目/app hub",
        prompt,
      });
    }
    expect(parseDraftDeepLink(`paseo-review://new?${query}&send=true`)).toBeNull();
    expect(parseDraftDeepLink(`paseo-review://new?${query}&path=/other`)).toBeNull();
    expect(parseDraftDeepLink("paseo-review://new?path=relative&prompt=hello")).toBeNull();
    expect(parseDraftDeepLink("https://new?path=/project&prompt=hello")).toBeNull();
    expect(parseDraftDeepLink("paseo-review://new?path=/project&prompt=%20")).toBeNull();
    const route = new URL(
      buildDraftDeepLinkRoute({ path: "/项目/app hub", prompt, draftId: "draft-1" }),
      "https://app",
    );
    expect(route.pathname).toBe("/new");
    expect(Object.fromEntries(route.searchParams)).toEqual({
      dir: "/项目/app hub",
      prompt,
      draftId: "draft-1",
      local: "1",
    });
  });
  it("round-trips an existing agent target", () => {
    const target = { serverId: "server/main", agentId: "agent 123" };

    const link = buildAgentDeepLink(target);

    expect(link).toBe("paseo://h/server%2Fmain/agent/agent%20123");
    expect(buildAgentDeepLinkRoute(target)).toBe("/h/server%2Fmain/agent/agent%20123");
    expect(parseAgentDeepLink(link)).toEqual(target);
  });

  it("rejects links outside the exact agent route", () => {
    expect(parseAgentDeepLink("https://h/server/agent/agent-1")).toBeNull();
    expect(parseAgentDeepLink("paseo://app/h/server/agent/agent-1")).toBeNull();
    expect(parseAgentDeepLink("paseo://h/server/agent/agent-1?message=hello")).toBeNull();
    expect(parseAgentDeepLink("paseo://h/server/agent/agent-1/extra")).toBeNull();
  });
});
