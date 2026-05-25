const { ChannelType } = require('discord.js');

module.exports = (client) => {
	client.on('messageCreate', async (message) => {
		try {
			// ignore bots
			if (!message || message.author?.bot) return;

			// DMs
			if (message.channel?.type === ChannelType.DM) {
				await message.reply('Thanks for the DM — try the /ping command (or mention me in a server).');
				return;
			}

		// Mentions in guilds
		if (message.mentions && message.mentions.has(client.user)) {
			// Treat mention as a quick ask: send the text content (without mention) to the AI chat service
			try {
				const clean = message.content.replace(/<@!?\d+>/g, '').trim();
				if (clean.length === 0) {
					await message.reply('Hi — try the /ping command to test the bot.');
					return;
				}
                const { getAiChatService } = require('../../ai-chat');
                const { sanitizeForDiscord, chunkForDiscord } = require('../sanitize');
                const discordSys = require('../discord-system-prompt');
                const { sanitizeArgs } = require('../../log/sanitize');
                const svc = getAiChatService();
                try { svc.setUserEmail(process.env.RME_ADMIN_EMAIL || 'inforecruitmyenglish@gmail.com'); } catch {}
                const reply = await svc.chat({ messages: [{ role: 'user', content: clean }], systemPrompt: discordSys });
                if (reply && reply.ok && typeof reply.data === 'string') {
                    const text = sanitizeForDiscord(reply.data);
                    const parts = chunkForDiscord(text, 1900);
                    if (parts.length === 0) return;
                    // first chunk as reply
                    await message.reply(parts[0]);
                    // subsequent via channel.send
                    for (let i = 1; i < parts.length; i++) {
                        try { await message.channel.send(parts[i]); } catch (e) { console.error(sanitizeArgs(['send followup chunk error:', e?.name, e?.message, e?.stack])); }
                    }
                } else {
                    await message.reply('Error: ' + (reply && reply.error ? (reply.error.message || JSON.stringify(reply.error)) : 'AI error'));
                }
            } catch (e) {
                console.error(sanitizeArgs(['mention->AI error:', e?.name, e?.message, e?.stack]));
                try { await message.reply('Error processing your request'); } catch {}
            }
		}
        } catch (err) {
            console.error(sanitizeArgs(['messageCreate handler error:', err?.name, err?.message, err?.stack]));
        }
	});
};
