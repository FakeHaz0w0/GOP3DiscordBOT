// index.js
/**
 * Single-file Discord music bot (prefix commands)
 * Env required: DISCORD_TOKEN
 *
 * Commands:
 *  ?play <youtube-url>  - join your voice channel and play the URL now (or insert next)
 *  ?add <youtube-url>   - add song to the queue (played after current)
 *  ?stop                - stop, clear queue and leave voice
 *  ?loop                - toggle looping of the current song (infinite)
 *  ?queue               - show embed with Now / Next entries + basic status
 *  ?skip                - skip current track (plays next or leaves if none)
 *  ?version             - show version & uptime
 *
 * Requirements:
 *  - Node 18+ recommended
 *  - ffmpeg installed and on PATH
 *  - npm install
 *  - Run with DISCORD_TOKEN env var set
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import { Client, GatewayIntentBits, EmbedBuilder, Partials } from 'discord.js';
import { createAudioPlayer, createAudioResource, joinVoiceChannel, getVoiceConnection, AudioPlayerStatus, StreamType, VoiceConnectionStatus, entersState } from '@discordjs/voice';
import ytdl from 'ytdl-core';

const PREFIX = '?';
const VERSION = 'Bot v1.1.1 (JS)';
const START_TS = Date.now();

// --- Client init
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// --- Per-guild music player
class Track {
  constructor(title, webpage_url, stream_url, requester) {
    this.title = title;
    this.webpage_url = webpage_url;
    this.stream_url = stream_url;
    this.requester = requester;
  }
}

class MusicPlayer {
  constructor(guild) {
    this.guild = guild;
    this.queue = []; // array of Track
    this.current = null; // Track
    this.loopCurrent = false;
    this.connection = null; // voice connection
    this.player = createAudioPlayer();
    this._attached = false; // whether player subscribed to connection
    // listen for idle state to move to next
    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle) {
        // when idle, play next or loop
        this._onTrackEnd().catch(console.error);
      } else if (newState.status === AudioPlayerStatus.Playing) {
        // nothing
      }
    });
    this.player.on('error', error => {
      console.error('Audio player error:', error);
      // attempt to continue
      this._onTrackEnd().catch(console.error);
    });
  }

  async ensureVoice(member) {
    if (!member.voice || !member.voice.channel) {
      return false;
    }
    const channel = member.voice.channel;
    const existing = getVoiceConnection(this.guild.id);
    if (!existing) {
      // join
      this.connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: this.guild.id,
        adapterCreator: this.guild.voiceAdapterCreator
      });
      try {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
      } catch (err) {
        console.warn('Voice connection failed:', err);
      }
      this.connection.subscribe(this.player);
      this._attached = true;
    } else {
      this.connection = existing;
      if (!this._attached) {
        this.connection.subscribe(this.player);
        this._attached = true;
      }
      // move if different channel
      try {
        if (this.connection.joinConfig.channelId !== channel.id) {
          // there is no direct move API; we re-join new channel
          // joinVoiceChannel will reuse existing connection if same guild but different channel on some hosts; safe to call
          this.connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: this.guild.id,
            adapterCreator: this.guild.voiceAdapterCreator
          });
          if (!this._attached) this.connection.subscribe(this.player);
        }
      } catch (err) {
        console.warn('Failed to move voice:', err);
      }
    }
    return true;
  }

  async playNext() {
    // public method to force play next (used by skip)
    if (this.player.state.status === AudioPlayerStatus.Playing) {
      this.player.stop();
    } else {
      // start playback loop
      await this._onTrackEnd();
    }
  }

  async _onTrackEnd() {
    // Called when current finishes or when we need to start playing
    // If loop on and current exists => replay current
    if (this.loopCurrent && this.current) {
      await this._playTrack(this.current);
      return;
    }

    if (this.queue.length === 0) {
      this.current = null;
      // schedule disconnect after short idle
      setTimeout(() => {
        if ((this.player.state.status !== AudioPlayerStatus.Playing) && !this.loopCurrent && this.queue.length === 0) {
          const conn = getVoiceConnection(this.guild.id);
          if (conn) {
            try {
              conn.destroy();
            } catch (e) { /* ignore */ }
          }
        }
      }, 15000);
      return;
    }

    const next = this.queue.shift();
    this.current = next;
    await this._playTrack(next);
  }

  async _playTrack(track) {
    try {
      // create stream using ytdl
      const stream = ytdl(track.stream_url, {
        filter: 'audioonly',
        highWaterMark: 1 << 25,
        quality: 'highestaudio',
        requestOptions: {
          // avoid IPv6 problems in some hosts
          headers: { 'user-agent': 'discord-bot' }
        }
      });
      const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
      this.player.play(resource);
    } catch (err) {
      console.error('Error playing track', err);
      // try next
      await this._onTrackEnd();
    }
  }

  async addTrack(member, track, playNow = false) {
    // ensure voice
    const ok = await this.ensureVoice(member);
    if (!ok) throw new Error('User not in voice channel');

    if (playNow && this.player.state.status === AudioPlayerStatus.Playing) {
      // insert at head
      this.queue.unshift(track);
      // stop current to trigger next (which will be the track we inserted)
      try { this.player.stop(); } catch (e) { /* */ }
      return;
    } else {
      this.queue.push(track);
      if (this.player.state.status !== AudioPlayerStatus.Playing) {
        // nothing playing -> start
        await this._onTrackEnd();
      }
    }
  }

  async stopAndClear() {
    this.loopCurrent = false;
    this.queue = [];
    try { this.player.stop(); } catch (e) {}
    const conn = getVoiceConnection(this.guild.id);
    if (conn) {
      try { conn.destroy(); } catch (e) {}
    }
    this.current = null;
  }

  async skip() {
    if (this.player.state.status === AudioPlayerStatus.Playing) {
      this.player.stop();
    }
  }
}

// global players map
const players = new Map();
function getPlayer(guild) {
  if (!players.has(guild.id)) players.set(guild.id, new MusicPlayer(guild));
  return players.get(guild.id);
}

// --- helpers for ytdl extraction
async function extractInfo(url) {
  try {
    // ytdl-core can validate and extract info; if url is a video id or url it returns info
    const info = await ytdl.getInfo(url);
    // pick audio format URL if available. ytdl-core gives formats array
    const formats = info.formats || [];
    // prefer adaptive audio formats with highest bitrate
    const audioFormats = formats.filter(f => f.mimeType && f.mimeType.includes('audio'));
    let chosen = audioFormats[audioFormats.length - 1] || formats[0];
    const streamUrl = chosen && chosen.url ? chosen.url : info.videoDetails.video_url;
    return new Track(info.videoDetails.title, info.videoDetails.video_url, streamUrl, null);
  } catch (err) {
    // try using direct URL as fallback
    return null;
  }
}

// --- Embed UI helpers
function makeQueueEmbed(guild, player) {
  const embed = new EmbedBuilder().setTitle(VERSION).setColor(0x2f3136);
  // uptime
  const uptime_s = Math.floor((Date.now() - START_TS) / 1000);
  const h = Math.floor(uptime_s / 3600);
  const m = Math.floor((uptime_s % 3600) / 60);
  const s = uptime_s % 60;
  embed.addFields(
    { name: 'Uptime', value: `${h}h ${m}m ${s}s`, inline: true },
    { name: 'Guilds', value: `${client.guilds.cache.size}`, inline: true },
    { name: 'Node/discord.js', value: `${process.version} / ${require('discord.js').version}`, inline: false }
  );

  if (player.current) {
    let nowVal = `**${player.current.title}**\nRequested by: ${player.current.requester || '(unknown)'}`;
    if (player.loopCurrent) nowVal += '\n**Looping: ON**';
    embed.addFields({ name: 'Now', value: nowVal, inline: false });
  } else {
    embed.addFields({ name: 'Now', value: '(nothing playing)', inline: false });
  }

  if (player.queue.length > 0) {
    const lines = player.queue.slice(0, 6).map((t, i) => `\`${i+1}.\` ${t.title} — ${t.requester || '(unknown)'}`);
    if (player.queue.length > 6) lines.push(`...and ${player.queue.length - 6} more.`);
    embed.addFields({ name: 'Queue (next)', value: lines.join('\n'), inline: false });
  } else {
    embed.addFields({ name: 'Queue (next)', value: '(empty)', inline: false });
  }

  embed.setFooter({ text: `Use ${PREFIX}play ${PREFIX}add ${PREFIX}stop ${PREFIX}loop ${PREFIX}skip` });
  return embed;
}

// --- Commands handling
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const [rawCmd, ...parts] = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const arg = parts.join(' ').trim();

    // simple permission: require being in guild (not DM)
    if (!message.guild) {
      message.channel.send('Commands only available in servers.');
      return;
    }

    const player = getPlayer(message.guild);

    if (cmd === 'play') {
      if (!arg) {
        message.channel.send('Usage: ?play <youtube-url>');
        return;
      }
      if (!message.member.voice || !message.member.voice.channel) {
        message.channel.send('You must be in a voice channel to use ?play.');
        return;
      }
      await message.channel.sendTyping();
      const info = await extractInfo(arg);
      if (!info) {
        message.channel.send('Could not extract audio from that URL.');
        return;
      }
      info.requester = `${message.author.tag}`;
      // playNow semantics: insert next and stop current
      try {
        await player.addTrack(message.member, info, true);
        message.channel.send(` Will play next: **${info.title}** — requested by ${info.requester}`);
      } catch (err) {
        message.channel.send(`Error: ${err.message}`);
      }
      return;
    }

    if (cmd === 'add') {
      if (!arg) {
        message.channel.send('Usage: ?add <youtube-url>');
        return;
      }
      if (!message.member.voice || !message.member.voice.channel) {
        message.channel.send('You must be in a voice channel to use ?add.');
        return;
      }
      await message.channel.sendTyping();
      const info = await extractInfo(arg);
      if (!info) {
        message.channel.send('Could not extract audio from that URL.');
        return;
      }
      info.requester = `${message.author.tag}`;
      try {
        await player.addTrack(message.member, info, false);
        message.channel.send(`➕ Added to queue: **${info.title}** — requested by ${info.requester}`);
      } catch (err) {
        message.channel.send(`Error: ${err.message}`);
      }
      return;
    }

    if (cmd === 'stop') {
      if (!message.member.voice || !message.member.voice.channel) {
        message.channel.send('You must be in a voice channel to use ?stop.');
        return;
      }
      await player.stopAndClear();
      message.channel.send(' Stopped playback and left the voice channel.');
      return;
    }

    if (cmd === 'loop') {
      if (!player.current) {
        message.channel.send('No track is currently playing to loop.');
        return;
      }
      player.loopCurrent = !player.loopCurrent;
      message.channel.send(` Looping ${player.loopCurrent ? 'ENABLED' : 'DISABLED'} for **${player.current.title}**.`);
      return;
    }

    if (cmd === 'queue') {
      const embed = makeQueueEmbed(message.guild, player);
      message.channel.send({ embeds: [embed] });
      return;
    }

    if (cmd === 'skip') {
      if (!player.current) {
        message.channel.send('Nothing is currently playing to skip.');
        return;
      }
      await player.skip();
      message.channel.send(' Skipped current track.');
      return;
    }

    if (cmd === 'version') {
      const uptime_s = Math.floor((Date.now() - START_TS) / 1000);
      const h = Math.floor(uptime_s / 3600);
      const m = Math.floor((uptime_s % 3600) / 60);
      const s = uptime_s % 60;
      const embed = new EmbedBuilder()
        .setTitle(VERSION)
        .addFields(
          { name: 'Uptime', value: `${h}h ${m}m ${s}s`, inline: true },
          { name: 'Guilds', value: `${client.guilds.cache.size}`, inline: true },
          { name: 'Node/discord.js', value: `${process.version} / ${require('discord.js').version}`, inline: false }
        );
      message.channel.send({ embeds: [embed] });
      return;
    }
  } catch (err) {
    console.error('Command handler error:', err);
    try { message.channel.send(`Error: ${err.message}`); } catch (e) {}
  }
});

// login
const token = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN environment variable not set. Exiting.');
  process.exit(1);
}
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});
client.login(token).catch(err => {
  console.error('Login failed:', err);
  process.exit(2);
});
