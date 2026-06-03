const { log } = require('../../lib/log');
const { sanitizeArgs } = require('../../lib/log/sanitize');
const { chunkForDiscord, sanitizeForDiscord } = require('./sanitize');

// ---- Session message tracking (auto-resolve deictic references) ----
let _lastSentMessage = null;          // { id, channelId, channelName, snippet }
const _recentSeenMessages = [];       // [{ id, channelId, channelName, author, snippet, timestamp }]
const MAX_RECENT = 50;

function _trackSent(msg, channel) {
  if (!msg || !msg.id) return;
  _lastSentMessage = {
    id: msg.id,
    channelId: channel.id,
    channelName: channel.name || channel.id,
    snippet: (msg.content || '').slice(0, 100),
    timestamp: Date.now(),
  };
}

function _trackSeen(msgs, ch) {
  if (!msgs || !msgs.size) return;
  for (const m of msgs.values()) {
    if (!m.id) continue;
    // De-duplicate
    if (_recentSeenMessages.some(e => e.id === m.id)) continue;
    _recentSeenMessages.push({
      id: m.id,
      channelId: ch.id,
      channelName: ch.name || ch.id,
      author: m.author ? m.author.username : 'unknown',
      snippet: (m.content || '').slice(0, 100),
      timestamp: m.createdTimestamp || Date.now(),
    });
  }
  // Trim to max
  while (_recentSeenMessages.length > MAX_RECENT) _recentSeenMessages.shift();
}

function getLastSentMessage() { return _lastSentMessage; }
function getRecentSeenMessages() { return _recentSeenMessages.slice(); }

function levenshtein(a, b) {
  const an = a.length, bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;
  let prev = new Uint16Array(bn + 1);
  let curr = new Uint16Array(bn + 1);
  for (let j = 0; j <= bn; j++) prev[j] = j;
  for (let i = 1; i <= an; i++) {
    curr[0] = i;
    for (let j = 1; j <= bn; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bn];
}

// Discord AI toolset: read-only and gated write tools. This file exports
// a factory that accepts a discord client and returns tool definitions
// compatible with the Claude tools interface used by AiChatService.

const WRITE_ALLOWLIST = new Set([ /* numeric channel ids as strings, filled by config at runtime */ ]);
const DRAFT_HOLDING_CHANNELS = {
    modDrafts: 'bot-drafts', // human-readable name only; resolveChannel should map to actual id
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
  const name = raw.replace(/^#/, '').toLowerCase().trim();

  // Collect all text-ish channels
  const allChannels = [];
  for (const guild of client.guilds.cache.values()) {
    for (const ch of guild.channels.cache.values()) {
      if (!ch || !ch.name) continue;
      allChannels.push(ch);
    }
  }

  // 1) Exact normalized match
  for (const ch of allChannels) {
    if (ch.name.toLowerCase() === name) {
      console.log('[discord-tool] resolveChannel: exact match', name, '->', ch.name, ch.id);
      return ch;
    }
  }

  // 2) Substring match (e.g. "scratch" -> "admin-scratchpad")
  let bestSub = null;
  for (const ch of allChannels) {
    if (ch.name.toLowerCase().includes(name)) {
      if (!bestSub || ch.name.length < bestSub.name.length) bestSub = ch;
    }
  }
  if (bestSub) {
    console.log('[discord-tool] resolveChannel: substring match', name, '->', bestSub.name, bestSub.id);
    return bestSub;
  }

  // 3) Word-based match: split input into words, find channel where most words appear
  const inputWords = name.split(/[\s\-_]+/).filter(w => w.length > 1);
  if (inputWords.length > 0) {
    let bestWordMatch = null;
    let bestWordScore = 0;
    for (const ch of allChannels) {
      const chLower = ch.name.toLowerCase();
      let score = 0;
      for (const w of inputWords) {
        if (chLower.includes(w)) score++;
      }
      if (score > 0 && score / inputWords.length >= 0.5 && score > bestWordScore) {
        bestWordScore = score;
        bestWordMatch = ch;
      }
    }
    if (bestWordMatch) {
      console.log('[discord-tool] resolveChannel: word match', name, '->', bestWordMatch.name, bestWordMatch.id, 'score=', bestWordScore, '/', inputWords.length);
      return bestWordMatch;
    }
  }

  // 4) Levenshtein fuzzy match for close misspellings (within 3 edits)
  let bestFuzzy = null;
  let bestDist = 99;
  for (const ch of allChannels) {
    const dist = levenshtein(name, ch.name.toLowerCase());
    if (dist <= 3 && dist < bestDist) {
      bestDist = dist;
      bestFuzzy = ch;
    }
  }
  if (bestFuzzy) {
    console.log('[discord-tool] resolveChannel: fuzzy match', name, '->', bestFuzzy.name, bestFuzzy.id, 'dist=', bestDist);
    return bestFuzzy;
  }

  console.log('[discord-tool] resolveChannel: NO MATCH for', raw, 'searched guilds:', client.guilds.cache.size);
  return null;
}

// Send one Discord message (to a channel or a user) with retry + delivery verification.
// Resolves with the sent message (guaranteed to carry an id) or throws after all attempts fail.
async function _sendVerified(target, content, attempts = 3) {
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const m = await target.send(content);
            if (m && m.id) return m;
            lastErr = new Error('Discord did not acknowledge the message (no message id returned)');
        } catch (e) {
            lastErr = e;
        }
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    throw lastErr || new Error('Discord send failed after retries');
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
        description: 'Search recent messages for matching text across one, several, or ALL channels at once. Omit channel (or set it to "all" / "*" / "everywhere") to search EVERY readable text channel in the server simultaneously. You may also pass a single channel id/name, a comma-separated list, or an array of channels. Leave query empty to just pull the most recent messages from the channels. INPUT: { channel?: string | string[] (optional; default = ALL channels), query?: string (optional), limit?: number per channel (default 100) }',
        input_schema: { type: 'object', properties: { channel: { description: 'Optional. Channel id/name, comma-separated list, or array. Omit (or use "all" / "*" / "everywhere") to search ALL channels.' }, query: { type: 'string' }, limit: { type: 'number' } }, required: [] },
    });

    defs.push({
        name: 'discord_get_user',
        description: 'Get basic user info by id. INPUT: { userId: string }',
        input_schema: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
    });

    // write tools (gated)
    defs.push({
        name: 'discord_send_message',
        description: 'Send a message to a channel. SAFETY: every send is drafted to #bot-drafts first and returns CONFIRM_REQUIRED; the human must explicitly confirm, then call again with confirmed=true to actually send. Draft-only if channel not allowlisted. INPUT: { channel: string, content: string, confirmed?: boolean }',
        input_schema: { type: 'object', properties: { channel: { type: 'string' }, content: { type: 'string' }, confirmed: { type: 'boolean', description: 'Must be true to actually send. First call without it drafts to #bot-drafts and waits for the user to confirm.' } }, required: ['channel','content'] },
    });

    defs.push({
        name: 'discord_send_dm',
        description: 'Send a DM to a user. SAFETY: the first call drafts the DM to #bot-drafts and returns CONFIRM_REQUIRED; the human must explicitly confirm, then call again with confirmed=true to actually deliver the DM. INPUT: { userId: string (discord id) OR username: string (discord username or nickname), content: string, confirmed?: boolean }',
        input_schema: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Numeric Discord user ID. Provide this OR username.' },
                username: { type: 'string', description: 'Discord username, global name, or server nickname. Provide this OR userId.' },
                content: { type: 'string' },
                confirmed: { type: 'boolean', description: 'Must be true to actually deliver the DM. First call without it drafts to #bot-drafts and waits for the user to confirm.' }
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

    defs.push({
        name: 'discord_delete_message',
        description: 'Delete a message. DESTRUCTIVE — requires confirmation. Only allowed in write-allowlisted channels. INPUT: { channel: string, messageId: string, confirmed: boolean }',
        input_schema: { type: 'object', properties: { channel: { type: 'string' }, messageId: { type: 'string' }, confirmed: { type: 'boolean', description: 'Must be true to execute; user must explicitly confirm first' } }, required: ['channel','messageId','confirmed'] },
    });

    defs.push({
        name: 'discord_react_unchecked',
        description: 'Sweep EVERY channel whose name matches a pattern (default ALL "clock-in" channels) and add a reaction emoji (default checkmark \u2705) to each message that does NOT already have that reaction. Use this whenever asked to react to messages without a checkmark across the clock-in channels \u2014 it covers ALL matching channels, not just one. INPUT: { namePattern?: string (default "clock-in"), emoji?: string (default \u2705), limit?: number per channel (default 100) }',
        input_schema: { type: 'object', properties: { namePattern: { type: 'string' }, emoji: { type: 'string' }, limit: { type: 'number' } } },
    });

    defs.push({
        name: 'discord_send_all',
        description: 'Broadcast a message to EVERY channel whose name matches a pattern (default ALL "clock-in" channels). Each clock-in channel sits under its own school category, so this posts to all schools at once and reports back per school using the parent category name. Use this whenever asked to post the same message across the clock-in channels (for example a daily good-morning or good-afternoon) instead of discord_send_message, which only hits ONE channel. SAFETY: first call drafts to #bot-drafts and returns CONFIRM_REQUIRED; the human confirms, then call again with confirmed=true to broadcast. INPUT: { content: string, namePattern?: string (default "clock-in"), category?: string (optional: only send to channels whose parent category name contains this, e.g. a single school) }',
        input_schema: { type: 'object', properties: { content: { type: 'string' }, namePattern: { type: 'string' }, category: { type: 'string' }, confirmed: { type: 'boolean', description: 'Must be true to actually broadcast. First call without it drafts to #bot-drafts and waits for the user to confirm.' } }, required: ['content'] },
    });

    return defs;
}

async function callTool(client, name, input = {}, triggerContext = 'unknown', turnId) {
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
                    if (!guild) {
                        void (async () => {
                            try {
                                const { logDiscordEvent } = require('./log');
                                await logDiscordEvent({
                                    toolName: 'discord_list_channels',
                                    direction: 'list',
                                    status: 'failed',
                                    errorMessage: 'guild not found or bot not in guild',
                                    triggeredBy: triggerContext || 'unknown',
                                    turnId: turnId,
                                    rawInput: input,
                                    rawOutput: null
                                });
                            } catch (e) {}
                        })();
                        return { ok: false, data: [{ type: 'text', text: 'guild not found or bot not in guild' }], isError: true, ms: 0 };
                    }
                    const channels = Array.from(guild.channels.cache.values())
                        .filter(c => c.type === 0 || c.type === 'GUILD_TEXT' || c.isTextBased && c.isTextBased())
                        .map(c => ({ id: c.id, name: c.name, nsfw: !!c.nsfw }));
                    // User-facing responses must not expose numeric ids — show names only
                    const result = { ok: true, data: channels.map(ch => ({ type: 'text', text: `#${ch.name}` })), isError: false, ms: 0 };
                    void (async () => {
                        try {
                            const { logDiscordEvent } = require('./log');
                            await logDiscordEvent({
                                toolName: 'discord_list_channels',
                                direction: 'list',
                                status: 'read',
                                resultCount: channels.length,
                                triggeredBy: triggerContext || 'unknown',
                                turnId: turnId,
                                rawInput: input,
                                rawOutput: { ok: true, text: `returned ${channels.length} channels` }
                            });
                        } catch (e) {}
                    })();
                    return result;
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
                    _trackSeen(msgs, channel);
                    const out = msgs.map(m => {
                        const ts = m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdTimestamp || '');
                        const reacts = Array.from((m.reactions && m.reactions.cache && m.reactions.cache.values()) || [])
                            .map(r => `${(r.emoji && r.emoji.name) || (r.emoji && r.emoji.toString && r.emoji.toString()) || '?'}x${r.count}`)
                            .join(' ');
                        const reactStr = reacts ? ` {reactions: ${reacts}}` : ' {reactions: none}';
                        return `[${m.id}] #${channel.name} @${m.author.username} (${ts}): ${m.content}${reactStr}`;
                    }).reverse();
                    return { ok: true, data: out.map(t => ({ type: 'text', text: t })), isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_read_channel FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_read_channel error: ${err && err.message || String(err)}` }] };
                }
            }
            case 'discord_search_messages': {
                try {
                    // Resolve target channels. Omitting channel (or "all"/"*"/"everywhere") searches EVERY readable text channel.
                    const rawChannelInput = input.channel;
                    const ALL_TOKENS = ['all', '*', 'all channels', 'all-channels', 'everywhere', 'any', 'everything'];
                    const isAllToken = (v) => typeof v === 'string' && ALL_TOKENS.includes(v.trim().toLowerCase());
                    const searchAll = !rawChannelInput || (Array.isArray(rawChannelInput) ? rawChannelInput.some(isAllToken) : isAllToken(rawChannelInput));

                    let channels = [];
                    if (searchAll) {
                        const guild = client.guilds.cache.get(String(process.env.DISCORD_GUILD_ID));
                        if (!guild) return { ok: false, data: [{ type: 'text', text: 'guild not found or bot not in guild' }], isError: true, ms: 0 };
                        channels = Array.from(guild.channels.cache.values())
                            .filter(c => c && (c.type === 0 || c.type === 'GUILD_TEXT' || (c.isTextBased && c.isTextBased())) && c.viewable !== false);
                    } else {
                        let channelInputs = [];
                        if (Array.isArray(rawChannelInput)) {
                            channelInputs = rawChannelInput;
                        } else if (typeof rawChannelInput === 'string') {
                            channelInputs = rawChannelInput.includes(',') ? rawChannelInput.split(',').map(s => s.trim()).filter(Boolean) : [rawChannelInput];
                        } else {
                            channelInputs = [String(rawChannelInput)];
                        }
                        for (const cInput of channelInputs) {
                            const ch = resolveChannelFromInput(client, cInput);
                            if (ch && !channels.some(x => x.id === ch.id)) channels.push(ch);
                        }
                    }

                    const query = String(input.query || '').toLowerCase();
                    const rawLimit = Number(input.limit) || 100;
                    const perChannelLimit = Math.max(1, Math.min(100, rawLimit));
                    // Larger overall budget when sweeping every channel so nothing is silently missed.
                    const MAX_TOTAL = searchAll ? 2000 : 500; // hard cap across all channels
                    let totalScanned = 0;
                    const hits = [];
                    const searchedChannels = [];

                    for (const ch of channels) {
                        if (totalScanned >= MAX_TOTAL) break;
                        searchedChannels.push(ch.name || ch.id);
                        const remaining = Math.max(0, MAX_TOTAL - totalScanned);
                        const fetchLimit = Math.max(1, Math.min(perChannelLimit, remaining));
                        const msgs = await ch.messages.fetch({ limit: fetchLimit }).catch(() => null);
                        if (!msgs) continue;
                        _trackSeen(msgs, ch);
                        totalScanned += msgs.size || 0;
                        const channelHits = msgs.filter(m => !query || (m.content || '').toLowerCase().includes(query))
                            .map(m => {
                                const ts = m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdTimestamp || '');
                                return `[${m.id}] #${ch.name} @${m.author.username} (${ts}): ${m.content}`;
                            }).reverse();
                        hits.push(...channelHits);
                    }

                    const summaryLine = `Searched ${searchedChannels.length} channel(s)${query ? ` for "${query}"` : ''}; scanned ${totalScanned} messages; ${hits.length} match(es).`;
                    const result = { ok: true, data: [{ type: 'text', text: summaryLine }, ...hits.map(t => ({ type: 'text', text: t }))], isError: false, ms: 0 };
                    void (async () => {
                        try {
                            const { logDiscordEvent } = require('./log');
                            await logDiscordEvent({
                                toolName: 'discord_search_messages',
                                direction: 'search',
                                status: 'read',
                                query: query,
                                resultCount: hits.length,
                                channelName: searchedChannels.join(','),
                                triggeredBy: triggerContext || 'unknown',
                                turnId: turnId,
                                rawInput: input,
                                rawOutput: { ok: true, text: `found ${hits.length} hits` }
                            });
                        } catch (e) {}
                    })();
                    console.log('[discord-tool] search query:', query, 'channels searched:', searchedChannels.join(','), 'matches found:', hits.length, 'messages_scanned:', totalScanned);
                    return result;
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
                    const outText = `user: ${user.username}#${user.discriminator || '0000'}`;
                    void (async () => {
                        try {
                            const { logDiscordEvent } = require('./log');
                            await logDiscordEvent({
                                toolName: 'discord_get_user',
                                direction: 'inbound_read',
                                status: 'read',
                                targetUserId: userId,
                                targetUsername: user.username,
                                triggeredBy: triggerContext || 'unknown',
                                turnId: turnId,
                                rawInput: input,
                                rawOutput: { ok: true, text: outText }
                            });
                        } catch (e) {}
                    })();
                    return { ok: true, data: [{ type: 'text', text: outText }], isError: false, ms: 0 };
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

                    // SAFETY GATE: never send live without explicit human confirmation.
                    // First call drafts to #bot-drafts and returns CONFIRM_REQUIRED.
                    if (input.confirmed !== true) {
                        if (!DRAFT_HOLDING_CHANNELS.modDraftsId) {
                            return { ok: false, data: [{ type: 'text', text: 'GATED_WRITES_DISABLED: draft holding channel not configured' }], isError: true, ms: 0 };
                        }
                        const previewChunks = chunkForDiscord(sanitizeForDiscord(content));
                        const previewDraftCh = client.channels.cache.get(DRAFT_HOLDING_CHANNELS.modDraftsId) || client.channels.cache.find(c => c.name === DRAFT_HOLDING_CHANNELS.modDrafts) || null;
                        if (previewDraftCh) {
                            await previewDraftCh.send(`DRAFT (awaiting confirmation) for #${channel.name}:\n` + previewChunks[0]);
                        }
                        return { ok: true, data: [{ type: 'text', text: `CONFIRM_REQUIRED: drafted to #${DRAFT_HOLDING_CHANNELS.modDrafts} for #${channel.name}. Ask the user to confirm, then call discord_send_message again with confirmed=true to send.` }], isError: false, ms: 0 };
                    }

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
                        void (async () => {
                            try {
                                const { logDiscordEvent } = require('./log');
                                await logDiscordEvent({
                                    toolName: 'discord_send_message',
                                    direction: 'blueprint_draft',
                                    status: 'blueprint_gated',
                                    channelId: channel.id,
                                    channelName: channel.name,
                                    content: content,
                                    blueprintMatch: content.match(BLUEPRINT_TOPICS)?.[0] || null,
                                    triggeredBy: triggerContext || 'unknown',
                                    turnId: turnId,
                                    rawInput: input,
                                    rawOutput: { ok: true, text: 'DRAFT_CREATED (blueprint topic gated)' }
                                });
                            } catch (e) {}
                        })();
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
                        void (async () => {
                            try {
                                const { logDiscordEvent } = require('./log');
                                await logDiscordEvent({
                                    toolName: 'discord_send_message',
                                    direction: 'outbound_draft',
                                    status: 'drafted',
                                    channelId: channel.id,
                                    channelName: channel.name,
                                    content: content,
                                    triggeredBy: triggerContext || 'unknown',
                                    turnId: turnId,
                                    rawInput: input,
                                    rawOutput: { ok: true, text: 'DRAFT_CREATED' }
                                });
                            } catch (e) {}
                        })();
                        return { ok: true, data: [{ type: 'text', text: 'DRAFT_CREATED' }], isError: false, ms: 0 };
                    }
                    // Send first chunk as the message, subsequent chunks as followups
                    const sent = await _sendVerified(channel, chunks[0]);
                    _trackSent(sent, channel);
                    for (let i = 1; i < chunks.length; i++) {
                        await _sendVerified(channel, chunks[i]);
                    }
                    // Do not return numeric message ids in user-facing tool responses
                    void (async () => {
                        try {
                            const { logDiscordEvent } = require('./log');
                            await logDiscordEvent({
                                toolName: 'discord_send_message',
                                direction: 'outbound_send',
                                status: 'sent',
                                channelId: channel.id,
                                channelName: channel.name,
                                content: content,
                                triggeredBy: triggerContext || 'unknown',
                                turnId: turnId,
                                rawInput: input,
                                rawOutput: { ok: true, text: 'SENT' }
                            });
                        } catch (e) {}
                    })();
                    if (!sent || !sent.id) { return { ok: false, isError: true, data: [{ type: 'text', text: `SEND_FAILED: Discord did not acknowledge the message for #${channel.name} (no message id returned). It was NOT sent.` }] }; } return { ok: true, data: [{ type: 'text', text: `SENT_CONFIRMED: Discord acknowledged the message in #${channel.name} (delivery verified).` }], isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_send_message FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_send_message error: ${err && err.message || String(err)}` }] };
                }
            }

            case 'discord_send_all': {
                try {
                    const pattern = String(input.namePattern || 'clock-in').toLowerCase().trim();
                    const content = String(input.content || '').trim();
                    if (!content) return { ok: false, data: [{ type: 'text', text: 'content required' }], isError: true, ms: 0 };
                    const categoryFilter = String(input.category || '').toLowerCase().trim();
                    const guild = client.guilds.cache.get(String(process.env.DISCORD_GUILD_ID));
                    if (!guild) return { ok: false, data: [{ type: 'text', text: 'guild not found or bot not in guild' }], isError: true, ms: 0 };

                    // Find ALL text channels whose name matches the pattern (e.g. every clock-in channel).
                    // Identical channel names are told apart by their parent category (the school).
                    let matching = Array.from(guild.channels.cache.values())
                        .filter(c => c && c.name && (c.type === 0 || c.type === 'GUILD_TEXT' || (c.isTextBased && c.isTextBased())))
                        .filter(c => c.name.toLowerCase().includes(pattern));
                    if (categoryFilter) {
                        matching = matching.filter(c => c.parent && c.parent.name && c.parent.name.toLowerCase().includes(categoryFilter));
                    }
                    if (matching.length === 0) {
                        return { ok: true, data: [{ type: 'text', text: `No channels found matching "${pattern}"${categoryFilter ? ` in category "${categoryFilter}"` : ''}.` }], isError: false, ms: 0 };
                    }

                    const BLUEPRINT_TOPICS = /\b(money|salary|bonus|payment|payslip|contract|reject(ion|ed)?|fire|terminat|legal|R\d+|\$\d+|invoice)\b/i;
                    const safeContent = sanitizeForDiscord(content);
                    const chunks = chunkForDiscord(safeContent);
                    const isBlueprint = BLUEPRINT_TOPICS.test(content);
                    const draftChannel = DRAFT_HOLDING_CHANNELS.modDraftsId ? client.channels.cache.get(DRAFT_HOLDING_CHANNELS.modDraftsId) : client.channels.cache.find(c => c.name === DRAFT_HOLDING_CHANNELS.modDrafts) || null;

                    // Gated writes require a configured draft holding channel (same rule as discord_send_message).
                    if (!DRAFT_HOLDING_CHANNELS.modDraftsId) {
                        log.error('discord', sanitizeArgs('gated_writes_disabled', { reason: 'draft_holding_channel_missing' }));
                        return { ok: false, data: [{ type: 'text', text: 'GATED_WRITES_DISABLED: draft holding channel not configured' }], isError: true, ms: 0 };
                    }

                    // SAFETY GATE: never broadcast live without explicit human confirmation.
                    // First call drafts every target to #bot-drafts and returns CONFIRM_REQUIRED.
                    if (input.confirmed !== true) {
                        const preview = [];
                        for (const channel of matching) {
                            const school = (channel.parent && channel.parent.name) ? channel.parent.name : '(no category)';
                            if (draftChannel) {
                                await draftChannel.send(`DRAFT (awaiting confirmation) for #${channel.name} (${school}):\n` + chunks[0]);
                            }
                            preview.push(`#${channel.name} (${school})`);
                        }
                        return { ok: true, data: [{ type: 'text', text: `CONFIRM_REQUIRED: drafted to #${DRAFT_HOLDING_CHANNELS.modDrafts} for ${matching.length} channel(s):\n` + preview.join('\n') + `\n\nAsk the user to confirm, then call discord_send_all again with confirmed=true to broadcast.` }], isError: false, ms: 0 };
                    }

                    const summary = [];
                    let sentCount = 0, draftCount = 0;
                    for (const channel of matching) {
                        const school = (channel.parent && channel.parent.name) ? channel.parent.name : '(no category)';
                        // Sensitive topics or non-allowlisted channels => draft only, never auto-send.
                        if (isBlueprint || !WRITE_ALLOWLIST.has(channel.id)) {
                            if (draftChannel) {
                                const label = isBlueprint ? 'BLUEPRINT-GATED DRAFT' : 'DRAFT';
                                await draftChannel.send(`${label} for #${channel.name} (${school}):\n` + chunks[0]);
                            }
                            draftCount++;
                            summary.push(`#${channel.name} (${school}): drafted${isBlueprint ? ' (blueprint topic)' : ''}`);
                            continue;
                        }
                        try {
                            const sent = await _sendVerified(channel, chunks[0]);
                            _trackSent(sent, channel);
                            for (let i = 1; i < chunks.length; i++) {
                                await _sendVerified(channel, chunks[i]);
                            }
                            if (!sent || !sent.id) { throw new Error('Discord did not acknowledge the message (no message id returned)'); } sentCount++;
                            summary.push(`#${channel.name} (${school}): sent`);
                        } catch (e) {
                            summary.push(`#${channel.name} (${school}): failed (${e && e.message || String(e)})`);
                        }
                    }

                    void (async () => {
                        try {
                            const { logDiscordEvent } = require('./log');
                            await logDiscordEvent({
                                toolName: 'discord_send_all',
                                direction: 'outbound_send',
                                status: 'sent',
                                content: content,
                                channelName: matching.map(c => c.name).join(','),
                                triggeredBy: triggerContext || 'unknown',
                                turnId: turnId,
                                rawInput: input,
                                rawOutput: { ok: true, text: `sent ${sentCount}, drafted ${draftCount} across ${matching.length} channels` }
                            });
                        } catch (e) {}
                    })();
                    console.log('[discord-tool] send_all pattern:', pattern, 'channels:', matching.map(c => c.name).join(','), 'sent:', sentCount, 'drafted:', draftCount);
                    return { ok: true, data: [{ type: 'text', text: `Broadcast to ${matching.length} "${pattern}" channel(s): sent ${sentCount}, drafted ${draftCount}.\n` + summary.join('\n') }], isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_send_all FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_send_all error: ${err && err.message || String(err)}` }] };
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
                    // SAFETY GATE: the first call drafts the DM to #bot-drafts and returns CONFIRM_REQUIRED.
                    // Only an explicit confirmed=true actually delivers the DM to the user.
                    if (input.confirmed !== true) {
                        if (draftChannel) {
                            const targetUser = await client.users.fetch(userId).catch(() => null);
                            const who = targetUser ? `${targetUser.username}#${targetUser.discriminator || '0000'}` : 'user';
                            await draftChannel.send(`DM DRAFT (awaiting confirmation) for ${who}:\n` + safeContent.slice(0, 1800));
                        }
                        void (async () => {
                            try {
                                const { logDiscordEvent } = require('./log');
                                await logDiscordEvent({ toolName: 'discord_send_dm', direction: 'outbound_dm_draft', status: 'drafted', targetUserId: userId, targetUsername: username || null, content: content, triggeredBy: triggerContext || 'unknown', turnId: turnId, rawInput: input, rawOutput: { ok: true, text: 'CONFIRM_REQUIRED' } });
                            } catch (e) {}
                        })();
                        return { ok: true, data: [{ type: 'text', text: `CONFIRM_REQUIRED: drafted this DM to #${DRAFT_HOLDING_CHANNELS.modDrafts}. Ask the user to confirm, then call discord_send_dm again with confirmed=true to actually deliver it.` }], isError: false, ms: 0 };
                    }

                    // Confirmed: actually deliver the DM, verifying Discord acknowledged it.
                    try {
                        const targetUser = await client.users.fetch(userId).catch(() => null);
                        if (!targetUser) {
                            return { ok: false, isError: true, data: [{ type: 'text', text: 'SEND_FAILED: could not load that Discord user. The DM was NOT sent.' }], ms: 0 };
                        }
                        const dm = await _sendVerified(targetUser, safeContent);
                        const who = `${targetUser.username}#${targetUser.discriminator || '0000'}`;
                        void (async () => {
                            try {
                                const { logDiscordEvent } = require('./log');
                                await logDiscordEvent({ toolName: 'discord_send_dm', direction: 'outbound_dm_send', status: 'sent', targetUserId: userId, targetUsername: username || null, content: content, triggeredBy: triggerContext || 'unknown', turnId: turnId, rawInput: input, rawOutput: { ok: true, text: 'SENT_CONFIRMED' } });
                            } catch (e) {}
                        })();
                        return { ok: true, data: [{ type: 'text', text: `SENT_CONFIRMED: Discord delivered the DM to ${who} (delivery verified).` }], isError: false, ms: 0 };
                    } catch (e) {
                        return { ok: false, isError: true, data: [{ type: 'text', text: `SEND_FAILED: the DM was NOT delivered (${(e && e.message) || String(e)}). The recipient may have DMs disabled or block the bot.` }], ms: 0 };
                    }
                } catch (err) {
                    console.error('[discord-tool] discord_send_dm FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_send_dm error: ${err && err.message || String(err)}` }] };
                }
            }

            case 'discord_react_to_message': {
                try {
                    // Auto-resolve message reference if no explicit ID provided
                    if (!input.messageId || !input.channel) {
                        const resolved = await autoResolveMessageRef(client, input);
                        if (resolved) {
                            input = { ...input, channel: resolved.channelId, messageId: resolved.messageId };
                        }
                    }
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
                        void (async () => {
                            try { const { logDiscordEvent } = require('./log'); await logDiscordEvent({ toolName: 'discord_react_to_message', direction: 'outbound_send', status: 'drafted', channelId: channel.id, channelName: channel.name, content: emoji, triggeredBy: triggerContext || 'unknown', turnId: turnId, rawInput: input, rawOutput: { ok: true, text: 'DRAFT_CREATED' } }); } catch (e) {}
                        })();
                        return { ok: true, data: [{ type: 'text', text: 'DRAFT_CREATED' }], isError: false, ms: 0 };
                    }
                    const msg = await channel.messages.fetch(messageId).catch(() => null);
                    if (!msg) return { ok: false, data: [{ type: 'text', text: 'message not found' }], isError: true, ms: 0 };
                    let reacted = false;
                    let reactErr = null;
                    try {
                        await msg.react(emoji);
                        reacted = true;
                    } catch (e) {
                        reactErr = e instanceof Error ? e.message : String(e);
                    }
                    if (!reacted) {
                        return { ok: false, isError: true, data: [{ type: 'text', text: `React failed: ${reactErr || 'unknown error'}` }] };
                    }
                    void (async () => {
                        try { const { logDiscordEvent } = require('./log'); await logDiscordEvent({ toolName: 'discord_react_to_message', direction: 'outbound_send', status: 'sent', channelId: channel.id, channelName: channel.name, content: emoji, triggeredBy: triggerContext || 'unknown', turnId: turnId, rawInput: input, rawOutput: { ok: true, text: 'REACTED' } }); } catch (e) {}
                    })();
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
                        void (async () => {
                            try { const { logDiscordEvent } = require('./log'); await logDiscordEvent({ toolName: 'discord_create_thread', direction: 'outbound_send', status: 'drafted', channelId: channel.id, channelName: channel.name, content: name, triggeredBy: triggerContext || 'unknown', turnId: turnId, rawInput: input, rawOutput: { ok: true, text: 'DRAFT_CREATED' } }); } catch (e) {}
                        })();
                        return { ok: true, data: [{ type: 'text', text: 'DRAFT_CREATED' }], isError: false, ms: 0 };
                    }
                    // If messageId provided, create from message
                    if (input.messageId) {
                        const m = await channel.messages.fetch(input.messageId).catch(() => null);
                        if (!m) return { ok: false, data: [{ type: 'text', text: 'message not found' }], isError: true, ms: 0 };
                        const thread = await m.startThread({ name }).catch(() => null);
                        if (!thread) return { ok: false, data: [{ type: 'text', text: 'thread creation failed' }], isError: true, ms: 0 };
                        // Do not return numeric ids in user-facing responses
                        void (async () => { try { const { logDiscordEvent } = require('./log'); await logDiscordEvent({ toolName: 'discord_create_thread', direction: 'outbound_send', status: 'sent', channelId: channel.id, channelName: channel.name, content: name, triggeredBy: triggerContext || 'unknown', turnId: turnId, rawInput: input, rawOutput: { ok: true, text: 'THREAD_CREATED' } }); } catch (e) {} })();
                        return { ok: true, data: [{ type: 'text', text: `THREAD_CREATED` }], isError: false, ms: 0 };
                    }
                    const thread = await channel.threads.create({ name }).catch(() => null);
                    if (!thread) return { ok: false, data: [{ type: 'text', text: 'thread creation failed' }], isError: true, ms: 0 };
                    void (async () => { try { const { logDiscordEvent } = require('./log'); await logDiscordEvent({ toolName: 'discord_create_thread', direction: 'outbound_send', status: 'sent', channelId: channel.id, channelName: channel.name, content: name, triggeredBy: triggerContext || 'unknown', turnId: turnId, rawInput: input, rawOutput: { ok: true, text: 'THREAD_CREATED' } }); } catch (e) {} })();
                    return { ok: true, data: [{ type: 'text', text: `THREAD_CREATED` }], isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_create_thread FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_create_thread error: ${err && err.message || String(err)}` }] };
                }
            }

            case 'discord_delete_message': {
                try {
                    if (!input.confirmed) {
                        return { ok: false, data: [{ type: 'text', text: 'CONFIRM_REQUIRED: set confirmed=true to delete. Re-read the message and ask the user to confirm before proceeding.' }], isError: true, ms: 0 };
                    }
                    // Auto-resolve message reference if no explicit ID provided
                    if (!input.messageId || !input.channel) {
                        const resolved = await autoResolveMessageRef(client, input);
                        if (resolved) {
                            input = { ...input, channel: resolved.channelId, messageId: resolved.messageId };
                        }
                    }
                    const channel = resolveChannelFromInput(client, input.channel);
                    const messageId = input.messageId;
                    if (!channel || !messageId) return { ok: false, data: [{ type: 'text', text: 'channel and messageId required' }], isError: true, ms: 0 };
                    if (!WRITE_ALLOWLIST.has(channel.id)) {
                        return { ok: false, data: [{ type: 'text', text: `Delete not allowed in #${channel.name} — channel is not write-allowlisted.` }], isError: true, ms: 0 };
                    }
                    const msg = await channel.messages.fetch(messageId).catch(() => null);
                    if (!msg) return { ok: false, data: [{ type: 'text', text: 'message not found' }], isError: true, ms: 0 };
                    if (!msg.deletable) return { ok: false, data: [{ type: 'text', text: 'message not deletable — may be too old or the bot lacks permission' }], isError: true, ms: 0 };
                    let deleted = false;
                    let delErr = null;
                    try {
                        await msg.delete();
                        deleted = true;
                    } catch (e) {
                        delErr = e instanceof Error ? e.message : String(e);
                    }
                    if (!deleted) {
                        return { ok: false, isError: true, data: [{ type: 'text', text: `Delete failed: ${delErr || 'unknown error'}` }] };
                    }
                    void (async () => {
                        try { const { logDiscordEvent } = require('./log'); await logDiscordEvent({ toolName: 'discord_delete_message', direction: 'outbound_delete', status: 'deleted', channelId: channel.id, channelName: channel.name, content: messageId, triggeredBy: triggerContext || 'unknown', turnId: turnId, rawInput: input, rawOutput: { ok: true, text: 'DELETED' } }); } catch (e) {}
                    })();
                    return { ok: true, data: [{ type: 'text', text: `DELETED` }], isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_delete_message FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_delete_message error: ${err && err.message || String(err)}` }] };
                }
            }

            case 'discord_react_unchecked': {
                try {
                    const pattern = String(input.namePattern || 'clock-in').toLowerCase().trim();
                    const emoji = (String(input.emoji || '').trim()) || '\u2705';
                    const perChannel = Math.max(1, Math.min(200, Number(input.limit) || 100));
                    const guild = client.guilds.cache.get(String(process.env.DISCORD_GUILD_ID));
                    if (!guild) return { ok: false, data: [{ type: 'text', text: 'guild not found or bot not in guild' }], isError: true, ms: 0 };
                    // Find ALL text channels whose name contains the pattern (e.g. every clock-in channel)
                    const matching = Array.from(guild.channels.cache.values())
                        .filter(c => c && c.name && (c.type === 0 || c.type === 'GUILD_TEXT' || (c.isTextBased && c.isTextBased())))
                        .filter(c => c.name.toLowerCase().includes(pattern));
                    if (matching.length === 0) {
                        return { ok: true, data: [{ type: 'text', text: `No channels found matching "${pattern}".` }], isError: false, ms: 0 };
                    }
                    const summary = [];
                    let totalReacted = 0, totalAlready = 0;
                    for (const channel of matching) {
                        if (!WRITE_ALLOWLIST.has(channel.id)) { summary.push(`#${channel.name}: skipped (not write-allowlisted)`); continue; }
                        const msgs = await channel.messages.fetch({ limit: perChannel }).catch(() => null);
                        if (!msgs) { summary.push(`#${channel.name}: could not read messages`); continue; }
                        _trackSeen(msgs, channel);
                        let reacted = 0, already = 0;
                        for (const m of msgs.values()) {
                            const has = m.reactions && m.reactions.cache && m.reactions.cache.some(r => (r.emoji && r.emoji.name === emoji) || (r.emoji && r.emoji.toString && r.emoji.toString() === emoji));
                            if (has) { already++; continue; }
                            try { await m.react(emoji); reacted++; } catch (e) { /* skip unreactable message */ }
                        }
                        totalReacted += reacted; totalAlready += already;
                        summary.push(`#${channel.name}: reacted ${reacted}, already had it ${already}`);
                    }
                    void (async () => {
                        try { const { logDiscordEvent } = require('./log'); await logDiscordEvent({ toolName: 'discord_react_unchecked', direction: 'outbound_send', status: 'sent', content: emoji, triggeredBy: triggerContext || 'unknown', turnId: turnId, rawInput: input, rawOutput: { ok: true, text: `reacted ${totalReacted} across ${matching.length} channels` } }); } catch (e) {}
                    })();
                    console.log('[discord-tool] react_unchecked pattern:', pattern, 'channels:', matching.map(c => c.name).join(','), 'reacted:', totalReacted, 'already:', totalAlready);
                    return { ok: true, data: [{ type: 'text', text: `Swept ${matching.length} "${pattern}" channel(s) with ${emoji}. Added ${totalReacted} reaction(s); ${totalAlready} already had it.\n` + summary.join('\n') }], isError: false, ms: 0 };
                } catch (err) {
                    console.error('[discord-tool] discord_react_unchecked FAILED:', err && err.stack || err && err.message || String(err));
                    return { ok: false, isError: true, data: [{ type: 'text', text: `discord_react_unchecked error: ${err && err.message || String(err)}` }] };
                }
            }

            default:
                return { ok: false, data: [{ type: 'text', text: 'unknown tool' }], isError: true, ms: 0 };
        }
                } catch (e) {
                    console.error('[discord-tool] callTool TOP-LEVEL FAILED:', e && e.stack || e && e.message || String(e));
                    log.error('discord', sanitizeArgs('tool_error', { name, error: e instanceof Error ? e.message : String(e) }));
                    void (async () => { try { const { logDiscordEvent } = require('./log'); await logDiscordEvent({ toolName: name, direction: 'error', status: 'failed', errorMessage: e instanceof Error ? e.message : String(e), triggeredBy: triggerContext || 'unknown', turnId: turnId, rawInput: input, rawOutput: null }); } catch (ee) {} })();
                    return { ok: false, data: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true, ms: 0 };
                }
}

// ---- Auto-resolve message references (deictic: "that message", "the latest", "the one from X") ----

/**
 * Try to resolve a message reference from context without asking the user.
 * @param {object} client
 * @param {{ channel?: string, messageId?: string, refHint?: string }} input
 * @returns {Promise<{channelId: string, messageId: string}|null>} null if can't auto-resolve
 */
async function autoResolveMessageRef(client, input = {}) {
  // Already has explicit IDs
  if (input.messageId && input.channel) {
    return { channelId: input.channel, messageId: input.messageId };
  }

  const hint = (input.refHint || '').toLowerCase().trim();

  // (a) "that", "the same", "the message you just sent", or no hint -> last sent
  if (!hint || /^(that|same|the message|the one you|just sent|previous|above)$/.test(hint) ||
      /(?:you|we|i) (?:just |)sent/.test(hint) ||
      /the (?:same |)message/.test(hint)) {
    if (_lastSentMessage) {
      return { channelId: _lastSentMessage.channelId, messageId: _lastSentMessage.id };
    }
    return null;
  }

  // (b) "last/latest/recent in #channel" -> read latest from that channel
  const lastMatch = hint.match(/(?:last|latest|most recent|newest)\s+(?:message\s+)?(?:in\s+)?(#?\S+)/);
  if (lastMatch) {
    const chName = lastMatch[1];
    const ch = resolveChannelFromInput(client, chName);
    if (ch) {
      try {
        const msgs = await ch.messages.fetch({ limit: 1 });
        if (msgs && msgs.size > 0) {
          const m = msgs.first();
          return { channelId: ch.id, messageId: m.id };
        }
      } catch {}
    }
    return null;
  }

  // (c) "the one from X" or "the message about Y" -> search recent seen list
  const fromMatch = hint.match(/(?:from|by)\s+@?(\S+)/);
  if (fromMatch) {
    const author = fromMatch[1].replace(/^@/, '').toLowerCase();
    const matches = _recentSeenMessages.filter(e => e.author.toLowerCase() === author || e.author.toLowerCase().includes(author));
    if (matches.length === 1) return { channelId: matches[0].channelId, messageId: matches[0].id };
    if (matches.length > 1) return null; // ambiguous - let caller ask
  }

  const aboutMatch = hint.match(/about\s+(.+)/);
  if (aboutMatch) {
    const topic = aboutMatch[1].toLowerCase().trim();
    const matches = _recentSeenMessages.filter(e => (e.snippet || '').toLowerCase().includes(topic));
    if (matches.length === 1) return { channelId: matches[0].channelId, messageId: matches[0].id };
    if (matches.length > 1) return null;
  }

  // fallback: any hint that matches exactly one recent message's snippet
  if (hint.length > 2) {
    const matches = _recentSeenMessages.filter(e => (e.snippet || '').toLowerCase().includes(hint));
    if (matches.length === 1) return { channelId: matches[0].channelId, messageId: matches[0].id };
  }

  return null;
}

module.exports = { buildToolDefs, callTool, _sendVerified, autoResolveMessageRef, getLastSentMessage, getRecentSeenMessages, WRITE_ALLOWLIST, DRAFT_HOLDING_CHANNELS };
