# bot.py
"""
Single-file Discord music bot (prefix commands).
Commands:
  ?play <yt_url>  - join your voice channel and play the URL now (or queue)
  ?add <yt_url>   - add song to queue
  ?stop           - stop playback and leave
  ?loop           - toggle looping of current song (infinite)
Requirements:
  pip install -U discord.py yt-dlp
  ffmpeg must be installed on the system PATH
Env:
  DISCORD_BOT_TOKEN - your bot token (never commit)
"""
import os
import asyncio
import functools
from typing import List, Optional
import yt_dlp
import discord
from discord.ext import commands

INTENTS = discord.Intents.default()
INTENTS.message_content = True

PREFIX = "?"
bot = commands.Bot(command_prefix=PREFIX, intents=INTENTS)

# --- Configuration for ffmpeg & yt-dlp ---
FFMPEG_BEFORE_OPTS = "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5"
FFMPEG_OPTS = "-vn -sn -dn -hide_banner -loglevel warning"

YTDL_OPTS = {
    "format": "bestaudio/best",
    "noplaylist": True,
    "quiet": True,
    "no_warnings": True,
    "default_search": "auto",
    # don't download; return direct URL if possible
    "extract_flat": False,
}

ytdl = yt_dlp.YoutubeDL(YTDL_OPTS)

# --- MusicPlayer per-guild ---
class Track:
    def __init__(self, source_url: str, title: str, requested_by: str):
        self.source_url = source_url   # direct media url or webpage url to feed to ffmpeg
        self.title = title
        self.requested_by = requested_by

class MusicPlayer:
    def __init__(self, guild: discord.Guild):
        self.guild = guild
        self.queue: asyncio.Queue[Track] = asyncio.Queue()
        self.current: Optional[Track] = None
        self.loop_current: bool = False
        self._play_lock = asyncio.Lock()
        self.voice_client: Optional[discord.VoiceClient] = None
        self._stopping = False

    async def ensure_voice(self, ctx: commands.Context) -> bool:
        # joins the author's voice channel if not connected
        if ctx.author.voice is None or ctx.author.voice.channel is None:
            await ctx.send("You must be in a voice channel to use this command.")
            return False
        channel = ctx.author.voice.channel
        if self.voice_client is None or not self.voice_client.is_connected():
            self.voice_client = await channel.connect()
        else:
            # move if bot is in other channel
            if self.voice_client.channel.id != channel.id:
                await self.voice_client.move_to(channel)
        return True

    async def _play_next(self):
        # internal, picks next track and plays; handles looping
        async with self._play_lock:
            if self.loop_current and self.current is not None:
                # re-play the same track
                track = self.current
            else:
                if self.queue.empty():
                    # nothing left
                    self.current = None
                    # disconnect after a small delay to avoid flapping
                    await asyncio.sleep(1.0)
                    if (self.voice_client is not None and not self.voice_client.is_playing()
                            and not self.loop_current and self.queue.empty()):
                        try:
                            await self.voice_client.disconnect()
                        except Exception:
                            pass
                    return
                track = await self.queue.get()
                self.current = track

            if self.voice_client is None:
                # can't play without voice client
                return

            # Build ffmpeg source
            ffmpeg_opts = f"{FFMPEG_BEFORE_OPTS} -i \"{track.source_url}\""
            # discord.FFmpegPCMAudio takes the source as the first argument (input), and options separately
            source = discord.FFmpegPCMAudio(
                track.source_url,
                before_options=FFMPEG_BEFORE_OPTS,
                options=FFMPEG_OPTS
            )

            def after_play(error):
                if error:
                    # schedule a message about playback error
                    coro = self._announce_error(error)
                    bot.loop.create_task(coro)
                # schedule next track
                bot.loop.create_task(self._play_next())

            try:
                self.voice_client.play(source, after=after_play)
            except Exception as e:
                # If play failed, announce and attempt next
                await self._announce_error(e)
                await self._play_next()

    async def _announce_error(self, error):
        # best-effort: find a text channel to post in (system channel or first text channel)
        txt = None
        if self.guild.system_channel is not None:
            txt = self.guild.system_channel
        else:
            for ch in self.guild.text_channels:
                if ch.permissions_for(self.guild.me).send_messages:
                    txt = ch
                    break
        if txt:
            try:
                await txt.send(f"Playback error: `{error}`")
            except Exception:
                pass

    async def add_and_play(self, ctx: commands.Context, track: Track, play_now: bool = False):
        await self.ensure_voice(ctx)
        if play_now and self.voice_client and self.voice_client.is_playing():
            # insert as next by creating a temporary queue
            # simplest: put current back and then put new first -> easiest approach: create a new queue
            new_q = asyncio.Queue()
            await new_q.put(track)
            # drain old queue into new queue
            while not self.queue.empty():
                t = await self.queue.get()
                await new_q.put(t)
            self.queue = new_q
            # stop current so after callback triggers next (which will be our new track)
            self.voice_client.stop()
            return
        else:
            await self.queue.put(track)
            # if nothing playing, start
            if not (self.voice_client and self.voice_client.is_playing()):
                await self._play_next()

    async def stop_and_clear(self):
        self.loop_current = False
        # clear queue
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
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

# Global players map per guild id
players: dict[int, MusicPlayer] = {}

def get_player(guild: discord.Guild) -> MusicPlayer:
    if guild.id not in players:
        players[guild.id] = MusicPlayer(guild)
    return players[guild.id]

# --- Utilities for yt-dlp ---
async def extract_info(url: str) -> Optional[Track]:
    loop = asyncio.get_event_loop()
    try:
        # run blocking yt-dlp extraction in executor
        data = await loop.run_in_executor(None, lambda: ytdl.extract_info(url, download=False))
        # For some URLs, ytdl.extract_info returns a dict with 'url' and 'title'
        # For search results it may return entries
        if data is None:
            return None
        if 'entries' in data:
            # playlist or search; pick first
            entry = data['entries'][0]
        else:
            entry = data
        # Some extractors return 'url' as the direct media stream; otherwise use webpage_url
        source_url = entry.get('url') or entry.get('webpage_url') or entry.get('original_url')
        title = entry.get('title', 'Unknown title')
        # If source_url is just a fragment, pass the webpage_url so ffmpeg can handle it
        if not source_url:
            source_url = entry.get('webpage_url') or url
        return Track(source_url=source_url, title=title, requested_by="unknown")
    except Exception as exc:
        return None

# --- Bot commands ---
@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} (id: {bot.user.id})")

@bot.command(name="play")
async def cmd_play(ctx: commands.Context, *, url: str):
    """Play a youtube link now (or queue if already playing). Bot joins your voice channel."""
    player = get_player(ctx.guild)
    # 1) ensure user in voice
    if ctx.author.voice is None or ctx.author.voice.channel is None:
        await ctx.send("You must be in a voice channel to use ?play.")
        return

    await ctx.defer()
    info = await extract_info(url)
    if not info:
        await ctx.send("Could not extract audio from that URL.")
        return
    info.requested_by = str(ctx.author)
    # Play now semantics: if nothing playing, will start; if playing, place next (as 'play now' semantics)
    # We implement ?play to behave like: play immediately (i.e., insert next and stop current so new starts)
    # We'll call add_and_play with play_now=True
    await player.add_and_play(ctx, info, play_now=True)
    await ctx.send(f"Queued to play next: **{info.title}** (requested by {info.requested_by})")

@bot.command(name="add")
async def cmd_add(ctx: commands.Context, *, url: str):
    """Add a youtube link to the queue (plays after current track)."""
    player = get_player(ctx.guild)
    if ctx.author.voice is None or ctx.author.voice.channel is None:
        await ctx.send("You must be in a voice channel to use ?add.")
        return

    await ctx.defer()
    info = await extract_info(url)
    if not info:
        await ctx.send("Could not extract audio from that URL.")
        return
    info.requested_by = str(ctx.author)
    await player.add_and_play(ctx, info, play_now=False)
    await ctx.send(f"Added to queue: **{info.title}** (requested by {info.requested_by})")

@bot.command(name="stop")
async def cmd_stop(ctx: commands.Context):
    """Stop playback, clear queue and leave the voice channel."""
    player = get_player(ctx.guild)
    # Only allow users in a voice channel to stop
    if ctx.author.voice is None or ctx.author.voice.channel is None:
        await ctx.send("You must be in a voice channel to use ?stop.")
        return
    await player.stop_and_clear()
    await ctx.send("Stopped playback and left the voice channel.")

@bot.command(name="loop")
async def cmd_loop(ctx: commands.Context):
    """Toggle looping of the current song (infinite)."""
    player = get_player(ctx.guild)
    current = player.current
    if current is None:
        await ctx.send("No track is currently playing to loop.")
        return
    player.loop_current = not player.loop_current
    await ctx.send(f"Looping is now {'ENABLED' if player.loop_current else 'DISABLED'} for **{current.title}**.")

@bot.command(name="queue")
async def cmd_queue(ctx: commands.Context):
    """Show current queue and current track."""
    player = get_player(ctx.guild)
    lines = []
    if player.current:
        lines.append(f"**Now:** {player.current.title} — requested by {player.current.requested_by}")
    else:
        lines.append("**Now:** (nothing)")
    qlist = []
    # Can't directly iterate queue, so make a copy (unsafe if concurrent), we'll try to read ._queue attribute
    try:
        items = list(player.queue._queue)
    except Exception:
        items = []
    if items:
        for i, t in enumerate(items, start=1):
            lines.append(f"{i}. {t.title} — requested by {t.requested_by}")
    else:
        lines.append("Queue is empty.")
    await ctx.send("\n".join(lines))

# Error handling
@cmd_play.error
@cmd_add.error
@cmd_stop.error
@cmd_loop.error
async def music_command_error(ctx: commands.Context, error):
    if isinstance(error, commands.MissingRequiredArgument):
        await ctx.send("Missing required argument. Example: `?play <youtube_url>`")
    else:
        await ctx.send(f"Error: `{error}`")

# --- Run bot ---
if __name__ == "__main__":
    token = os.getenv("DISCORD_BOT_TOKEN")
    if not token:
        print("DISCORD_BOT_TOKEN environment variable not set.")
        raise SystemExit(1)
    bot.run(token)
