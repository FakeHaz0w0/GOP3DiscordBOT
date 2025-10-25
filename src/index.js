const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');

// Setup Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const TOKEN = process.env.DISCORD_TOKEN;

// Basic Discord bot behavior
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('messageCreate', message => {
  if (message.author.bot) return;
  if (message.content === '!ping') {
    message.channel.send('🏓 Pong!');
  }
});

// Hourly uptime log
setInterval(() => {
  console.log(`🕐 Bot alive — ${new Date().toLocaleString()}`);
}, 3600000); // every 1 hour

// Express health check server (for UptimeRobot ping)
const app = express();
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});
app.listen(process.env.PORT || 3000, () => console.log('🌐 Health endpoint ready'));

// Login bot
client.login(TOKEN);
