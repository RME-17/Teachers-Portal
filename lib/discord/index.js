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
                    console.error('- Invite the bot to the server using the OAuth invite URL below (replace CLIENT_ID if needed). This URL will NOT contain any client secrets.');
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
