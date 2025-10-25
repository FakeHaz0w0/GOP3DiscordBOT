// deploy-commands.js
import { REST, Routes } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

const commands = [
  // Moderation
  { name: 'addmodrole', description: 'Add a mod role', options: [{ name:'role', type:8, description:'Role to add', required:true }] },
  { name: 'removemodrole', description: 'Remove a mod role', options: [{ name:'role', type:8, description:'Role to remove', required:true }] },
  { name: 'listmodroles', description: 'List mod roles' },
  { name: 'warn', description: 'Warn a user', options: [{name:'user',type:6,required:true},{name:'reason',type:3,required:false}] },
  { name: 'listwarnings', description: 'List warnings for a user', options: [{name:'user',type:6,required:false}] },
  { name: 'ban', description: 'Ban a user (optional minutes for temp ban)', options: [{name:'user',type:6,required:true},{name:'minutes',type:4,required:false},{name:'reason',type:3,required:false}] },
  { name: 'kick', description: 'Kick a user', options: [{name:'user',type:6,required:true},{name:'reason',type:3,required:false}] },

  // Music
  { name: 'play', description: 'Play a URL or search terms', options: [{name:'query',type:3,description:'URL or search terms',required:true}] },
  { name: 'add', description: 'Add a song to queue', options: [{name:'query',type:3,description:'URL or search terms',required:true}] },
  { name: 'loop', description: 'Toggle loop for current track/queue' },
  { name: 'skip', description: 'Skip current track' },
  { name: 'stop', description: 'Stop playback and leave' },

  // Fun
  { name: 'rps', description: 'Play rock paper scissors', options: [{name:'choice',type:3,required:true,choices:[{name:'rock',value:'rock'},{name:'paper',value:'paper'},{name:'scissors',value:'scissors'}]}] },
  { name: 'coinflip', description: 'Flip a coin' },
  { name: 'dice', description: 'Roll 1..N', options:[{name:'max',type:4,required:false}] },

  // Utility
  { name: 'ping', description: 'Check latency' },
  { name: 'snipe', description: 'Show last deleted message in this channel' },
  { name: 'pin', description: 'Pin a message by ID', options:[{name:'message_id',type:3,required:true}] },
  { name: 'unpin', description: 'Unpin a message by ID', options:[{name:'message_id',type:3,required:true}] },
  { name: 'bulkpin', description: 'Pin the last N messages', options:[{name:'limit',type:4,required:false}] },
  { name: 'setslowmode', description: 'Set channel slowmode secs', options:[{name:'seconds',type:4,required:true}] },
  { name: 'remindme', description: 'Remind you later', options:[{name:'time',type:3,required:true},{name:'note',type:3,required:true}] },
  { name: 'userinfo', description: 'Show user info', options:[{name:'user',type:6,required:false}] },
  { name: 'avatar', description: 'Show user avatar', options:[{name:'user',type:6,required:false}] },
  { name: 'test', description: 'Diagnostics' },
  { name: 'setprefix', description: 'Set runtime prefix (for compatibility)', options:[{name:'prefix',type:3,required:true}] },

  // Help
  { name: 'help', description: 'Show command help' }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function deploy() {
  try {
    const GUILD_ID = process.env.GUILD_ID;
    const CLIENT_ID = process.env.CLIENT_ID;
    if (!GUILD_ID || !CLIENT_ID) throw new Error('Set GUILD_ID and CLIENT_ID in env.');

    console.log(`Registering ${commands.length} commands to guild ${GUILD_ID}...`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

deploy();
