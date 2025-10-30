# bot.py
"""
Single-file Discord music bot (prefix commands).
Only required env var: DISCORD_TOKEN

Commands:
  ?play <youtube-url>  - join your voice channel and play the URL now (or insert next)
  ?add <youtube-url>   - add song to the queue (played after current)
  ?stop                - stop, clear queue and leave voice
  ?loop                - toggle looping of the current song (infinite)
  ?queue               - show embed with Now / Next entries + basic status
  ?skip                - skip current track (plays next or leaves if none)
  ?version             - show bot version, uptime, python/discord.py

Notes:
 - Requires: python 3.10+, ffmpeg in PATH
 - Python deps: pip install -U discord.py yt-dlp
 - Only environment dependency: DISCORD_TOKEN
"""
import os
import time
import asyncio
from typing import Optional, List
import functools
import platform
import sys
import traceback

import discord
from discord.ext import commands
import yt_dlp

# -----------------------
# CONFIG
# -----------------------
PREFIX = "?"
VERSION = "Bot v1.1.1"
INTENTS = discord.Intents.default()
INTENTS.message_content = True

# FFmpeg options (reconnect to improve stream reliability)
FFMPEG_BEFORE_OPTS = "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5"
FFMPEG_OPTS = "-vn -sn -dn -hide_banner -loglevel warning"

# YTDL config: prefer direct audio URL; use quiet to avoid noisy logs
YTDL_OPTS = {
    "format": "bestaudio/best",
    "quiet": True,
    "no_warnings": True,
    "default_search": "auto",
    "source_address": "0.0.0.0",  # force IPv4 if needed
}

ytdl = yt_dlp.YoutubeDL(YTDL_OPTS)

# -----------------------
# BOT INSTANCE
# -----------------------
bot = commands.Bot(command_prefix=PREFIX, intents=INTENTS)
START_TIME = time.time()

# -----------------------
# MUSIC CLASSES
# -----------------------
class Track:
    def __init__(self, title: str, webpage_url: str, stream_url: str, requester: str):
        self.title = title
        self.webpage_url = webpage_url
        self.stream_url = stream_url  # direct stream if available, else webpage_url
        self.requester = requester

class MusicPlayer:
    """
    Per-guild music player: own queue, current track, loop flag, voice client.
    """
    def __init__(self, guild: discord.Guild):
        self.guild = guild
        self.queue: asyncio.Queue[Track] = asyncio.Queue()
        self.current: Optional[Track] = None
        self.loop_current: bool = False
        self.voice_client: Optional[discord.VoiceClient] = None
        self._play_lock = asyncio.Lock()
        self._idle_task: Optional[asyncio.Task] = None

    async def ensure_voice(self, ctx: commands.Context) -> bool:
        """Ensure the bot is connected to the author's voice channel (joins/moves as needed)."""
        if ctx.author.voice is None or ctx.author.voice.channel is None:
            await ctx.send("You must be in a voice channel to use that command.")
            return False
        channel = ctx.author.voice.channel
        if self.voice_client is None or not self.voice_client.is_connected():
            self.voice_client = await channel.connect()
        else:
            # move to the user's channel if different
            if self.voice_client.channel.id != channel.id:
                await self.voice_client.move_to(channel)
        return True

    async def _play_next_internal(self):
        """Internal: choose next track and play it. Called sequentially by _play_next wrapper."""
        # If loop enabled and current exists, play it again
        if self.loop_current and self.current is not None:
            track = self.current
        else:
            if self.queue.empty():
                self.current = None
                # disconnect after a short idle delay
                if self._idle_task is None or self._idle_task.done():
                    self._idle_task = asyncio.create_task(self._idle_disconnect())
                return
            track = await self.queue.get()
            self.current = track

        if self.voice_client is None or not self.voice_client.is_connected():
            return

        # Build FFmpegPCMAudio source with reconnect opts
        source = discord.FFmpegPCMAudio(
            track.stream_url,
            before_options=FFMPEG_BEFORE_OPTS,
            options=FFMPEG_OPTS,
        )

        def _after(err):
            if err:
                # schedule an announcement
                coro = self._announce_error(err)
                bot.loop.create_task(coro)
            # schedule next playback
            bot.loop.create_task(self._play_next())

        try:
            self.voice_client.play(source, after=_after)
        except Exception as e:
            # playback failed; announce and try next
            await self._announce_error(e)
            await self._play_next()

    async def _play_next(self):
        """Acquire lock and call internal next to keep sequential behavior."""
        async with self._play_lock:
            await self._play_next_internal()

    async def _announce_error(self, error):
        # best-effort: find a text channel to post in (system channel or first available)
        txt = self.guild.system_channel
        if txt is None:
            for ch in self.guild.text_channels:
                if ch.permissions_for(self.guild.me).send_messages:
                    txt = ch
                    break
        if txt is None:
            return
        try:
            await txt.send(f"Playback error: `{error}`")
        except Exception:
            pass

    async def _idle_disconnect(self):
        """Wait a bit and disconnect if nothing is playing."""
        await asyncio.sleep(15)  # configurable idle timeout
        if (self.voice_client is not None and not self.voice_client.is_playing()
                and not self.loop_current and self.queue.empty()):
            try:
                await self.voice_client.disconnect()
            except Exception:
                pass
            self.voice_client = None

    async def add_track(self, ctx: commands.Context, track: Track, play_now: bool = False):
        """
        Add track to queue. If play_now True, insert it as next and stop current to begin it.
        """
        await self.ensure_voice(ctx)
        if play_now and self.voice_client and self.voice_client.is_playing():
            # put the new track at head by creating a new queue with it first
            new_q = asyncio.Queue()
            await new_q.put(track)
            # drain old queue into new queue
            while not self.queue.empty():
                t = await self.queue.get()
                await new_q.put(t)
            self.queue = new_q
            # stop current to trigger after callback -> next will be our new track
            try:
                self.voice_client.stop()
            except Exception:
                pass
            return
        else:
            await self.queue.put(track)
            # if nothing playing start
            if not (self.voice_client and self.voice_client.is_playing()):
                await self._play_next()

    async def stop_and_clear(self):
        """Stop playback, clear queue and disconnect."""
        self.loop_current = False
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except Exception:
                break
        if self.voice_client:
            try:
                self.voice_client.stop()
            except Exception:
                pass
            try:
                await self.voice_client.disconnect()
            except Exception:
                pass
            self.voice_client = None
        self.current = None

    async def skip_current(self):
        """Stop current; after callback will play next (or disconnect)."""
        if self.voice_client and self.voice_client.is_playing():
            self.voice_client.stop()

# Global players by guild id
players: dict[int, MusicPlayer] = {}

def get_player(guild: discord.Guild) -> MusicPlayer:
    if guild.id not in players:
        players[guild.id] = MusicPlayer(guild)
    return players[guild.id]

# -----------------------
# YT-DLP helpers
# -----------------------
async def extract_track(url: str, requester: str) -> Optional[Track]:
    """
    Use yt-dlp to extract direct audio stream and metadata.
    Returns Track or None on failure.
    This runs blocking extraction in executor.
    """
    loop = asyncio.get_event_loop()

    def _extract():
        try:
            data = ytdl.extract_info(url, download=False)
            return data
        except Exception:
            # try a safer approach: run with -i to reduce fatal on some errors
            try:
                return ytdl.extract_info(url, download=False)
            except Exception:
                return None

    data = await loop.run_in_executor(None, _extract)
    if not data:
        return None

    # if playlist or search result, pick first entry
    if "entries" in data and data["entries"]:
        entry = data["entries"][0]
    else:
        entry = data

    # attempt to get best stream URL
    stream_url = None
    # prefer explicit 'url' (could be direct stream)
    stream_url = entry.get("url")
    if not stream_url:
        # fallback to first format url
        formats = entry.get("formats") or []
        if formats:
            # pick audio-only best format if possible
            # choose highest abr or filesize
            audio_formats = [f for f in formats if f.get("acodec") != "none"]
            if audio_formats:
                # choose best by bitrate or preference from yt-dlp ordering
                stream_url = audio_formats[-1].get("url") or audio_formats[0].get("url")
            else:
                stream_url = formats[0].get("url")
    if not stream_url:
        # fallback to webpage_url; ffmpeg may handle it
        stream_url = entry.get("webpage_url") or url

    title = entry.get("title") or "Unknown title"
    return Track(title=title, webpage_url=entry.get("webpage_url") or url, stream_url=stream_url, requester=requester)

# -----------------------
# EMBED/UI helpers
# -----------------------
def make_queue_embed(guild: discord.Guild, player: MusicPlayer) -> discord.Embed:
    """Return an embed resembling the UI in your screenshot: black/dark, fields for Now, Queue, Uptime, Guilds."""
    embed = discord.Embed(title=VERSION, color=discord.Color.dark_grey())
    # Uptime
    uptime_s = int(time.time() - START_TIME)
    h, m = divmod(uptime_s, 3600)
    m, s = divmod(m, 60)
    uptime_str = f"{h}h {m}m {s}s"

    embed.add_field(name="Uptime", value=uptime_str, inline=True)
    embed.add_field(name="Guilds", value=str(len(bot.guilds)), inline=True)

    # Python/discord.py
    py_ver = f"{platform.python_version()}"
    discord_py = discord.__version__
    embed.add_field(name="Python/discord.py", value=f"{py_ver} / {discord_py}", inline=False)

    # Now playing
    if player.current:
        now_val = f"**{player.current.title}**\nRequested by: {player.current.requester}"
        if player.loop_current:
            now_val += "\n**Looping: ON**"
    else:
        now_val = "(nothing playing)"
    embed.add_field(name="Now", value=now_val, inline=False)

    # Queue (show up to 6 next)
    items = []
    try:
        qlist = list(player.queue._queue)  # small internal exposure; acceptable for UI snapshot
    except Exception:
        qlist = []
    if qlist:
        for i, t in enumerate(qlist[:6], start=1):
            items.append(f"`{i}.` {t.title} — {t.requester}")
        if len(qlist) > 6:
            items.append(f"...and {len(qlist)-6} more.")
        embed.add_field(name="Queue (next)", value="\n".join(items), inline=False)
    else:
        embed.add_field(name="Queue (next)", value="(empty)", inline=False)

    embed.set_footer(text=f"Use {PREFIX}play {PREFIX}add {PREFIX}stop {PREFIX}loop {PREFIX}skip")
    return embed

# -----------------------
# COMMANDS
# -----------------------
@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} (id: {bot.user.id})")

@bot.command(name="play")
async def cmd_play(ctx: commands.Context, *, url: str):
    """Play a youtube link now (inserts as next and plays immediately)."""
    player = get_player(ctx.guild)
    if ctx.author.voice is None or ctx.author.voice.channel is None:
        await ctx.send("You must be in a voice channel to use ?play.")
        return
    await ctx.defer()
    track = await extract_track(url, requester=str(ctx.author))
    if not track:
        await ctx.send("Could not extract audio from that URL.")
        return
    # insert next and stop current so new starts now
    await player.add_track(ctx, track, play_now=True)
    await ctx.send(f"🎶 Will play next: **{track.title}** — requested by {track.requester}")

@bot.command(name="add")
async def cmd_add(ctx: commands.Context, *, url: str):
    """Add a youtube link to the queue to play after the current track."""
    player = get_player(ctx.guild)
    if ctx.author.voice is None or ctx.author.voice.channel is None:
        await ctx.send("You must be in a voice channel to use ?add.")
        return
    await ctx.defer()
    track = await extract_track(url, requester=str(ctx.author))
    if not track:
        await ctx.send("Could not extract audio from that URL.")
        return
    await player.add_track(ctx, track, play_now=False)
    await ctx.send(f"➕ Added to queue: **{track.title}** — requested by {track.requester}")

@bot.command(name="stop")
async def cmd_stop(ctx: commands.Context):
    """Stop playback, clear queue, and leave the voice channel."""
    player = get_player(ctx.guild)
    if ctx.author.voice is None or ctx.author.voice.channel is None:
        await ctx.send("You must be in a voice channel to use ?stop.")
        return
    await player.stop_and_clear()
    await ctx.send("⏹️ Stopped playback and left the voice channel.")

@bot.command(name="loop")
async def cmd_loop(ctx: commands.Context):
    """Toggle looping of the current song (infinite)."""
    player = get_player(ctx.guild)
    if player.current is None:
        await ctx.send("No track is currently playing to loop.")
        return
    player.loop_current = not player.loop_current
    await ctx.send(f"🔁 Looping {'ENABLED' if player.loop_current else 'DISABLED'} for **{player.current.title}**.")

@bot.command(name="queue")
async def cmd_queue(ctx: commands.Context):
    """Show queue embed with now and next tracks (styled)."""
    player = get_player(ctx.guild)
    embed = make_queue_embed(ctx.guild, player)
    await ctx.send(embed=embed)

@bot.command(name="skip")
async def cmd_skip(ctx: commands.Context):
    """Skip the current track (plays next or disconnects)."""
    player = get_player(ctx.guild)
    if player.current is None:
        await ctx.send("Nothing is currently playing to skip.")
        return
    await player.skip_current()
    await ctx.send("⏭️ Skipped current track.")

@bot.command(name="version")
async def cmd_version(ctx: commands.Context):
    """Show version & uptime info."""
    uptime_s = int(time.time() - START_TIME)
    h, rem = divmod(uptime_s, 3600)
    m, s = divmod(rem, 60)
    embed = discord.Embed(title=VERSION)
    embed.add_field(name="Uptime", value=f"{h}h {m}m {s}s", inline=True)
    embed.add_field(name="Guilds", value=str(len(bot.guilds)), inline=True)
    embed.add_field(name="Python/discord.py", value=f"{platform.python_version()} / {discord.__version__}", inline=False)
    await ctx.send(embed=embed)

# Generic errors for music commands
@cmd_play.error
@cmd_add.error
@cmd_stop.error
@cmd_loop.error
@cmd_queue.error
@cmd_skip.error
async def _music_error(ctx: commands.Context, error):
    if isinstance(error, commands.MissingRequiredArgument):
        await ctx.send(f"Missing argument. Example: `{PREFIX}play <youtube_url>`")
    else:
        # log for debugging
        tb = "".join(traceback.format_exception(type(error), error, error.__traceback__))
        print("Command error:", tb, file=sys.stderr)
        await ctx.send(f"Error: `{error}`")

# -----------------------
# BOOT
# -----------------------
if __name__ == "__main__":
    token = os.getenv("DISCORD_TOKEN")
    if not token:
        print("ERROR: DISCORD_TOKEN environment variable not set. Exiting.", file=sys.stderr)
        raise SystemExit(1)
    # Run the bot
    bot.run(token)
