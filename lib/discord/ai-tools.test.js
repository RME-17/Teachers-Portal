import { describe, expect, it, beforeEach } from "vitest";
import aiToolsImport from "./ai-tools.js";

const aiTools = aiToolsImport && aiToolsImport.default ? aiToolsImport.default : aiToolsImport;
const { callTool, _sendVerified, DRAFT_HOLDING_CHANNELS, WRITE_ALLOWLIST } = aiTools;

function fakeMessage() {
  return { id: "m_" + Math.random().toString(36).slice(2) };
}

describe("_sendVerified (retry + delivery verification)", () => {
  it("returns the message when Discord acknowledges with an id", async () => {
    const calls = [];
    const target = { send: async (c) => { calls.push(c); return fakeMessage(); } };
    const m = await _sendVerified(target, "hello");
    expect(m && m.id).toBeTruthy();
    expect(calls).toEqual(["hello"]);
  });

  it("retries and then succeeds after a transient failure", async () => {
    let n = 0;
    const target = { send: async () => { n++; if (n < 2) throw new Error("boom"); return fakeMessage(); } };
    const m = await _sendVerified(target, "hi", 3);
    expect(m && m.id).toBeTruthy();
    expect(n).toBe(2);
  });

  it("throws when Discord never returns a message id", async () => {
    const target = { send: async () => ({}) };
    await expect(_sendVerified(target, "hi", 2)).rejects.toThrow();
  });

  it("throws when every send attempt fails", async () => {
    const target = { send: async () => { throw new Error("nope"); } };
    await expect(_sendVerified(target, "hi", 2)).rejects.toThrow();
  });
});

describe("discord_send_dm confirm gate", () => {
  let draftSends, userSends, client, targetUser;

  beforeEach(() => {
    draftSends = [];
    userSends = [];
    const draftChannel = { id: "draft1", name: "bot-drafts", send: async (c) => { draftSends.push(c); return fakeMessage(); } };
    targetUser = { id: "u1", username: "teacher", discriminator: "0001", send: async (c) => { userSends.push(c); return fakeMessage(); } };
    client = {
      user: { id: "bot" },
      channels: { cache: new Map([["draft1", draftChannel]]) },
      users: { fetch: async () => targetUser },
      guilds: { cache: new Map() },
    };
    DRAFT_HOLDING_CHANNELS.modDraftsId = "draft1";
  });

  it("drafts and asks for confirmation when confirmed is not set", async () => {
    const res = await callTool(client, "discord_send_dm", { userId: "u1", content: "hello there" });
    expect(res.data[0].text).toContain("CONFIRM_REQUIRED");
    expect(draftSends.length).toBe(1);
    expect(userSends.length).toBe(0);
  });

  it("delivers the DM and reports SENT_CONFIRMED when confirmed is true", async () => {
    const res = await callTool(client, "discord_send_dm", { userId: "u1", content: "hello there", confirmed: true });
    expect(res.data[0].text).toContain("SENT_CONFIRMED");
    expect(userSends.length).toBe(1);
  });

  it("reports SEND_FAILED (never lies) when the DM cannot be delivered", async () => {
    targetUser.send = async () => { throw new Error("Cannot send messages to this user"); };
    const res = await callTool(client, "discord_send_dm", { userId: "u1", content: "hello there", confirmed: true });
    expect(res.ok).toBe(false);
    expect(res.data[0].text).toContain("SEND_FAILED");
    expect(userSends.length).toBe(0);
  });
});


describe("discord_send_all broadcast (rate-limit spacing + delivery receipt)", () => {
  let liveSends, draftMsgs, client;

  beforeEach(() => {
    liveSends = [];
    draftMsgs = [];
    const mk = (name, id, school) => ({
      id, name, type: 0, isTextBased: () => true, parent: { name: school },
      send: async (c) => { liveSends.push({ id, content: c }); return { id: "m_" + id }; },
    });
    const c1 = mk("clock-in", "c1", "Talking Global");
    const c2 = mk("clock-in", "c2", "Speak English");
    const draftChannel = { id: "draft1", name: "bot-drafts", isTextBased: () => true, send: async (c) => { draftMsgs.push(c); return { id: "d" + Math.random() }; } };
    const guild = { channels: { cache: new Map([["c1", c1], ["c2", c2]]) } };
    client = {
      user: { id: "bot" },
      guilds: { cache: new Map([["g1", guild]]) },
      channels: { cache: new Map([["draft1", draftChannel], ["c1", c1], ["c2", c2]]) },
    };
    process.env.DISCORD_GUILD_ID = "g1";
    DRAFT_HOLDING_CHANNELS.modDraftsId = "draft1";
    WRITE_ALLOWLIST.clear();
    WRITE_ALLOWLIST.add("c1");
    WRITE_ALLOWLIST.add("c2");
  });

  it("drafts every target and waits for confirmation when confirmed is not set", async () => {
    const res = await callTool(client, "discord_send_all", { content: "Please clock in!" });
    expect(res.data[0].text).toContain("CONFIRM_REQUIRED");
    expect(liveSends.length).toBe(0);
    expect(draftMsgs.length).toBe(2);
  });

  it("broadcasts to allowlisted clock-in channels and posts a delivery receipt", async () => {
    const res = await callTool(client, "discord_send_all", { content: "Please clock in!", confirmed: true });
    expect(res.ok).toBe(true);
    expect(res.data[0].text).toContain("sent 2");
    const sentIds = liveSends.map((s) => s.id).sort();
    expect(sentIds).toEqual(["c1", "c2"]);
    expect(draftMsgs.join("\n")).toContain("receipt");
  });
});
