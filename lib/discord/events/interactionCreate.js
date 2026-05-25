module.exports = (client) => {
    client.on('interactionCreate', async (interaction) => {
        try {
            if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
                const cmd = interaction.commandName;
                if (cmd === 'ping') {
                    await interaction.reply({ content: 'Pong!', fetchReply: false });
                } else if (cmd === 'ask') {
                    try {
                        const prompt = interaction.options.getString('prompt');
                        await interaction.deferReply();
                        const { getAiChatService } = require('../../ai-chat');
                        const { sanitizeForDiscord, chunkForDiscord } = require('../sanitize');
                        const discordSys = require('../discord-system-prompt');
                        const svc = getAiChatService();
                        // Ensure service has an admin email set (fallback)
                        try { svc.setUserEmail(process.env.RME_ADMIN_EMAIL || 'inforecruitmyenglish@gmail.com'); } catch {}
                        const res = await svc.chat({ messages: [{ role: 'user', content: prompt }], systemPrompt: discordSys });
                        if (res && res.ok && typeof res.data === 'string') {
                            const text = sanitizeForDiscord(res.data);
                            const parts = chunkForDiscord(text, 1900);
                            if (parts.length === 0) {
                                await interaction.editReply('');
                            } else {
                                // first chunk via editReply
                                await interaction.editReply(parts[0]);
                                // subsequent chunks via channel.send
                                for (let i = 1; i < parts.length; i++) {
                                    try { await interaction.channel.send(parts[i]); } catch (e) { const { sanitizeArgs } = require('../../log/sanitize'); console.error(sanitizeArgs(['send followup chunk error:', e?.name, e?.message, e?.stack])); }
                                }
                            }
                        } else {
                            const msg = res && res.error ? (res.error.message || JSON.stringify(res.error)) : 'AI error';
                            await interaction.editReply('Error: ' + String(msg).slice(0, 1900));
                        }
                    } catch (e) {
                        console.error('ask command error:', e?.name, e?.message, e?.stack);
                        try { if (interaction.deferred) await interaction.editReply('Error executing ask command'); else await interaction.reply('Error executing ask command'); } catch {}
                    }
                }
            }
        } catch (err) {
            console.error('interactionCreate handler error:', err?.name, err?.message, err?.stack);
            try { if (interaction.replied || interaction.deferred) await interaction.followUp({ content: 'Error handling command', ephemeral: true }); else await interaction.reply({ content: 'Error handling command', ephemeral: true }); } catch(_) {}
        }
    });
};
