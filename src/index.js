// src/index.js
import fs from 'fs';
import path from 'path';
import express from 'express';
import playdl from 'play-dl';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } from '@discordjs/voice';
import { Client, GatewayIntentBits, Partials, Events, EmbedBuilder, PermissionsBitField } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;

if (!TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN');
  process.exit(1);
}

// --- JSONBin helpers ---
let persistentCache = { queues: {}, modRoles: {}, warnings: {} };

async function jsonbinGet() {
  if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID) return persistentCache;
  const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_API_KEY }
  }).catch(() => null);
  if (!res || !res.ok) return persistentCache;
  const body = await res.json();
  persistentCache = body.record || body;
  return persistentCache;
}

async function jsonbinPut(data) {
  if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID) {
    fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
    return;
  }
  await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': JSONBIN_API_KEY
    },
    body: JSON.stringify(data)
  }).catch(() => {});
}

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const guildState = new Map();

function ensureGuildState(guildId) {
  if (!guildState.has(guildId)) {
    guildState.set(guildId, {
      queue: [],
      loop: false,
      current: null,
      player: null,
      connection: null
    });
  }
  return guildState.get(guildId);
}

async function playNext(guildId) {
  const state = ensureGuildState(guildId);
  if (state.loop && state.current) {
    const { stream, type } = await playdl.stream(state.current.url);
    const resource = createAudioResource(stream, { inputType: type });
    state.player.play(resource);
    return;
  }

  const next = state.queue.shift();
  if (!next) {
    state.current = null;
    await jsonbinPut(persistentCache);
    return;
  }

  state.current = next;
  const { stream, type } = await playdl.stream(next.url);
  const resource = createAudioResource(stream, { inputType: type });
  state.player.play(resource);
  state.connection.subscribe(state.player);
  await jsonbinPut(persistentCache);
}

// --- Ready Event ---
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  setInterval(() => jsonbinPut(persistentCache), 60000);
});

// --- Slash Commands ---
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;

  const guildId = i.guildId;
  const cmd = i.commandName;
  const state = ensureGuildState(guildId);

  try {
    // 🎵 MUSIC
    if (cmd === 'play' || cmd === 'add') {
      await i.deferReply();
      const query = i.options.getString('query', true);
      const vc = i.member.voice.channel;
      if (!vc) return i.editReply('You must be in a voice channel.');

      let url = query;
      if (!/^https?:\/\//.test(query)) {
        const res = await playdl.search(query, { limit: 1 });
        if (!res.length) return i.editReply('No results.');
        url = res[0].url;
      }

      if (!state.connection) {
        state.connection = joinVoiceChannel({
          channelId: vc.id,
          guildId: guildId,
          adapterCreator: i.guild.voiceAdapterCreator,
          selfDeaf: true
        });
      }
      if (!state.player) {
        state.player = createAudioPlayer();
        state.player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
      }

      const track = { url, requestedBy: i.user.tag };
      if (cmd === 'play') {
        state.queue.unshift(track);
        state.player.stop();
        await playNext(guildId);
        i.editReply(`▶️ Playing: ${url}`);
      } else {
        state.queue.push(track);
        if (!state.current) await playNext(guildId);
        i.editReply(`➕ Added to queue: ${url}`);
      }

      persistentCache.queues[guildId] = state.queue;
      await jsonbinPut(persistentCache);
      return;
    }

    if (cmd === 'loop') {
      state.loop = !state.loop;
      i.reply(`🔁 Loop ${state.loop ? 'enabled' : 'disabled'}`);
      return;
    }

    if (cmd === 'skip') {
      if (state.player) state.player.stop();
      i.reply('⏭️ Skipped.');
      return;
    }

    if (cmd === 'stop') {
      if (state.connection) state.connection.destroy();
      guildState.delete(guildId);
      i.reply('🛑 Stopped and left channel.');
      return;
    }

    // ⚙️ Utility / Fun
    if (cmd === 'ping') return i.reply(`🏓 ${client.ws.ping}ms`);
    if (cmd === 'rps') {
      const c = i.options.getString('choice');
      const arr = ['rock', 'paper', 'scissors'];
      const bot = arr[Math.floor(Math.random() * arr.length)];
      let result = 'tie';
      if ((c === 'rock' && bot === 'scissors') || (c === 'paper' && bot === 'rock') || (c === 'scissors' && bot === 'paper')) result = 'you win';
      else if (c !== bot) result = 'you lose';
      return i.reply(`You: ${c}\nBot: ${bot}\nResult: ${result}`);
    }
    if (cmd === 'coinflip') return i.reply(Math.random() < 0.5 ? 'Heads' : 'Tails');
    if (cmd === 'dice') {
      const max = i.options.getInteger('max') || 6;
      return i.reply(`🎲 You rolled ${Math.floor(Math.random() * max) + 1}`);
    }

    if (cmd === 'userinfo') {
      const user = i.options.getUser('user') || i.user;
      const embed = new EmbedBuilder()
        .setTitle(`${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields({ name: 'ID', value: user.id });
      return i.reply({ embeds: [embed] });
    }

    if (cmd === 'avatar') {
      const user = i.options.getUser('user') || i.user;
      return i.reply(user.displayAvatarURL({ size: 512 }));
    }

    if (cmd === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('Help Menu')
        .addFields(
          { name: '🎵 Music', value: '/play /add /loop /skip /stop' },
          { name: '🛡️ Moderation', value: '/warn /ban /kick /listmodroles' },
          { name: '🎲 Fun', value: '/rps /coinflip /dice' },
          { name: '⚙️ Utility', value: '/ping /userinfo /avatar /help' }
        );
      return i.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (e) {
    console.error(e);
    if (i.deferred) i.editReply('❌ Error executing command.');
    else i.reply('❌ Error executing command.');
  }
});

// --- Keep alive (GitHub action) ---
const app = express();
app.get('/', (_, res) => res.send('Bot alive'));
app.listen(3000, () => console.log('Health check running on port 3000'));

client.login(TOKEN);
