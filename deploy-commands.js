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
  { name: 'rps', description: 'Rock Paper Scissors', options: [{name:'choice',type:3,required:true,choices:[{name:'rock',value:'rock'},{name:'paper',value:'paper'},{name:'scissors',value:'scissors'}]}] },
  { name: 'coinflip', description: 'Flip a coin' },
  { name: 'dice', description: 'Roll 1..N', options:[{name:'max',type:4,required:false}] },

  // Utility
  { name: 'ping', description: 'Latency check' },
  { name: 'userinfo', description: 'Show user info', options:[{name:'user',type:6,required:false}] },
  { name: 'avatar', description: 'Show user avatar', options:[{name:'user',type:6,required:false}] },
  { name: 'help', description: 'Show help menu' }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!CLIENT_ID || !GUILD_ID) {
  console.error('Missing CLIENT_ID or GUILD_ID in environment');
  process.exit(1);
}

(async () => {
  try {
    console.log(`Registering ${commands.length} commands to guild ${GUILD_ID}...`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (error) {
    console.error('❌ Registration failed:', error);
  }
})();
