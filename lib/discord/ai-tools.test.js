import { describe, expect, it, beforeEach } from "vitest";
import aiToolsImport from "./ai-tools.js";

const aiTools = aiToolsImport && aiToolsImport.default ? aiToolsImport.default : aiToolsImport;
const { callTool, _sendVerified, DRAFT_HOLDING_CHANNELS, WRITE_ALLOWLIST, _issueConfirmation, _broadcastDedupe, getLastBroadcast } = aiTools;

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

describe("discord_send_dm confirmation nonce gate", () => {
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

  it("drafts and asks for confirmation when no token is provided", async () => {
    const res = await callTool(client, "discord_send_dm", { userId: "u1", content: "hello there" });
    expect(res.data[0].text).toContain("CONFIRM_REQUIRED");
    expect(draftSends.length).toBe(1);
    expect(userSends.length).toBe(0);
  });

  it("refuses a guessed / invalid token (never self-confirms)", async () => {
    const res = await callTool(client, "discord_send_dm", { userId: "u1", content: "hello there", confirmationToken: "CONFIRM-FAKE99" });
    expect(res.data[0].text).toContain("CONFIRM_REQUIRED");
    expect(userSends.length).toBe(0);
  });

  it("delivers the DM and reports SENT_CONFIRMED with a valid token", async () => {
    const token = _issueConfirmation("discord_send_dm", "hello there");
    const res = await callTool(client, "discord_send_dm", { userId: "u1", content: "hello there", confirmationToken: token });
    expect(res.data[0].text).toContain("SENT_CONFIRMED");
    expect(userSends.length).toBe(1);
  });

  it("reports SEND_FAILED (never lies) when the DM cannot be delivered", async () => {
    targetUser.send = async () => { throw new Error("Cannot send messages to this user"); };
    const token = _issueConfirmation("discord_send_dm", "hello there");
    const res = await callTool(client, "discord_send_dm", { userId: "u1", content: "hello there", confirmationToken: token });
    expect(res.ok).toBe(false);
    expect(res.data[0].text).toContain("SEND_FAILED");
    expect(userSends.length).toBe(0);
  });
});

describe("discord_send_all broadcast (confirmation nonce + dedupe + receipt)", () => {
  let liveSends, draftMsgs, client;

  beforeEach(() => {
    liveSends = [];
    draftMsgs = [];
    const mk = (name, id, school) => ({
      id, name, type: 0, isTextBased: () => true, parent: { name: school },
      permissionsFor: () => ({ has: () => true }),
      send: async (c) => { liveSends.push({ id, content: c }); return { id: "m_" + id }; },
    });
    const c1 = mk("clock-in", "c1", "Talking Global");
    const c2 = mk("clock-in", "c2", "Speak English");
    const draftChannel = { id: "draft1", name: "bot-drafts", isTextBased: () => true, send: async (c) => { draftMsgs.push(c); return { id: "d" + Math.random() }; } };
    const guild = { channels: { cache: new Map([["c1", c1], ["c2", c2]]) }, members: { me: { id: "bot" } } };
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
    _broadcastDedupe.clear();
  });

  it("drafts every target plus a code message and waits when no token", async () => {
    const res = await callTool(client, "discord_send_all", { content: "Please clock in!" });
    expect(res.data[0].text).toContain("CONFIRM_REQUIRED");
    expect(liveSends.length).toBe(0);
    expect(draftMsgs.length).toBe(3);
  });

  it("broadcasts to allowlisted clock-in channels with a valid token and posts a receipt", async () => {
    const token = _issueConfirmation("discord_send_all", "Please clock in!");
    const res = await callTool(client, "discord_send_all", { content: "Please clock in!", confirmationToken: token });
    expect(res.ok).toBe(true);
    expect(res.data[0].text).toContain("sent 2");
    const sentIds = liveSends.map((s) => s.id).sort();
    expect(sentIds).toEqual(["c1", "c2"]);
    expect(draftMsgs.join(" ")).toContain("receipt");
  });

  it("dedupes a repeat broadcast of identical content (tweak 1)", async () => {
    const token1 = _issueConfirmation("discord_send_all", "Please clock in!");
    await callTool(client, "discord_send_all", { content: "Please clock in!", confirmationToken: token1 });
    expect(liveSends.length).toBe(2);
    const token2 = _issueConfirmation("discord_send_all", "Please clock in!");
    const res = await callTool(client, "discord_send_all", { content: "Please clock in!", confirmationToken: token2 });
    expect(res.ok).toBe(true);
    expect(liveSends.length).toBe(2);
    expect(res.data[0].text.toLowerCase()).toContain("skipped");
  });
});

describe("discord_edit_last_broadcast / discord_retract_last_broadcast (tweak 6)", () => {
  let liveSends, draftMsgs, edits, deletes, client;

  beforeEach(async () => {
    liveSends = [];
    draftMsgs = [];
    edits = [];
    deletes = [];
    const mk = (name, id, school) => {
      const ch = {
        id, name, type: 0, isTextBased: () => true, parent: { name: school },
        permissionsFor: () => ({ has: () => true }),
        send: async (c) => { liveSends.push({ id, content: c }); return { id: "m_" + id }; },
      };
      ch.messages = { fetch: async () => ({ id: "m_" + id, edit: async (c) => { edits.push({ id, content: c }); }, delete: async () => { deletes.push(id); } }) };
      return ch;
    };
    const c1 = mk("clock-in", "c1", "Talking Global");
    const c2 = mk("clock-in", "c2", "Speak English");
    const draftChannel = { id: "draft1", name: "bot-drafts", isTextBased: () => true, send: async (c) => { draftMsgs.push(c); return { id: "d" + Math.random() }; } };
    const guild = { channels: { cache: new Map([["c1", c1], ["c2", c2]]) }, members: { me: { id: "bot" } } };
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
    _broadcastDedupe.clear();
    const token = _issueConfirmation("discord_send_all", "Morning!");
    await callTool(client, "discord_send_all", { content: "Morning!", confirmationToken: token });
  });

  it("requires confirmation before editing, then edits every broadcast message", async () => {
    const res1 = await callTool(client, "discord_edit_last_broadcast", { content: "Updated!" });
    expect(res1.data[0].text).toContain("CONFIRM_REQUIRED");
    expect(edits.length).toBe(0);
    const token = _issueConfirmation("discord_edit_last_broadcast", "Updated!");
    const res2 = await callTool(client, "discord_edit_last_broadcast", { content: "Updated!", confirmationToken: token });
    expect(res2.ok).toBe(true);
    expect(edits.length).toBe(2);
    expect(edits.every((e) => e.content === "Updated!")).toBe(true);
  });

  it("requires confirmation before retracting, then deletes every broadcast message", async () => {
    const res1 = await callTool(client, "discord_retract_last_broadcast", {});
    expect(res1.data[0].text).toContain("CONFIRM_REQUIRED");
    expect(deletes.length).toBe(0);
    const stamp = "retract:" + getLastBroadcast().at;
    const token = _issueConfirmation("discord_retract_last_broadcast", stamp);
    const res2 = await callTool(client, "discord_retract_last_broadcast", { confirmationToken: token });
    expect(res2.ok).toBe(true);
    expect(deletes.sort()).toEqual(["c1", "c2"]);
    expect(getLastBroadcast()).toBe(null);
  });

  it("reports NOTHING_TO_EDIT once the broadcast has been retracted", async () => {
    const stamp = "retract:" + getLastBroadcast().at;
    const token = _issueConfirmation("discord_retract_last_broadcast", stamp);
    await callTool(client, "discord_retract_last_broadcast", { confirmationToken: token });
    const res = await callTool(client, "discord_edit_last_broadcast", { content: "x" });
    expect(res.data[0].text).toContain("NOTHING_TO_EDIT");
  });
});

describe("discord_send_message spoken-yes confirmation (voice-friendly)", () => {
  let liveSends, draftSends, client, target;

  beforeEach(() => {
    liveSends = [];
    draftSends = [];
    target = { id: "bd1", name: "bot-drafts", isTextBased: () => true, send: async (c) => { liveSends.push(c); return fakeMessage(); } };
    const draftChannel = { id: "draftX", name: "mod-drafts", isTextBased: () => true, send: async (c) => { draftSends.push(c); return fakeMessage(); } };
    const guild = { channels: { cache: new Map([["bd1", target], ["draftX", draftChannel]]) }, members: { me: { id: "bot" } } };
    client = {
      user: { id: "bot" },
      guilds: { cache: new Map([["g1", guild]]) },
      channels: { cache: new Map([["bd1", target], ["draftX", draftChannel]]) },
    };
    DRAFT_HOLDING_CHANNELS.modDraftsId = "draftX";
    WRITE_ALLOWLIST.clear(); // bot-drafts is deliberately NOT allowlisted
  });

  it("drafts (does not send) on the first call with no confirmation", async () => {
    const res = await callTool(client, "discord_send_message", { channel: "bot-drafts", content: "Hello team" });
    expect(res.data[0].text).toContain("CONFIRM_REQUIRED");
    expect(liveSends.length).toBe(0);
    expect(draftSends.length).toBe(1);
  });

  it("a spoken 'yes, send it' confirms the draft and the message actually lands in a non-allowlisted channel", async () => {
    const r1 = await callTool(client, "discord_send_message", { channel: "bot-drafts", content: "Hello team" });
    expect(r1.data[0].text).toContain("CONFIRM_REQUIRED");
    const r2 = await callTool(client, "discord_send_message", { channel: "bot-drafts", content: "Hello team", confirmationToken: "yes, send it" });
    expect(r2.ok).toBe(true);
    expect(r2.data[0].text).toContain("SENT_CONFIRMED");
    expect(liveSends.length).toBe(1);
    expect(String(liveSends[0])).toContain("Hello team");
  });

  it("an affirmative with no matching draft does NOT send (draft-first still enforced)", async () => {
    const res = await callTool(client, "discord_send_message", { channel: "bot-drafts", content: "Never drafted", confirmationToken: "yes send it" });
    expect(res.data[0].text).toContain("CONFIRM_REQUIRED");
    expect(liveSends.length).toBe(0);
  });

  it("a non-affirmative gibberish token does NOT send", async () => {
    await callTool(client, "discord_send_message", { channel: "bot-drafts", content: "Hello team" });
    const res = await callTool(client, "discord_send_message", { channel: "bot-drafts", content: "Hello team", confirmationToken: "banana" });
    expect(res.data[0].text).toContain("CONFIRM_REQUIRED");
    expect(liveSends.length).toBe(0);
  });
});
