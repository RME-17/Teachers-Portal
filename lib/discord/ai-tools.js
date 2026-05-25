const { log } = require('../../lib/log');
const { sanitizeArgs } = require('../../lib/log/sanitize');
const { chunkForDiscord, sanitizeForDiscord } = require('./sanitize');

// Discord AI toolset: read-only and gated write tools. This file exports
// a factory that accepts a discord client and returns tool definitions
// compatible with the Claude tools interface used by AiChatService.

const WRITE_ALLOWLIST = new Set([ /* numeric channel ids as strings, filled by config at runtime */ ]);
const DRAFT_HOLDING_CHANNELS = {
    modDrafts: 'mod-drafts', // human-readable name only; resolveChannel should map to actual id
    // index.js will set modDraftsId at startup after resolving channel names to ids
};

function resolveChannelFromInput(client, input) {
  if (!client || !input) {
    console.log('[discord-tool] resolveChannel: missing client or input', { hasClient: !!client, input });
    return null;
  }
  const raw = String(input).trim();
  if (!raw) return null;

  // Strip <#...> channel mention wrapper
  const mentionMatch = raw.match(/^<#(\d+)>$/);
  if (mentionMatch) {
    const c = client.channels.cache.get(mentionMatch[1]);
    console.log('[discord-tool] resolveChannel: mention match', mentionMatch[1], '->', c && c.name);
    if (c) return c;
  }

  // Raw numeric ID
  if (/^\d{17,20}$/.test(raw)) {
    const c = client.channels.cache.get(raw);
    console.log('[discord-tool] resolveChannel: id match', raw, '->', c && c.name);
    if (c) return c;
  }

  // Strip leading # for name lookup
  const name = raw.replace(/^#/, '').toLowerCase();

  // Search across all guilds and all text-ish channels
  for (const guild of client.guilds.cache.values()) {
    for (const ch of guild.channels.cache.values()) {
      if (!ch || !ch.name) continue;
      if (ch.name.toLowerCase() === name) {
        console.log('[discord-tool] resolveChannel: name match', name, '->', ch.name, ch.id);
        return ch;
      }
    }
  }

  // Fallback: partial match
  for (const guild of client.guilds.cache.values()) {
    for (const ch of guild.channels.cache.values()) {
      if (!ch || !ch.name) continue;
      if (ch.name.toLowerCase().includes(name)) {
        console.log('[discord-tool] resolveChannel: partial match', name, '->', ch.name, ch.id);
        return ch;
      }
    }
  }

  console.log('[discord-tool] resolveChannel: NO MATCH for', raw, 'searched guilds:', client.guilds.cache.size);
  return null;
}

function buildToolDefs(client, opts = {}) {
    const defs = [];

    // read tools
    defs.push({
        name: 'discord_list_channels',
        description: 'List text channels visible to the bot in the configured guild. INPUT: none or { guildId }',
        input_schema: { type: 'object', properties: { guildId: { type: 'string' } } },
    });

    defs.push({
        name: 'discord_read_channel',
        description: 'Read the most recent messages from a channel. INPUT: { channel: string (id or mention), limit: number (optional) }',
        input_schema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] },
    });

    defs.push({
        name: 'discord_search_messages',
        description: 'Search recent messages in a channel for matching text. INPUT: { channel: string, query: string, limit: number }',
        input_schema: { type: 'object', properties: { channel: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: ['channel','query'] },
    });

    defs.push({
        name: 'discord_get_user',
        description: 'Get basic user info by id. INPUT: { userId: string }',
        input_schema: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
    });

    // write tools (gated)
    defs.push({
        name: 'discord_send_message',
        description: 'Send a message to a channel. Draft-only if channel not allowlisted. INPUT: { channel: string, content: string }',
        input_schema: { type: 'object', properties: { channel: { type: 'string' }, content: { type: 'string' } }, required: ['channel','content'] },
    });

    defs.push({
        name: 'discord_send_dm',
        description: 'Send a DM to a user. DRAFT-ONLY: all DMs must be reviewed by a human first. INPUT: { userId: string (discord id) OR username: string (discord username or nickname), content: string }',
        input_schema: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Numeric Discord user ID. Provide this OR username.' },
                username: { type: 'string', description: 'Discord username, global name, or server nickname. Provide this OR userId.' },
                content: { type: 'string' }
            },
            required: ['content']
        },
    });

    defs.push({
        name: 'discord_react_to_message',
        description: 'React to a message with an emoji. INPUT: { channel: string, messageId: string, emoji: string }',
        input_schema: { type: 'object', properties: { channel: { type: 'string' }, messageId: { type: 'string' }, emoji: { type: 'string' } }, required: ['channel','messageId','emoji'] },
    });

    defs.push({
        name: 'discord_create_thread',
        description: 'Create a thread from a message or channel. INPUT: { channel: string, messageId?: string, name: string }',
        input_schema: { type: 'object', properties: { channel: { type: 'string' }, messageId: { type: 'string' }, name: { type: 'string' } }, required: ['channel','name'] },
    });

    return defs;
}

async function callTool(client, name, input = {}) {
    // If the discord client object is missing or not ready, return a
    // standardized not-ready error so callers can proceed without a
    // runtime registration race. The shape here matches the required
    // DISCORD_NOT_READY response used by the AI toolchain.
    try {
        const ready = client && client.user;
        if (!ready) {
            return { error: 'DISCORD_NOT_READY', message: 'Discord client is still initializing. Try again in a moment.' };
        }
    } catch (e) {
        return { error: 'DISCORD_NOT_READY', message: 'Discord client is still initializing. Try again in a moment.' };
    }
    // All operations must sanitize logs via sanitizeArgs before logging
    try {
        switch (name) {
            case 'discord_list_channels': {
                try {
                    const guildId = input.guildId || process.env.DISCORD_GUILD_ID;
                    const guild = client.guilds.cache.get(String(guildId));
                    if (!guild) return { ok: false, data: [{ type: 'text', text: 'guild not found or bot not in guild' }], isError: true, ms: 0 };
                    const channels = Array.from(guild.channels.cache.values())
                        .filter(c => c.type === 0 || c.type === 'GUILD_TEXT' || c.isTextBased && c.isTextBased())
                        .map(c => ({ id: c.id, name: c.name, nsfw: !!c.nsfw }));
                    // User-facing responses must not expose numeric ids — show names only
                    return { ok: true, data: channels.map(ch => ({ type: 'text', text: `#${ch.name}` })), isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_list_channels FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_list_channels error: ${err && err.message || String(err)}` }] };
                }
            }
            case 'discord_read_channel': {
                try {
                    const channel = resolveChannelFromInput(client, input.channel);
                    if (!channel) return { ok: false, data: [{ type: 'text', text: 'channel not found' }], isError: true, ms: 0 };
                    const limit = Math.min(200, Number(input.limit) || 50);
                    const msgs = await channel.messages.fetch({ limit });
                    const out = msgs.map(m => `${m.author.username}: ${m.content}`).reverse();
                    return { ok: true, data: out.map(t => ({ type: 'text', text: t })), isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_read_channel FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_read_channel error: ${err && err.message || String(err)}` }] };
                }
            }
            case 'discord_search_messages': {
                try {
                    // Support a single channel string or a comma/array list of channels
                    const rawChannelInput = input.channel;
                    if (!rawChannelInput) return { ok: false, data: [{ type: 'text', text: 'channel not found' }], isError: true, ms: 0 };
                    let channelInputs = [];
                    if (Array.isArray(rawChannelInput)) {
                        channelInputs = rawChannelInput;
                    } else if (typeof rawChannelInput === 'string') {
                        channelInputs = rawChannelInput.includes(',') ? rawChannelInput.split(',').map(s => s.trim()).filter(Boolean) : [rawChannelInput];
                    } else {
                        channelInputs = [String(rawChannelInput)];
                    }

                    const query = String(input.query || '').toLowerCase();
                    const rawLimit = Number(input.limit) || 100;
                    const perChannelLimit = Math.max(1, Math.min(100, rawLimit));
                    const MAX_TOTAL = 500; // hard cap across all channels
                    let totalScanned = 0;
                    const hits = [];
                    const searchedChannels = [];

                    for (const cInput of channelInputs) {
                        if (totalScanned >= MAX_TOTAL) break;
                        const ch = resolveChannelFromInput(client, cInput);
                        if (!ch) continue;
                        searchedChannels.push(ch.name || ch.id);
                        const remaining = Math.max(0, MAX_TOTAL - totalScanned);
                        const fetchLimit = Math.max(1, Math.min(perChannelLimit, remaining));
                        const msgs = await ch.messages.fetch({ limit: fetchLimit }).catch(() => null);
                        if (!msgs) continue;
                        totalScanned += msgs.size || 0;
                        const channelHits = msgs.filter(m => (m.content || '').toLowerCase().includes(query))
                            .map(m => `#${ch.name} ${m.author.username}: ${m.content}`).reverse();
                        hits.push(...channelHits);
                    }

                    console.log('[discord-tool] search query:', query, 'channels searched:', searchedChannels.join(','), 'matches found:', hits.length, 'messages_scanned:', totalScanned);
                    return { ok: true, data: hits.map(t => ({ type: 'text', text: t })), isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_search_messages FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_search_messages error: ${err && err.message || String(err)}` }] };
                }
            }
            case 'discord_get_user': {
                try {
                    let userId = input.userId;
                    const username = input.username && String(input.username).trim();
                    if (!userId && username) {
                        const lookup = username.toLowerCase().replace(/^@/, '').replace(/#\d+$/, '');
                        for (const guild of client.guilds.cache.values()) {
                            try { await guild.members.fetch().catch(() => {}); } catch (e) {}
                            const member = guild.members.cache.find(m =>
                                (m.user && m.user.username && m.user.username.toLowerCase() === lookup) ||
                                (m.user && m.user.globalName && m.user.globalName.toLowerCase() === lookup) ||
                                (m.nickname && m.nickname.toLowerCase() === lookup) ||
                                (m.displayName && m.displayName.toLowerCase() === lookup)
                            );
                            if (member) {
                                userId = member.id;
                                console.log('[discord-tool] resolveUser: username match', lookup, '->', member.user.username, member.id);
                                break;
                            }
                        }
                        if (!userId) {
                            console.log('[discord-tool] resolveUser: NO MATCH for', username);
                            return { ok: false, isError: true, data: [{ type: 'text', text: `Could not find Discord user "${username}". Provide their exact Discord username or numeric user ID.` }] };
                        }
                    }
                    if (!userId) return { ok: false, data: [{ type: 'text', text: 'userId required' }], isError: true, ms: 0 };
                    const user = await client.users.fetch(userId).catch(() => null);
                    if (!user) return { ok: false, data: [{ type: 'text', text: 'user not found' }], isError: true, ms: 0 };
                    // Do not expose numeric user ids in tool responses
                    return { ok: true, data: [{ type: 'text', text: `user: ${user.username}#${user.discriminator || '0000'}` }], isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_get_user FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_get_user error: ${err && err.message || String(err)}` }] };
                }
            }

            // Write operations: enforce allowlist and draft flow
            case 'discord_send_message': {
                try {
                    const channel = resolveChannelFromInput(client, input.channel);
                    if (!channel) return { ok: false, data: [{ type: 'text', text: 'channel not found' }], isError: true, ms: 0 };
                    const content = String(input.content || '').trim();
                    if (!content) return { ok: false, data: [{ type: 'text', text: 'content required' }], isError: true, ms: 0 };

                    // Server-side blueprint/topic gating: force drafts for sensitive topics
                    const BLUEPRINT_TOPICS = /\b(money|salary|bonus|payment|payslip|contract|reject(ion|ed)?|fire|terminat|legal|R\d+|\$\d+|invoice)\b/i;
                    const safeContent = sanitizeForDiscord(content);
                    if (BLUEPRINT_TOPICS.test(content)) {
                        // Force draft regardless of allowlist
                        const chunks = chunkForDiscord(safeContent);
                        const draftChannel = DRAFT_HOLDING_CHANNELS.modDraftsId ? client.channels.cache.get(DRAFT_HOLDING_CHANNELS.modDraftsId) : client.channels.cache.find(c => c.name === DRAFT_HOLDING_CHANNELS.modDrafts) || null;
                        if (draftChannel) {
                            await draftChannel.send(`BLUEPRINT-GATED DRAFT for #${channel.name}:\n` + chunks[0]);
                        }
                        console.log('[discord-tool] blueprint_topic_draft:', { channel: channel.name, matched: content.match(BLUEPRINT_TOPICS)?.[0] });
                        return { ok: true, data: [{ type: 'text', text: 'DRAFT_CREATED (blueprint topic gated)' }], isError: false, ms: 0 };
                    }

                    const chunks = chunkForDiscord(safeContent);
                    // If draft holding channel not configured, refuse gated writes
                    if (!DRAFT_HOLDING_CHANNELS.modDraftsId) {
                        log.error('discord', sanitizeArgs('gated_writes_disabled', { reason: 'draft_holding_channel_missing' }));
                        return { ok: false, data: [{ type: 'text', text: 'GATED_WRITES_DISABLED: draft holding channel not configured' }], isError: true, ms: 0 };
                    }

                    // If channel id not in WRITE_ALLOWLIST, create a draft in mod-drafts
                    if (!WRITE_ALLOWLIST.has(channel.id)) {
                        log.info('discord', sanitizeArgs('discord_send_message: drafted', { channel: channel.id }));
                        // create draft: use resolved draft channel id when available
                        const draftChannel = DRAFT_HOLDING_CHANNELS.modDraftsId ? client.channels.cache.get(DRAFT_HOLDING_CHANNELS.modDraftsId) : client.channels.cache.find(c => c.name === DRAFT_HOLDING_CHANNELS.modDrafts) || null;
                        if (draftChannel) {
                            // user-facing drafts must not expose numeric ids
                            await draftChannel.send(`DRAFT for #${channel.name}:\n` + chunks[0]);
                        }
                        return { ok: true, data: [{ type: 'text', text: 'DRAFT_CREATED' }], isError: false, ms: 0 };
                    }
                    // Send first chunk as the message, subsequent chunks as followups
                    const sent = await channel.send(chunks[0]);
                    for (let i = 1; i < chunks.length; i++) {
                        await channel.send(chunks[i]);
                    }
                    // Do not return numeric message ids in user-facing tool responses
                    return { ok: true, data: [{ type: 'text', text: `SENT` }], isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_send_message FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_send_message error: ${err && err.message || String(err)}` }] };
                }
            }

            case 'discord_send_dm': {
                try {
                    // Accept either userId or username
                    let userId = input.userId;
                    const username = input.username && String(input.username).trim();
                    const content = String(input.content || '').trim();

                    if (!userId && username) {
                        const lookup = username.toLowerCase().replace(/^@/, '').replace(/#\d+$/, '');
                        for (const guild of client.guilds.cache.values()) {
                            try { await guild.members.fetch().catch(() => {}); } catch (e) {}
                            const member = guild.members.cache.find(m =>
                                (m.user && m.user.username && m.user.username.toLowerCase() === lookup) ||
                                (m.user && m.user.globalName && m.user.globalName.toLowerCase() === lookup) ||
                                (m.nickname && m.nickname.toLowerCase() === lookup) ||
                                (m.displayName && m.displayName.toLowerCase() === lookup)
                            );
                            if (member) {
                                userId = member.id;
                                console.log('[discord-tool] resolveUser: username match', lookup, '->', member.user.username, member.id);
                                break;
                            }
                        }
                        if (!userId) {
                            console.log('[discord-tool] resolveUser: NO MATCH for', username);
                            return { ok: false, isError: true, data: [{ type: 'text', text: `Could not find Discord user "${username}". Provide their exact Discord username or numeric user ID.` }] };
                        }
                    }

                    if (!userId || !content) return { ok: false, data: [{ type: 'text', text: 'userId or username, and content, required' }], isError: true, ms: 0 };

                    // If draft holding channel not configured, refuse gated writes
                    if (!DRAFT_HOLDING_CHANNELS.modDraftsId) {
                        log.error('discord', sanitizeArgs('gated_writes_disabled', { reason: 'draft_holding_channel_missing' }));
                        return { ok: false, data: [{ type: 'text', text: 'GATED_WRITES_DISABLED: draft holding channel not configured' }], isError: true, ms: 0 };
                    }
                    const safeContent = sanitizeForDiscord(content);
                    const draftChannel = DRAFT_HOLDING_CHANNELS.modDraftsId ? client.channels.cache.get(DRAFT_HOLDING_CHANNELS.modDraftsId) : client.channels.cache.find(c => c.name === DRAFT_HOLDING_CHANNELS.modDrafts) || null;
                    if (draftChannel) {
                        // Try to fetch a username to avoid exposing numeric ids in the draft
                        const targetUser = await client.users.fetch(userId).catch(() => null);
                        const who = targetUser ? `${targetUser.username}#${targetUser.discriminator || '0000'}` : 'user';
                        await draftChannel.send(`DM DRAFT for ${who}:\n` + safeContent.slice(0, 1800));
                    }
                    return { ok: true, data: [{ type: 'text', text: 'DRAFT_CREATED' }], isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_send_dm FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_send_dm error: ${err && err.message || String(err)}` }] };
                }
            }

            case 'discord_react_to_message': {
                try {
                    const channel = resolveChannelFromInput(client, input.channel);
                    const messageId = input.messageId;
                    const emoji = input.emoji;
                    if (!channel || !messageId || !emoji) return { ok: false, data: [{ type: 'text', text: 'channel, messageId, and emoji required' }], isError: true, ms: 0 };
                    if (!DRAFT_HOLDING_CHANNELS.modDraftsId) {
                        log.error('discord', sanitizeArgs('gated_writes_disabled', { reason: 'draft_holding_channel_missing' }));
                        return { ok: false, data: [{ type: 'text', text: 'GATED_WRITES_DISABLED: draft holding channel not configured' }], isError: true, ms: 0 };
                    }
                    if (!WRITE_ALLOWLIST.has(channel.id)) {
                        // Draft the react request using resolved draft channel id when available
                        const draftChannel = DRAFT_HOLDING_CHANNELS.modDraftsId ? client.channels.cache.get(DRAFT_HOLDING_CHANNELS.modDraftsId) : client.channels.cache.find(c => c.name === DRAFT_HOLDING_CHANNELS.modDrafts) || null;
                        if (draftChannel) await draftChannel.send(`REACTION DRAFT ${emoji} for ${channel.name} message ${messageId}`);
                        return { ok: true, data: [{ type: 'text', text: 'DRAFT_CREATED' }], isError: false, ms: 0 };
                    }
                    const msg = await channel.messages.fetch(messageId).catch(() => null);
                    if (!msg) return { ok: false, data: [{ type: 'text', text: 'message not found' }], isError: true, ms: 0 };
                    await msg.react(emoji).catch(() => {});
                    return { ok: true, data: [{ type: 'text', text: 'REACTED' }], isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_react_to_message FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_react_to_message error: ${err && err.message || String(err)}` }] };
                }
            }

            case 'discord_create_thread': {
                try {
                    const channel = resolveChannelFromInput(client, input.channel);
                    const name = String(input.name || '').slice(0, 100);
                    if (!channel || !name) return { ok: false, data: [{ type: 'text', text: 'channel and name required' }], isError: true, ms: 0 };
                    if (!DRAFT_HOLDING_CHANNELS.modDraftsId) {
                        log.error('discord', sanitizeArgs('gated_writes_disabled', { reason: 'draft_holding_channel_missing' }));
                        return { ok: false, data: [{ type: 'text', text: 'GATED_WRITES_DISABLED: draft holding channel not configured' }], isError: true, ms: 0 };
                    }
                    if (!WRITE_ALLOWLIST.has(channel.id)) {
                        const draftChannel = DRAFT_HOLDING_CHANNELS.modDraftsId ? client.channels.cache.get(DRAFT_HOLDING_CHANNELS.modDraftsId) : client.channels.cache.find(c => c.name === DRAFT_HOLDING_CHANNELS.modDrafts) || null;
                        if (draftChannel) await draftChannel.send(`THREAD DRAFT ${name} for channel ${channel.name}`);
                        return { ok: true, data: [{ type: 'text', text: 'DRAFT_CREATED' }], isError: false, ms: 0 };
                    }
                    // If messageId provided, create from message
                    if (input.messageId) {
                        const m = await channel.messages.fetch(input.messageId).catch(() => null);
                        if (!m) return { ok: false, data: [{ type: 'text', text: 'message not found' }], isError: true, ms: 0 };
                        const thread = await m.startThread({ name }).catch(() => null);
                        if (!thread) return { ok: false, data: [{ type: 'text', text: 'thread creation failed' }], isError: true, ms: 0 };
                        // Do not return numeric ids in user-facing responses
                        return { ok: true, data: [{ type: 'text', text: `THREAD_CREATED` }], isError: false, ms: 0 };
                    }
                    const thread = await channel.threads.create({ name }).catch(() => null);
                    if (!thread) return { ok: false, data: [{ type: 'text', text: 'thread creation failed' }], isError: true, ms: 0 };
                    return { ok: true, data: [{ type: 'text', text: `THREAD_CREATED` }], isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_create_thread FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_create_thread error: ${err && err.message || String(err)}` }] };
                }
            }

            default:
                return { ok: false, data: [{ type: 'text', text: 'unknown tool' }], isError: true, ms: 0 };
        }
    } catch (e) {
        console.error('[discord-tool] callTool TOP-LEVEL FAILED:', e && e.stack || e && e.message || String(e));
        log.error('discord', sanitizeArgs('tool_error', { name, error: e instanceof Error ? e.message : String(e) }));
        return { ok: false, data: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true, ms: 0 };
    }
}

module.exports = { buildToolDefs, callTool, WRITE_ALLOWLIST, DRAFT_HOLDING_CHANNELS };
