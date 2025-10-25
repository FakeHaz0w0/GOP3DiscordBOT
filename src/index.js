// src/index.js
import fs from 'fs';
import path from 'path';
import express from 'express';
import fetch from 'node-fetch';
import playdl from 'play-dl';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } from '@discordjs/voice';
import { Client, GatewayIntentBits, Partials, Events, EmbedBuilder, PermissionsBitField } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

// --- Config and persistence (JSONBin) ---
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY || null;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || null;
const LOCAL_DATA = path.resolve('./data.json'); // fallback local
let persistentCache = { queues: {} };

// load local fallback if exists
if (fs.existsSync(LOCAL_DATA)) {
  try { persistentCache = JSON.parse(fs.readFileSync(LOCAL_DATA, 'utf8')); } catch (e) { console.warn('local data load failed', e); }
}

// JSONBin helpers
async function jsonbinGet() {
  if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID) return persistentCache;
  const url = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`;
  const res = await fetch(url, { headers: { 'X-Master-Key': JSONBIN_API_KEY } });
  if (!res.ok) {
    console.warn('JSONBin GET failed', res.status);
    return persistentCache;
  }
  const body = await res.json();
  // JSONBin wraps data in record: body.record
  const data = body.record || body;
  persistentCache = data;
  return data;
}

async function jsonbinPut(data) {
  if (!JSONBIN_API_KEY || !JSONBIN_BIN_ID) {
    // fallback to local write
    try { fs.writeFileSync(LOCAL_DATA, JSON.stringify(data, null, 2)); } catch (e) { console.warn('local save failed', e); }
    persistentCache = data;
    return;
  }
  const url = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': JSONBIN_API_KEY
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    console.warn('JSONBin PUT failed', res.status);
  } else {
    persistentCache = data;
  }
}

// ensure initial load
await jsonbinGet().catch(e => console.warn('initial jsonbin load failed', e));

// --- Discord client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel, Partials.Message]
});
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('Missing DISCORD_TOKEN'); process.exit(1); }

const snipeCache = new Map(); // channel-> last deleted msg
const guildState = new Map(); // guildId -> { queue:[], player, connection, loop, current }

// helper to persist queues
async function saveQueues() {
  const data = persistentCache || { queues: {} };
  // gather guild queues from runtime
  for (const [gid, state] of guildState.entries()) {
    data.queues[gid] = state.queue || [];
    // persist also loop and current url metadata if desired
    data.queues[gid].__meta = { loop: !!state.loop, current: state.current || null };
  }
  await jsonbinPut(data).catch(e => console.warn('jsonbinPut error', e));
}

async function loadQueuesToMemory() {
  const data = await jsonbinGet();
  const q = (data && data.queues) || {};
  for (const [gid, arr] of Object.entries(q)) {
    const queue = Array.isArray(arr) ? arr.filter(i => typeof i === 'object') : [];
    const meta = (arr && arr.__meta) ? arr.__meta : {};
    guildState.set(gid, {
      queue,
      player: null,
      connection: null,
      loop: !!meta.loop,
      current: meta.current || null
    });
  }
}

// call once at start
await loadQueuesToMemory();

// Music helpers
function ensureGuildState(guildId) {
  if (!guildState.has(guildId)) {
    guildState.set(guildId, { queue: [], player: null, connection: null, loop: false, current: null });
  }
  return guildState.get(guildId);
}

async function joinAndDeaf(interaction) {
  const memberVC = interaction.member?.voice?.channel;
  if (!memberVC) return null;
  const connection = joinVoiceChannel({
    channelId: memberVC.id,
    guildId: memberVC.guild.id,
    adapterCreator: memberVC.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false
  });
  return connection;
}

async function ensurePlayerAndHandlers(guildId) {
  const state = ensureGuildState(guildId);
  if (!state.player) {
    const player = createAudioPlayer();
    player.on('stateChange', (oldS, newS) => {
      if (newS.status === AudioPlayerStatus.Idle && oldS.status !== AudioPlayerStatus.Idle) {
        // track finished -> next
        playNext(guildId).catch(e => console.warn('playNext error', e));
      }
    });
    player.on('error', e => console.warn('Audio player error', e));
    state.player = player;
  }
  return state.player;
}

async function playNext(guildId) {
  const state = ensureGuildState(guildId);
  if (!state) return;
  if (state.loop && state.current) {
    // replay current
    try {
      const stream = await playdl.stream(state.current.url, { quality: 2 });
      const resource = createAudioResource(stream.stream, { inputType: stream.type });
      state.player.play(resource);
      return;
    } catch (e) {
      console.warn('loop playback failed', e);
      state.current = null;
    }
  }

  const next = state.queue.shift();
  if (!next) {
    state.current = null;
    // optionally auto-disconnect after timeout — left out for now
    await saveQueues();
    return;
  }

  state.current = next;
  try {
    const { stream, type } = await playdl.stream(next.url, { quality: 2 });
    const resource = createAudioResource(stream, { inputType: type, inlineVolume: true });
    if (resource.volume) resource.volume.setVolume(0.9);
    state.player.play(resource);
    if (state.connection) state.connection.subscribe(state.player);
    await saveQueues();
  } catch (err) {
    console.warn('play error', err);
    state.current = null;
    // recursive try next
    await playNext(guildId);
  }
}

function isUrl(s) {
  try { new URL(s); return true; } catch { return false; }
}

// --- Event handlers ---
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  // background periodic save
  setInterval(() => {
    saveQueues().catch(e => console.warn('periodic save failed', e));
    console.log('Periodic save done.');
  }, 60000); // every 60s
});

client.on('messageDelete', (m) => {
  if (!m || !m.channel) return;
  snipeCache.set(m.channel.id, { content: m.content || '', authorTag: m.author?.tag || 'unknown', time: new Date().toISOString() });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction.commandName;
  const guildId = interaction.guildId;
  const member = interaction.member;
  ensureGuildState(guildId);

  // helper to check admin or mod role (mod roles stored in JSONBin under modRoles)
  const isAdminOrMod = async (member) => {
    if (!member) return false;
    if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
    // modRoles stored at top-level persistentCache.modRoles
    const modroles = (persistentCache && persistentCache.modRoles && persistentCache.modRoles[guildId]) || [];
    return member.roles.cache.some(r => modroles.includes(r.id));
  };

  try {
    // -------------- Moderation --------------
    if (cmd === 'addmodrole') {
      if (!await isAdminOrMod(member)) return interaction.reply({ content: 'Admin/mod required', ephemeral: true });
      const role = interaction.options.getRole('role', true);
      persistentCache.modRoles = persistentCache.modRoles || {};
      persistentCache.modRoles[guildId] = Array.from(new Set([...(persistentCache.modRoles[guildId] || []), role.id]));
      await jsonbinPut(persistentCache);
      return interaction.reply(`Added mod role ${role.name}`);
    }

    if (cmd === 'removemodrole') {
      if (!await isAdminOrMod(member)) return interaction.reply({ content: 'Admin/mod required', ephemeral: true });
      const role = interaction.options.getRole('role', true);
      persistentCache.modRoles = persistentCache.modRoles || {};
      persistentCache.modRoles[guildId] = (persistentCache.modRoles[guildId] || []).filter(id => id !== role.id);
      await jsonbinPut(persistentCache);
      return interaction.reply(`Removed mod role ${role.name}`);
    }

    if (cmd === 'listmodroles') {
      const arr = (persistentCache.modRoles && persistentCache.modRoles[guildId]) || [];
      if (!arr.length) return interaction.reply('No mod roles configured.');
      const names = arr.map(id => {
        const r = interaction.guild.roles.cache.get(id);
        return r ? `${r.name}` : `Unknown(${id})`;
      }).join('\n');
      return interaction.reply({ content: `Mod roles:\n${names}`, ephemeral: true });
    }

    if (cmd === 'warn') {
      if (!await isAdminOrMod(member)) return interaction.reply({ content: 'Admin/mod required', ephemeral: true });
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'No reason provided';
      persistentCache.warnings = persistentCache.warnings || {};
      persistentCache.warnings[guildId] = persistentCache.warnings[guildId] || {};
      persistentCache.warnings[guildId][user.id] = persistentCache.warnings[guildId][user.id] || [];
      persistentCache.warnings[guildId][user.id].push({ by: interaction.user.tag, reason, time: new Date().toISOString() });
      await jsonbinPut(persistentCache);
      return interaction.reply(`Warned ${user.tag}`);
    }

    if (cmd === 'listwarnings') {
      const user = interaction.options.getUser('user') || interaction.user;
      const arr = ((persistentCache.warnings && persistentCache.warnings[guildId] && persistentCache.warnings[guildId][user.id]) || []);
      if (!arr.length) return interaction.reply(`${user.tag} has no warnings.`);
      const text = arr.map((w,i) => `${i}: by ${w.by} - ${w.reason} (${w.time})`).join('\n');
      return interaction.reply({ content: `Warnings for ${user.tag}:\n${text}`, ephemeral: true });
    }

    if (cmd === 'ban') {
      if (!await isAdminOrMod(member)) return interaction.reply({ content: 'Admin/mod required', ephemeral: true });
      const user = interaction.options.getUser('user', true);
      const mins = interaction.options.getInteger('minutes');
      const reason = interaction.options.getString('reason') || 'No reason';
      await interaction.guild.members.ban(user.id, { reason }).catch(e => console.warn('ban failed', e));
      if (mins && mins > 0) {
        setTimeout(() => {
          interaction.guild.members.unban(user.id).catch(()=>{});
        }, mins * 60 * 1000);
      }
      return interaction.reply(`Banned ${user.tag} — ${reason}`);
    }

    if (cmd === 'kick') {
      if (!await isAdminOrMod(member)) return interaction.reply({ content: 'Admin/mod required', ephemeral: true });
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') || 'No reason';
      const m = await interaction.guild.members.fetch(user.id).catch(()=>null);
      if (!m) return interaction.reply('Member not found or cannot be kicked.');
      await m.kick(reason).catch(e => console.warn('kick failed', e));
      return interaction.reply(`Kicked ${user.tag}`);
    }

    // -------------- Music --------------
    if (cmd === 'play' || cmd === 'add') {
      await interaction.deferReply();
      const query = interaction.options.getString('query', true).trim();
      const guildId = interaction.guildId;
      const memberVC = interaction.member.voice.channel;
      if (!memberVC) return interaction.editReply('You must be in a voice channel.');

      // resolve URL or search
      let url = null;
      if (isUrl(query)) {
        url = query;
      } else {
        // search via play-dl
        const results = await playdl.search(query, { source: 'youtube', limit: 1 }).catch(e => { console.warn('search fail', e); return []; });
        if (!results || results.length === 0) return interaction.editReply('No results found for your query.');
        url = results[0].url;
      }

      // ensure join & player
      const state = ensureGuildState(guildId);
      if (!state.connection) {
        try {
          state.connection = joinVoiceChannel({
            channelId: memberVC.id,
            guildId: guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false
          });
        } catch (e) {
          console.warn('join failed', e);
          return interaction.editReply('Failed to join voice channel.');
        }
      }
      await ensurePlayerAndHandlers(guildId);

      const track = { url, requestedBy: interaction.user.tag, title: null };
      // attempt to fetch metadata
      try {
        const info = await playdl.videoBasicInfo(url);
        track.title = info.video_details.title;
      } catch {}

      if (cmd === 'play') {
        // insert at head and force skip to it
        state.queue.unshift(track);
        // if playing, stop to move to next
        if (state.player && state.player.state.status !== AudioPlayerStatus.Idle) {
          state.player.stop(true);
        } else {
          // start directly
          await playNext(guildId);
        }
        await saveQueues();
        return interaction.editReply(`Now playing: ${track.title || url}`);
      } else {
        // add
        state.queue.push(track);
        if (!state.current) await playNext(guildId);
        await saveQueues();
        return interaction.editReply(`Added to queue: ${track.title || url}`);
      }
    }

    if (cmd === 'loop') {
      const state = ensureGuildState(guildId);
      state.loop = !state.loop;
      await saveQueues();
      return interaction.reply(`Loop is now ${state.loop ? 'ON' : 'OFF'}`);
    }

    if (cmd === 'skip') {
      if (!await isAdminOrMod(member)) return interaction.reply({ content: 'Admin/mod required', ephemeral: true });
      const state = ensureGuildState(guildId);
      if (state.player) {
        state.player.stop(true);
        return interaction.reply('Skipping current track.');
      } else return interaction.reply('Nothing playing.');
    }

    if (cmd === 'stop') {
      if (!await isAdminOrMod(member)) return interaction.reply({ content: 'Admin/mod required', ephemeral: true });
      const state = guildState.get(guildId);
      if (state) {
        if (state.player) state.player.stop();
        if (state.connection) {
          try { state.connection.destroy(); } catch {}
        }
        guildState.delete(guildId);
        await saveQueues();
      }
      return interaction.reply('Stopped and left voice channel.');
    }

    // -------------- Fun --------------
    if (cmd === 'rps') {
      const userChoice = interaction.options.getString('choice', true);
      const valid = ['rock','paper','scissors'];
      const bot = valid[Math.floor(Math.random() * valid.length)];
      let result = 'tie';
      if ((userChoice === 'rock' && bot === 'scissors') || (userChoice === 'paper' && bot === 'rock') || (userChoice === 'scissors' && bot === 'paper')) result='you win';
      else if (userChoice !== bot) result='you lose';
      return interaction.reply(`You: ${userChoice}\nBot: ${bot}\nResult: ${result}`);
    }
    if (cmd === 'coinflip') return interaction.reply(Math.random()<0.5 ? 'Heads' : 'Tails');
    if (cmd === 'dice') {
      const max = Math.max(1, interaction.options.getInteger('max') || 6);
      return interaction.reply(`Rolled: ${Math.floor(Math.random()*max)+1}`);
    }

    // -------------- Utility --------------
    if (cmd === 'ping') return interaction.reply('Pong! ' + Math.round(client.ws.ping) + 'ms');
    if (cmd === 'snipe') {
      const s = snipeCache.get(interaction.channelId);
      if (!s) return interaction.reply('Nothing to snipe.');
      return interaction.reply(`Last deleted by ${s.authorTag} at ${s.time}:\n${s.content}`);
    }
    if (cmd === 'pin') {
      const id = interaction.options.getString('message_id', true);
      const msg = await interaction.channel.messages.fetch(id).catch(()=>null);
      if (!msg) return interaction.reply('Message not found.');
      await msg.pin().catch(()=>null);
      return interaction.reply('Pinned message.');
    }
    if (cmd === 'unpin') {
      const id = interaction.options.getString('message_id', true);
      const msg = await interaction.channel.messages.fetch(id).catch(()=>null);
      if (!msg) return interaction.reply('Message not found.');
      await msg.unpin().catch(()=>null);
      return interaction.reply('Unpinned.');
    }
    if (cmd === 'bulkpin') {
      if (!await isAdminOrMod(member)) return interaction.reply({ content: 'Admin/mod required', ephemeral: true });
      const limit = Math.min(50, interaction.options.getInteger('limit') || 10);
      const messages = await interaction.channel.messages.fetch({ limit });
      let count = 0;
      for (const m of messages.values()) {
        try { await m.pin(); count++; } catch {}
      }
      return interaction.reply(`Pinned ${count} messages.`);
    }
    if (cmd === 'setslowmode') {
      if (!await isAdminOrMod(member)) return interaction.reply({ content: 'Admin/mod required', ephemeral: true });
      const seconds = interaction.options.getInteger('seconds', true);
      await interaction.channel.setRateLimitPerUser(seconds).catch(()=>null);
      return interaction.reply(`Set slowmode to ${seconds}s`);
    }
    if (cmd === 'remindme') {
      const timeStr = interaction.options.getString('time', true);
      const note = interaction.options.getString('note', true);
      const ms = parseTimeToMs(timeStr);
      if (!ms) return interaction.reply('Invalid time format (use e.g., 10s 5m 2h)');
      setTimeout(() => {
        interaction.user.send(`Reminder: ${note}`).catch(()=>{});
      }, ms);
      return interaction.reply(`Will remind you in ${timeStr}`);
    }
    if (cmd === 'userinfo') {
      const user = interaction.options.getUser('user') || interaction.user;
      const memb = await interaction.guild.members.fetch(user.id).catch(()=>null);
      const embed = new EmbedBuilder().setTitle(`User: ${user.tag}`).setThumbnail(user.displayAvatarURL({ size: 256 }));
      if (memb) embed.addFields({name:'Joined', value: `${memb.joinedAt || 'unknown'}`, inline:true}, {name:'ID', value: `${user.id}`, inline:true});
      return interaction.reply({ embeds: [embed] });
    }
    if (cmd === 'avatar') {
      const user = interaction.options.getUser('user') || interaction.user;
      return interaction.reply(`${user.tag}'s avatar: ${user.displayAvatarURL({ size: 512 })}`);
    }
    if (cmd === 'test') return interaction.reply('Diagnostics OK');
    if (cmd === 'setprefix') {
      if (!await isAdminOrMod(member)) return interaction.reply({ content:'Admin/mod required', ephemeral:true });
      const prefix = interaction.options.getString('prefix', true);
      persistentCache.prefixes = persistentCache.prefixes || {};
      persistentCache.prefixes[guildId] = prefix;
      await jsonbinPut(persistentCache);
      return interaction.reply(`Prefix set to ${prefix}`);
    }
    if (cmd === 'help') {
      const embed = new EmbedBuilder().setTitle('Help — Commands')
        .setDescription('All commands are slash commands. Use /command to run.');
      embed.addFields(
        {name:'Moderation', value: '/addmodrole, /removemodrole, /listmodroles, /warn, /listwarnings, /ban, /kick'},
        {name:'Music', value: '/play <url|query>, /add <url|query>, /loop, /skip, /stop'},
        {name:'Fun', value: '/rps, /coinflip, /dice'},
        {name:'Utility', value: '/ping, /snipe, /pin, /unpin, /bulkpin, /setslowmode, /remindme, /userinfo, /avatar, /test, /setprefix'}
      );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

  } catch (e) {
    console.warn('interaction handler error', e);
    if (interaction.deferred || interaction.replied) {
      interaction.editReply('Command failed (see console).');
    } else {
      interaction.reply({ content: 'Command failed (see console).', ephemeral: true });
    }
  }
});

function parseTimeToMs(str) {
  if (!str) return 0;
  const m = str.match(/^(\d+)(s|m|h)$/);
  if (!m) return 0;
  const n = Number(m[1]); const u = m[2];
  if (u === 's') return n*1000;
  if (u === 'm') return n*60*1000;
  if (u === 'h') return n*60*60*1000;
  return 0;
}

// Express health endpoint
const app = express();
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Health on ${PORT}`));

// periodic save on exit
process.on('SIGINT', async () => {
  console.log('SIGINT - saving state');
  await saveQueues().catch(e => console.warn('save on exit failed', e));
  process.exit(0);
});

// start
client.login(TOKEN);
