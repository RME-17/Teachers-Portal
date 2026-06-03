require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const REGISTER = String(process.env.DISCORD_REGISTER_COMMANDS || '1') === '1';

if (!TOKEN) {
	console.error('DISCORD_BOT_TOKEN not set in .env');
	// do not throw here so callers can decide how to handle
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
    ],
	partials: [Partials.Channel],
});

async function registerCommandsIfNeeded() {
    try {
        if (!REGISTER) {
            console.log('Skipping command registration (DISCORD_REGISTER_COMMANDS != 1)');
            return;
        }
        const commands = [
            { name: 'ping', description: 'Ping the bot' },
            {
                name: 'ask',
                description: 'Ask the AI a question',
                options: [
                    { name: 'prompt', type: 3, description: 'Your question', required: true },
                ],
            },
        ];
        // Resolve a numeric guild id even if the environment value contains
        // extra characters (e.g. someone pasted an invite URL or an oauth query string).
        function extractGuildId(v) {
            if (!v) return null;
            const s = String(v).trim();
            if (/^\d{16,20}$/.test(s)) return s;
            // Find the first sequence of 16-20 digits inside the string
            const m = s.match(/(\d{16,20})/);
            if (m && m[1]) return m[1];
            return null;
        }

        const resolvedGuildId = extractGuildId(GUILD_ID);
        if (!resolvedGuildId) {
            console.log('No valid DISCORD_GUILD_ID set — skipping guild command registration. To register locally, set DISCORD_GUILD_ID to the numeric guild id (right-click server → "Copy ID").');
            if (GUILD_ID) {
                // Avoid logging the raw value as it may contain query params or secrets
                console.error('DISCORD_GUILD_ID appears invalid. It must be a numeric guild (server) ID (a Discord snowflake). Do not paste full URLs or query strings here; use the numeric guild id (right-click server → "Copy ID").');
            }
            return;
        }

        try {
            console.log('Registering commands to guild', resolvedGuildId, GUILD_ID && (resolvedGuildId !== String(GUILD_ID).trim()) ? '(extracted from provided value)' : '');
            const guild = await client.guilds.fetch(resolvedGuildId);
            await guild.commands.set(commands);
            console.log('Commands registered (guild)');
        } catch (fetchErr) {
            // Provide better diagnostics for common Discord API failures
            console.error('Failed to register commands to guild id', resolvedGuildId, '— fetch or registration failed. Skipping.');
            try {
                const code = fetchErr && (fetchErr.rawError && fetchErr.rawError.code) || fetchErr.code || fetchErr.status || fetchErr.statusCode;
                if (code === 10004 || fetchErr && String(fetchErr).toLowerCase().includes('unknown guild') || fetchErr && fetchErr.status === 404) {
                    console.error('Discord responded: Unknown Guild (the bot is not a member of that server or the guild id is invalid).');
                    console.error('Fixes:');
                    console.error('- The OAuth bot invite URL only needs client_id, scope, and permissions.\nNo secret of any kind is required for this URL — never include one.');
                    const clientId = CLIENT_ID || '1508440217936334949';
                    const perms = '412317240384';
                    // Only include client_id, scope and permissions. Never include client_secret or other secrets.
                    console.error(`  https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${perms}`);
                    console.error('- Ensure DISCORD_GUILD_ID is the numeric guild id (right-click server → "Copy ID") or leave it unset to skip guild registration.');
                    console.error('- Ensure the bot token (DISCORD_BOT_TOKEN) is from the same application that was invited to the server.');
                } else if (code === 50001 || (fetchErr && fetchErr.rawError && fetchErr.rawError.code === 50001)) {
                    console.error('Discord responded: Missing Access. The bot is in the server but lacks permission to fetch or manage commands.');
                    console.error('- Ensure the bot has appropriate permissions and the invite included the necessary scopes.');
                } else if (fetchErr && fetchErr.rawError && fetchErr.rawError && fetchErr.rawError.message) {
                    console.error('Discord error:', fetchErr.rawError.message);
                } else {
                    console.error(fetchErr);
                }
            } catch (e) {
                console.error('Error inspecting guild registration failure', e);
                console.error(fetchErr);
            }
        }
    } catch (err) {
        console.error('Failed to register commands', err);
    }
}

function loadEventHandlers() {
	const eventsDir = path.join(__dirname, 'events');
	try {
		if (fs.existsSync(eventsDir)) {
			for (const f of fs.readdirSync(eventsDir)) {
				if (!f.endsWith('.js')) continue;
				require(path.join(eventsDir, f))(client);
			}
			console.log('Loaded event handlers from', eventsDir);
		} else {
			console.log('No events directory found at', eventsDir);
		}
	} catch (err) {
		console.error('Error loading event handlers', err);
	}
}

async function start() {
	if (!TOKEN) {
		throw new Error('DISCORD_BOT_TOKEN must be set in .env before starting the bot');
	}
    loadEventHandlers();
    const onReady = async () => {
        console.log('Discord bot ready as', client.user?.tag);
        await registerCommandsIfNeeded();

        // Wire DISCORD_WRITE_ALLOWLIST and DISCORD_DRAFT_HOLDING_CHANNEL from env
        try {
            const aiTools = require(path.join(__dirname, 'ai-tools'));

            const normalizeName = (v) => {
                if (!v) return '';
                let s = String(v).trim().toLowerCase();
                if (s.startsWith('#')) s = s.slice(1);
                return s;
            };

            const rawAllow = String(process.env.DISCORD_WRITE_ALLOWLIST || '').trim();
            const allowNames = rawAllow ? rawAllow.split(',').map(normalizeName).filter(Boolean) : [];
            const rawDraft = normalizeName(process.env.DISCORD_DRAFT_HOLDING_CHANNEL || 'bot-drafts');

            // Build a map of normalized channel name -> channels
            const nameToChannels = new Map();
            for (const ch of client.channels.cache.values()) {
                if (!ch || !ch.name) continue;
                const n = normalizeName(ch.name);
                const arr = nameToChannels.get(n) || [];
                arr.push(ch);
                nameToChannels.set(n, arr);
            }

            const resolved = [];
            const missing = [];
            aiTools.WRITE_ALLOWLIST.clear();

            for (const want of allowNames) {
                // Accept either a numeric Discord channel ID (snowflake) or a channel name.
                if (/^\d{17,20}$/.test(want)) {
                    const byId = client.channels.cache.get(want) || null;
                    if (byId) {
                        aiTools.WRITE_ALLOWLIST.add(String(byId.id));
                        resolved.push({ name: byId.name || want, id: byId.id });
                    } else {
                        missing.push(want);
                    }
                    continue;
                }
                // Name match: add EVERY channel sharing this name (e.g. each school's
                // identically-named clock-in channel), not just the first one.
                const list = (nameToChannels.get(want) || []).filter(c => c.isTextBased && c.isTextBased());
                if (list.length) {
                    for (const c of list) {
                        aiTools.WRITE_ALLOWLIST.add(String(c.id));
                        resolved.push({ name: c.name || want, id: c.id });
                    }
                } else {
                    missing.push(want);
                }
            }

            // Always allow every school's clock-in channel, even if not listed in
            // DISCORD_WRITE_ALLOWLIST. Each school has its own clock-in channel under
            // its own category; this guarantees broadcasts can reach all schools.
            const broadcastPattern = normalizeName(process.env.DISCORD_BROADCAST_PATTERN || 'clock-in');
            if (broadcastPattern) {
                for (const ch of client.channels.cache.values()) {
                    if (!ch || !ch.name) continue;
                    if (!(ch.isTextBased && ch.isTextBased())) continue;
                    if (!normalizeName(ch.name).includes(broadcastPattern)) continue;
                    if (!aiTools.WRITE_ALLOWLIST.has(String(ch.id))) {
                        aiTools.WRITE_ALLOWLIST.add(String(ch.id));
                        resolved.push({ name: ch.name, id: ch.id });
                    }
                }
            }

            // Resolve draft holding channel
            const draftList = nameToChannels.get(rawDraft) || [];
            let draftChosen = draftList.find(c => c.isTextBased && c.isTextBased()) || draftList[0] || null;
            if (draftChosen) {
                aiTools.DRAFT_HOLDING_CHANNELS.modDraftsId = String(draftChosen.id);
            } else {
                aiTools.DRAFT_HOLDING_CHANNELS.modDraftsId = undefined;
            }

            // Log the allowlist resolution (dev terminal ok to show ids)
            const resolvedSummary = resolved.map(r => `#${r.name} (${r.id})`).join(', ');
            console.log(`[discord-tool] Write allowlist resolved: ${resolvedSummary}${resolved.length ? ', ' : ''}${resolved.length}/${allowNames.length} channels found.`);
            if (missing.length) {
                console.warn(`[discord-tool] Write allowlist names not found: ${missing.join(', ')}`);
            }

            if (!aiTools.DRAFT_HOLDING_CHANNELS.modDraftsId) {
                console.error(`[discord-tool] Draft holding channel "${rawDraft}" could not be resolved. Gated writes will be refused until the channel is created.`);
            } else {
                console.log(`[discord-tool] Draft holding channel resolved: #${rawDraft} (${aiTools.DRAFT_HOLDING_CHANNELS.modDraftsId})`);
            }
        } catch (e) {
            console.error('Error resolving Discord write allowlist or draft channel', e);
        }
    };
    // Expose the client for other modules (ai-chat tool registration). Set only when starting.
    global.__discord_client = client;

    // Prefer clientReady for discord.js >= 14. If clientReady does not arrive within
    // 30 seconds, register a one-time fallback for 'ready'. While registering the
    // fallback we temporarily suppress the specific deprecation warning about
    // the 'ready' event to avoid noisy output.
    try {
        const djs = require('discord.js');
        const major = djs && djs.version ? parseInt(String(djs.version).split('.')[0], 10) : NaN;
        const preferClientReady = !Number.isNaN(major) && major >= 14;
        if (preferClientReady) {
            let fired = false;
            client.once('clientReady', () => { fired = true; onReady(); });
            // fallback path: if clientReady doesn't fire within 30s, attach a one-time 'ready' handler
            setTimeout(() => {
                if (!fired) {
                    // Temporary warning filter: swallow Discord's deprecation warning referencing 'ready'
                    const tmpWarn = (warning) => {
                        try {
                            const msg = String(warning && (warning.message || warning));
                            if (/ready.*deprecated|EventEmitter.*ready|DeprecationWarning.*ready/i.test(msg)) {
                                return; // swallow the known deprecation
                            }
                        } catch (e) {}
                        // forward non-matching warnings to console
                        console.warn(warning);
                    };
                    process.on('warning', tmpWarn);
                    client.once('ready', async () => {
                        try { await onReady(); } finally {
                            // remove the temporary warning filter after a short grace period
                            setTimeout(() => process.removeListener('warning', tmpWarn), 5000);
                        }
                    });
                }
            }, 30000);
        } else {
            client.once('ready', onReady);
        }
    } catch (e) {
        // If we cannot inspect discord.js version, fall back to listening for 'ready'.
        client.once('ready', onReady);
    }

    await client.login(TOKEN);
    console.log('Discord client login initiated');
}

async function stop() {
	try {
		await client.destroy();
		console.log('Discord client destroyed');
	} catch (err) {
		console.error('Error destroying client', err);
	}
}

module.exports = { start, stop, client };
