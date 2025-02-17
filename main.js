require('dotenv').config();

const { Client } = require('discord.js-selfbot-v13');
const fsSync = require('fs');
const path = require('path');
const express = require('express');
const app = express();
const os = require('os');
const port = 8321;
const fetch = require('node-fetch');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { Blob } = require('blob-polyfill');
const { pipeline } = require('stream');
const { promisify } = require('util');
const streamPipeline = promisify(pipeline);
const fs = require('fs').promises; // Regular fs module for streams
const fsPromises = require('fs').promises; // Promisified fs for async/await
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cliProgress = require('cli-progress');
const chalk = require('chalk'); // Add chalk for colored text
const figlet = require('figlet'); // Add figlet for ASCII art
const multer = require('multer');
const upload = multer({ dest: 'uploads/' }); // Temporary storage for uploaded files
const WorkerPool = require('./workerPool');

// For Bun, just use a fixed number of workers since os module isn't fully supported
const messagePool = new WorkerPool('./messageWorker.js', 2); // Use fixed value of 2 workers
const downloadPool = new WorkerPool('./messageWorker.js', 2); // Use fixed value of 2 workers

// Constants
const RATE_LIMIT_DELAY = 1000; // 1 second delay between messages
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 5000; // 5 seconds
const PORT = 8321; // Add port constant

// Helper Functions
function logToConsole(message) {
    console.log(chalk.blue(`[Server] ${message}`));
}

// Ensure directory exists
function ensureDirectoryExists(dirPath) {
    if (!fsSync.existsSync(dirPath)) {
        fsSync.mkdirSync(dirPath, { recursive: true });
        console.log(chalk.green(`Created directory: ${dirPath}`));
    }
}

// Initialize required directories
function initializeDirectories() {
    const dirs = [
        path.join(__dirname, 'backups'),
        path.join(__dirname, 'uploads'),
        path.join(__dirname, 'attachments')
    ];

    dirs.forEach(dir => ensureDirectoryExists(dir));
}

// Display a welcome message with ASCII art
console.log(chalk.blue(figlet.textSync('Midoribot', { horizontalLayout: 'full' })));
console.log(chalk.green('Starting Midoribot...'));

// Read the backup file
const client = new Client();
client.login(process.env.DISCORD_TOKEN)
    .then(() => console.log(chalk.green('Logged in successfully')))
    .catch(err => console.error(chalk.red('Failed to login:', err)));

app.use(express.json({ limit: '500000mb' })); 
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Ensure backup directory exists
function ensureBackupDirectoryExists() {
  const backupDirectory = path.join(__dirname, 'backups');
  if (!fsSync.existsSync(backupDirectory)) {
    fsSync.mkdirSync(backupDirectory, { recursive: true });
  }
}

// Ensure attachments directory exists
function ensureAttachmentsDirectoryExists(backupId) {
  const attachmentsDirectory = path.join(__dirname, 'attachments', backupId);
  if (!fsSync.existsSync(attachmentsDirectory)) {
    fsSync.mkdirSync(attachmentsDirectory, { recursive: true });
  }
}

// Fetch messages with retry logic
async function fetchWithRetry(channel, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const messages = await channel.messages.fetch(options);
      return messages;
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      await delay(5000); // Wait 5 seconds before retrying
    }
  }
  throw new Error(`Failed to fetch messages after ${retries} attempts`);
}

// Restore DMs
async function restoreDM(backupFilePath, targetChannelId) {
  try {
    // Fetch the target channel
    const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    // Read the backup file
    const backupData = JSON.parse(await fsPromises.readFile(backupFilePath, { encoding: 'utf-8' }));

    // Create a webhook with the bot's avatar
    const webhook = await channel.createWebhook('Restore Bot', {
      avatar: client.user.displayAvatarURL(), // Use the bot's avatar
    });

    // Restore messages
    for (const messageBackup of backupData.messages) {
      try {
        // Ensure message content is not empty
        let content = messageBackup.content || ' '; // Use a space if content is empty

        // Send the message using the webhook
          await webhook.send({
            content: content,
            username: messageBackup.author.username, // Set the original username
          avatarURL: client.user.displayAvatarURL(), // Use the bot's avatar
        });

        // Handle attachments
        for (const att of messageBackup.attachments) {
          await webhook.send({
            content: `Attachment: ${att.url}`,
            username: messageBackup.author.username,
            avatarURL: client.user.displayAvatarURL(), // Use the bot's avatar
          });
        }
      } catch (error) {
        console.error(`Error restoring message from ${messageBackup.author.username}:`, error.message);
      }
    }

    console.log(`Restored DM backup to channel ${channel.id}`);
  } catch (error) {
    console.error('Error while restoring:', error.message);
    throw error; // Rethrow the error to handle it in the route
  }
}

// Backup all DMs
async function backupAllDMs() {
  const dmBackup = [];

  // Fetch all DM channels
  const dmChannels = client.channels.cache.filter(
    (channel) => channel.type === 'DM' || channel.type === 'GROUP_DM'
  );

  // Backup each DM channel
  for (const channel of dmChannels.values()) {
    const channelBackup = await backupChannel(channel, 'dms');
    dmBackup.push(channelBackup);
  }

  // Save the backup to a file
  ensureBackupDirectoryExists();
    const backupFilePath = path.join(__dirname, 'backups', 'dms-backup.json');
    await fsPromises.writeFile(backupFilePath, JSON.stringify(dmBackup, null, 2), 'utf-8');
    console.log(`DMs backup saved to ${backupFilePath}`);
    return dmBackup;
}

async function backupGuild() {
    const guildId = prompt('Enter the guild ID to back up:');
    const backupId = `guild-${Date.now()}`;

    if (!guildId) {
        alert('Please provide a guild ID.');
        return;
    }

    try {
        const response = await fetch('/backup-guild', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guildId, backupId }),
        });

        const data = await response.json();
        if (response.ok) {
            alert(data.message);
        } else {
            alert(`Backup failed: ${data.error}`);
        }
    } catch (error) {
        alert(`Backup failed: ${error.message}`);
    }
}

async function backupItem(id, type) {
    logToConsole(`Starting backup for ${type} ${id}...`);
    try {
        if (type === 'dm') {
            const backupId = generateBackupId();
            const response = await fetch('/backup-dm', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    channelId: id,
                    backupId: backupId 
                })
            });
            const data = await response.json();
            if (response.ok) {
                logToConsole(data.message);
            } else {
                logToConsole(`Backup failed: ${data.error}`, true);
            }
        } else if (type === 'guild') {
            const backupId = generateBackupId();
            const response = await fetch('/backup-guild', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    guildId: id,
                    backupId: backupId 
                })
            });
            const data = await response.json();
            if (response.ok) {
                logToConsole(data.message);
            } else {
                logToConsole(`Backup failed: ${data.error}`, true);
            }
        } else {
            logToConsole(`Unsupported backup type: ${type}`, true);
        }
    } catch (error) {
        logToConsole(`Backup failed: ${error.message}`, true);
    }
}

// Backup Guild
app.post('/backup-guild', async (req, res) => {
    const { guildId, backupId } = req.body;

    if (!guildId || !backupId) {
        return res.status(400).json({ error: 'Missing guildId or backupId' });
    }

    try {
        // Fetch the guild
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        // Fetch guild data
        const guildBackup = {
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL(),
            channels: [],
            roles: [],
        };

        // Fetch roles
        guild.roles.cache.forEach(role => {
            guildBackup.roles.push({
                id: role.id,
                name: role.name,
                permissions: role.permissions.bitfield.toString(),
            });
        });

        // Fetch channels
        for (const channel of guild.channels.cache.values()) {
            if (['GUILD_TEXT', 'GUILD_NEWS'].includes(channel.type)) {
                const channelBackup = await backupChannel(channel, backupId);
                guildBackup.channels.push(channelBackup);
            }
        }

        // Ensure the backups directory exists
        ensureBackupDirectoryExists();

        // Save the backup file
        const backupFilePath = path.join(__dirname, 'backups', `backup-${backupId}.json`);
        await fsPromises.writeFile(backupFilePath, JSON.stringify(guildBackup, null, 2));
        console.log(`Backup saved to ${backupFilePath}`);

        res.status(200).json({ message: 'Guild backup successful!', backupId });
    } catch (error) {
        console.error(`Error backing up guild ${guildId}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to get next backup number for a directory
async function getNextBackupNumber(baseDir) {
  try {
    await fs.mkdir(baseDir, { recursive: true });
    const files = await fs.readdir(baseDir);
    const backupNumbers = files
      .filter(f => f.match(/^[a-z0-9_]+-\d+$/)) // Match server-name-number format
      .map(f => parseInt(f.match(/-(\d+)$/)?.[1] || '0'));
    return Math.max(0, ...backupNumbers) + 1;
  } catch (error) {
    console.error(`Error getting next backup number: ${error.message}`);
    return 1;
  }
}

// Helper function to ensure backup directories exist
async function ensureBackupDirectories(type, name) {
  const baseDir = path.join(__dirname, 'backups', type);
  await fs.mkdir(baseDir, { recursive: true });
  
  const backupNumber = await getNextBackupNumber(baseDir);
  const backupDir = path.join(baseDir, `${name}-${backupNumber}`);
  const attachmentsDir = path.join(backupDir, 'attachments');
  
  await fs.mkdir(backupDir, { recursive: true });
  await fs.mkdir(attachmentsDir, { recursive: true });
  
  return { 
    baseDir, 
    backupDir,
    attachmentsDir,
    backupNumber 
  };
}

// Route to download the backup file
app.get('/download/:type/:backupId', async (req, res) => {
    const { type, backupId } = req.params;
    const backupPath = path.join(__dirname, 'backups', type, backupId, 'backup.json');
    
    try {
        // Check if file exists
        await fs.access(backupPath);
        
        // Set appropriate headers for file download
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=${backupId}-backup.json`);
        
        // Stream the file to the response
        const fileStream = fsSync.createReadStream(backupPath);
        fileStream.pipe(res);
        
        // Handle errors during streaming
        fileStream.on('error', (error) => {
            console.error(chalk.red('Error streaming backup file:', error));
            if (!res.headersSent) {
                res.status(500).send('Error downloading file');
            }
        });
    } catch (error) {
        console.error(chalk.red(`Backup file not found: ${backupPath}`));
        res.status(404).send('Backup file not found');
    }
});

// Update backupDMChannel function
async function backupDMChannel(channel) {
  try {
    const isGroupDM = channel.type === 'GROUP_DM';
    const channelName = isGroupDM ? 
      (channel.name || channel.recipients.map(r => r.username).join('-')) : 
      (channel.recipient?.username || 'unknown_user');

    console.log(chalk.green(`Starting backup for ${isGroupDM ? 'Group DM' : 'DM'} with ${channelName}`));

    const { baseDir, backupDir, attachmentsDir, backupNumber } = await ensureBackupDirectories('users', channelName);
    const backupFileName = 'backup.json';
    
    console.log(chalk.green(`Created backup directory: ${backupDir}`));
    console.log(chalk.green(`Created attachments directory: ${attachmentsDir}`));
    
    // Fetch messages using worker pool
    const result = await messagePool.executeTask({
      type: 'fetchMessages',
      data: {
        channelId: channel.id,
        token: process.env.DISCORD_TOKEN
      }
    });

    if (result.error) {
      throw new Error(result.error);
    }

    const messages = result.messages;
    console.log(chalk.green(`Successfully fetched ${messages.length} messages`));

    const backupData = [];
    
    // Process messages in batches
    const batchSize = 10;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      const batchPromises = batch.map(async (msg) => {
        const messageData = {
          author: msg.author.username,
          content: msg.content,
          authorAvatar: typeof msg.author.displayAvatarURL === 'function' 
            ? msg.author.displayAvatarURL({ format: 'png', dynamic: true, size: 1024 })
            : msg.author.avatar || null,
          attachments: [],
          timestamp: msg.createdTimestamp,
          isGroupDM: isGroupDM,
          recipients: isGroupDM ? channel.recipients.map(r => ({
            id: r.id,
            username: r.username,
            avatar: typeof r.displayAvatarURL === 'function'
              ? r.displayAvatarURL({ format: 'png', dynamic: true, size: 1024 })
              : r.avatar || null
          })) : null
        };

        // Download attachments in parallel
        if (msg.attachments.size > 0) {
          const attachmentPromises = Array.from(msg.attachments.values()).map(async (att) => {
            const cleanFilename = getCleanFilenameAndExt(att.url, att.name);
            const filePath = path.join(attachmentsDir, cleanFilename);
            
            const downloadResult = await downloadPool.executeTask({
              type: 'downloadAttachment',
              data: {
                url: att.url,
                savePath: filePath
              }
            });

            if (downloadResult.success) {
              return {
                originalUrl: att.url,
                filename: att.name,
                localPath: path.relative(backupDir, filePath),
                size: att.size,
                contentType: att.contentType
              };
            }
            return null;
          });

          messageData.attachments = (await Promise.all(attachmentPromises)).filter(att => att !== null);
        }

        return messageData;
      });

      const batchResults = await Promise.all(batchPromises);
      backupData.push(...batchResults);
      
      // Add a small delay between batches to prevent rate limiting
      await delay(RATE_LIMIT_DELAY);
    }

    // Save backup data
    const backupPath = path.join(backupDir, backupFileName);
    await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2));
    
    console.log(chalk.green(`Backup saved to ${backupPath}`));
    
    return {
      path: backupPath,
      type: 'users',
      name: channelName,
      backupNumber: backupNumber,
      backupId: backupFileName
    };
  } catch (error) {
    console.error(chalk.red(`Error in backupDMChannel: ${error.message}`));
    throw error;
  }
}

// Update backupChannel function for server channels
async function backupChannel(channel, backupId) {
  const channelBackup = {
    id: channel.id,
    name: channel.name || 'DM Channel',
    type: channel.type,
    messages: [],
    threads: [],
  };

  try {
    if (['GUILD_STAGE_VOICE', 'GUILD_VOICE'].includes(channel.type)) {
      console.log(`Skipping unsupported channel type: ${channel.name} (${channel.type})`);
      return channelBackup;
    }

    const serverName = channel.guild ? channel.guild.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() : 'unknown_server';
    const { baseDir, attachmentsDir } = await ensureBackupDirectories('servers', serverName);
    const backupNumber = await getNextBackupNumber(baseDir);
    const backupFileName = `backup-${backupNumber}.json`;

    // For DMs, always allow backup
    if (channel.type === 'DM') {
      console.log(`Backing up DM with user: ${channel.recipient.username} (${channel.id})`);
    } else {
      // Check permissions for guild channels
      if (!channel.permissionsFor(channel.guild.members.me).has('VIEW_CHANNEL') || 
          !channel.permissionsFor(channel.guild.members.me).has('READ_MESSAGE_HISTORY')) {
        console.log(`Skipping channel due to missing permissions: ${channel.name} (${channel.id})`);
        return channelBackup;
      }
    }

    // Backup messages
    let lastMessageId = null;
    let hasMoreMessages = true;
    let totalMessagesFetched = 0;

    while (hasMoreMessages) {
      const options = { limit: 100 };
      if (lastMessageId) options.before = lastMessageId;

      const messages = await fetchWithRetry(channel, options);
      if (!messages || messages.size === 0) {
        hasMoreMessages = false;
        break;
      }

      for (const message of messages.values()) {
        const messageBackup = {
          content: message.content,
          author: message.author.username,
          authorAvatar: message.author.displayAvatarURL({ format: 'png', dynamic: true, size: 1024 }),
          timestamp: message.createdTimestamp,
          attachments: [],
        };

        // Handle attachments
        for (const att of message.attachments.values()) {
          const cleanFilename = getCleanFilenameAndExt(att.url, att.name);
          const filePath = path.join(attachmentsDir, cleanFilename);
          
          // Download the attachment
          if (await downloadAttachment(att.url, filePath, att.name)) {
            messageBackup.attachments.push({
              originalUrl: att.url,
              filename: att.name,
              localPath: path.relative(baseDir, filePath),
              size: att.size,
              contentType: att.contentType
            });
          }
        }

        channelBackup.messages.push(messageBackup);
        totalMessagesFetched++;
      }

      lastMessageId = messages.last().id;
      await delay(RATE_LIMIT_DELAY);
    }

    console.log(`Total messages fetched in channel ${channel.name}: ${totalMessagesFetched}`);

    // Backup threads (if the channel supports threads)
    if (['GUILD_TEXT', 'GUILD_NEWS', 'GUILD_FORUM'].includes(channel.type)) {
      try {
        const threads = await channel.threads.fetchActive();
        if (threads) {
          for (const thread of threads.threads.values()) {
            try {
              const threadBackup = await backupChannel(thread, backupId);
              channelBackup.threads.push(threadBackup);
            } catch (error) {
              console.error(`Error backing up thread ${thread.name} (${thread.id}):`, error.message);
            }
          }
        }
      } catch (error) {
        if (error.code !== 50001) { // Ignore "Missing Access" errors
          console.error(`Error fetching threads in channel ${channel.id}:`, error.message);
        }
      }
    }

    // Save the backup
    const backupPath = path.join(baseDir, backupFileName);
    await fs.writeFile(backupPath, JSON.stringify(channelBackup, null, 2));
    console.log(chalk.green(`Channel backup saved to ${backupPath}`));
    console.log(chalk.green(`Channel attachments saved to ${attachmentsDir}`));
    
    return {
      path: backupPath,
      type: 'servers',
      name: serverName,
      backupId: backupFileName
    };
  } catch (error) {
    console.error(chalk.red(`Error backing up channel ${channel.id}: ${error.message}`));
    return channelBackup;
  }
}

// Backup a guild
async function backupGuild(guild) {
    const backupId = `guild-${guild.id}`;
    let guildBackup = {
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL(),
        memberCount: guild.memberCount,
        verificationLevel: guild.verificationLevel,
        defaultMessageNotifications: guild.defaultMessageNotifications,
        explicitContentFilter: guild.explicitContentFilter,
        afkChannelId: guild.afkChannelId,
        afkTimeout: guild.afkTimeout,
        systemChannelId: guild.systemChannelId,
        features: guild.features,
        roles: [],
        categories: [],
        channels: [],
    };

    // Backup roles
    guild.roles.cache.forEach((role) => {
        guildBackup.roles.push({
            id: role.id,
            name: role.name,
            color: role.color,
            permissions: role.permissions.bitfield.toString(),
        });
    });

    // Backup categories
    guild.channels.cache
        .filter((channel) => channel.type === 'GUILD_CATEGORY')
        .forEach((category) => {
            guildBackup.categories.push({
                id: category.id,
                name: category.name,
                position: category.position,
            });
        });

    // Backup channels (parallel processing)
    const channels = guild.channels.cache.filter((channel) =>
        ['GUILD_TEXT', 'GUILD_NEWS', 'GUILD_FORUM', 'GUILD_PUBLIC_THREAD', 'GUILD_PRIVATE_THREAD'].includes(channel.type)
    );

    // Initialize progress bar
    const progressBar = new cliProgress.SingleBar(
        {
            format: 'Backup Progress | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} Channels',
        },
        cliProgress.Presets.shades_classic
    );

    progressBar.start(channels.size, 0);

    // Process channels in parallel
    await Promise.all(channels.map(async (channel) => {
        try {
            const channelBackup = await backupChannel(channel, backupId);
            channelBackup.parentId = channel.parentId; // Add category ID
            guildBackup.channels.push(channelBackup);
        } catch (error) {
            console.error(`Error backing up channel ${channel.name} (${channel.id}):`, error.message);
        }

        // Update progress bar
        progressBar.increment();
    }));

    progressBar.stop();

    // Save the backup to a file
    const backupDir = path.join(__dirname, 'backups');
    await fs.mkdir(backupDir, { recursive: true }); // Ensure the backup directory exists
    const backupFilePath = path.join(backupDir, `backup-${backupId}.json`);
    await fs.writeFile(backupFilePath, JSON.stringify(guildBackup, null, 2), 'utf-8');
    console.log(`Backup saved to ${backupFilePath}`);
}


async function restoreGuild(backupFilePath, targetGuildId, clearServerBeforeRestore = true, restoreSettings = true) {
  try {
    // Fetch the target guild
    const guild = await client.guilds.fetch(targetGuildId).catch((error) => {
      console.error('Error fetching guild:', error.message);
      throw new Error('Guild not found. Ensure the bot is added to the server.');
    });

    if (!guild) {
      throw new Error('Guild not found. Ensure the bot is added to the server.');
    }

    console.log(`Found guild: ${guild.name}`);

    // Read the backup file
    const backupData = JSON.parse(await fs.promises.readFile(backupFilePath, { encoding: 'utf-8' }));

    // Clear the server before restoring (if enabled)
    if (clearServerBeforeRestore) {
      console.log('Clearing server...');
      await clearServer(guild);
    }

    // Restore server settings (if enabled)
    if (restoreSettings) {
      console.log('Restoring server settings...');
      try {
        await guild.setName(backupData.name);
        if (backupData.icon) {
          const iconResponse = await fetch(backupData.icon);
          const iconBuffer = await iconResponse.buffer();
          await guild.setIcon(iconBuffer);
        }
        await guild.setVerificationLevel(backupData.verificationLevel);
        await guild.setDefaultMessageNotifications(backupData.defaultMessageNotifications);
        await guild.setExplicitContentFilter(backupData.explicitContentFilter);
        await guild.setAFKTimeout(backupData.afkTimeout);
        console.log('Server settings restored.');
      } catch (error) {
        console.error('Error restoring server settings:', error.message);
      }
    }

    // Restore roles
    const roleMap = new Map(); // Map old role IDs to new ones
    for (const roleBackup of backupData.roles) {
      try {
        const newRole = await guild.roles.create({
          name: roleBackup.name,
          color: roleBackup.color,
          permissions: BigInt(roleBackup.permissions),
          hoist: roleBackup.hoist,
          mentionable: roleBackup.mentionable,
        });
        roleMap.set(roleBackup.id, newRole.id); // Map old ID to new ID
        console.log(`Restored role: ${roleBackup.name}`);
      } catch (error) {
        console.error(`Error restoring role ${roleBackup.name}:`, error.message);
      }
    }

    // Restore categories
    const categoryMap = new Map(); // Map old category IDs to new ones
    for (const categoryBackup of backupData.categories) {
      try {
        const newCategory = await guild.channels.create(categoryBackup.name, {
          type: 'GUILD_CATEGORY',
          position: categoryBackup.position,
        });
        categoryMap.set(categoryBackup.id, newCategory.id); // Map old ID to new ID
        console.log(`Restored category: ${categoryBackup.name}`);
      } catch (error) {
        console.error(`Error restoring category ${categoryBackup.name}:`, error.message);
      }
    }

    // Restore channels and messages
    for (const channelBackup of backupData.channels) {
      try {
        const channel = await guild.channels.create(channelBackup.name, {
          type: channelBackup.type,
          parent: categoryMap.get(channelBackup.parentId), // Use mapped category ID
          topic: channelBackup.topic,
          nsfw: channelBackup.nsfw,
          rateLimitPerUser: channelBackup.rateLimitPerUser,
        });

        console.log(`Restored channel: ${channelBackup.name}`);

        // Reverse the order of messages to restore them in the correct chronological order
        channelBackup.messages.reverse();

        // Restore messages
        for (const messageBackup of channelBackup.messages) {
          try {
            // Handle attachments
            if (messageBackup.attachments.length > 0) {
              for (const attachment of messageBackup.attachments) {
                const filePath = path.join(__dirname, 'attachments', backupData.id, `${attachment.id}.${attachment.extension}`);
                if (fs.existsSync(filePath)) {
                  await channel.send({
                    content: `**${messageBackup.author.username}:** (Attachment)`,
                    files: [{
                      attachment: filePath,
                      name: attachment.filename,
                    }],
                  });
                } else {
                  console.error(`Attachment not found: ${filePath}`);
                }
              }
            }

            // Handle normal messages through the webhook
            if (messageBackup.content) {
              await channel.send(messageBackup.content);
            }
          } catch (error) {
            console.error(`Error restoring message in channel ${channelBackup.name}:`, error.message);
          }
        }
      } catch (error) {
        console.error(`Error restoring channel ${channelBackup.name}:`, error.message);
      }
    }

    console.log(`Restored guild ${guild.name} from backup.`);
  } catch (error) {
    console.error('Error while restoring:', error.message);
    throw error; // Rethrow the error to handle it in the route
  }
}

// Clear a server
async function clearServer(guild) {
    // Delete all channels
    for (const channel of guild.channels.cache.values()) {
        try {
            await channel.delete();
        } catch (error) {
            console.error(`Error deleting channel ${channel.name}:`, error.message);
        }
    }

    // Delete all roles (except @everyone)
    for (const role of guild.roles.cache.values()) {
        if (role.name === '@everyone') continue;
        try {
            await role.delete();
        } catch (error) {
            console.error(`Error deleting role ${role.name}:`, error.message);
        }
    }
}

app.get('/backup/:backupId', async (req, res) => {
    const backupId = req.params.backupId;
    const backupFilePath = path.join(__dirname, 'backups', backupId);

    if (!fsSync.existsSync(backupFilePath)) {
        return res.status(404).send('Backup file not found');
    }

    const backupData = await fs.readFile(backupFilePath, 'utf-8');
    res.send(backupData);
});

app.post('/backup/:backupId', async (req, res) => {
    const backupId = req.params.backupId;
    const { backupData } = req.body;

    if (!backupData) {
        return res.status(400).json({ error: 'Missing backup data' });
    }

    const backupFilePath = path.join(__dirname, 'backups', backupId);

    try {
        await fs.writeFile(backupFilePath, backupData, 'utf-8');
        res.status(200).json({ message: 'Backup file saved successfully!' });
    } catch (error) {
        console.error('Error saving backup file:', error.message);
        res.status(500).json({ error: 'Error saving backup file' });
    }
});

// Route to handle restore from uploaded file
app.post('/restore-from-file', upload.single('backupFile'), async (req, res) => {
    const { channelId } = req.body;
    const backupFilePath = req.file?.path;

    if (!channelId || !backupFilePath) {
        return res.status(400).json({ error: 'Missing channel ID or backup file' });
    }

    try {
        // Fetch the channel and check permissions
        const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        // Check if we have the required permissions
        const permissions = channel.permissionsFor(client.user);
        if (!permissions?.has(['SEND_MESSAGES', 'VIEW_CHANNEL', 'MANAGE_WEBHOOKS'])) {
            return res.status(403).json({ 
                error: 'Missing required permissions. Bot needs: SEND_MESSAGES, VIEW_CHANNEL, and MANAGE_WEBHOOKS'
            });
        }

        const backupData = JSON.parse(fsSync.readFileSync(backupFilePath, 'utf-8'));

        // Create webhook for message restoration
        const webhook = await channel.createWebhook('Message Restore', {
            avatar: client.user.displayAvatarURL()
        });

        console.log(`Created webhook in channel ${channel.name || 'DM'}`);

        // Process messages in chronological order
        const messages = [...backupData].reverse();
        let restoredCount = 0;

        for (const message of messages) {
            try {
                const messageOptions = {
                    username: message.author,
                    avatarURL: message.authorAvatar || client.user.displayAvatarURL()
                };

                // Handle text content
                if (message.content?.trim()) {
                    await webhook.send({
                        content: message.content,
                        ...messageOptions
                    });
                    restoredCount++;
                }

                // Handle attachments
                if (message.attachments?.length > 0) {
                    for (const attachment of message.attachments) {
                        if (attachment.localPath) {
                            const attachmentPath = path.join(path.dirname(backupFilePath), attachment.localPath);
                            if (fsSync.existsSync(attachmentPath)) {
                                await webhook.send({
                                    ...messageOptions,
                                    files: [attachmentPath]
                                });
                            }
                        } else if (attachment.url) {
                            await webhook.send({
                                content: attachment.url,
                                ...messageOptions
                            });
                        }
                        restoredCount++;
                    }
                }

                await delay(RATE_LIMIT_DELAY);
            } catch (error) {
                console.error(`Error restoring message from ${message.author}:`, error.message);
            }
        }

        // Clean up webhook
        await webhook.delete();

        res.status(200).json({ 
            message: `Successfully restored ${restoredCount} messages to ${channel.name || 'DM'}`
        });
    } catch (error) {
        console.error('Error during restore:', error.message);
        res.status(500).json({ error: error.message });
    } finally {
        // Clean up the uploaded file using fsSync instead of fs
        if (backupFilePath) {
            try {
                fsSync.unlinkSync(backupFilePath);
            } catch (error) {
                console.error('Error cleaning up temporary file:', error);
            }
        }
    }
});

// Message restore endpoint with better error handling
app.post('/restore-with-webhook', upload.single('backupFile'), async (req, res) => {
    const { channelId, isGroupDM } = req.body;
    const backupFilePath = req.file?.path;

    if (!channelId || !backupFilePath) {
        return res.status(400).json({ error: 'Missing channel ID or backup file' });
    }

    try {
        // Read and validate backup data
        let backupData;
        try {
            const fileContent = await fsPromises.readFile(backupFilePath, 'utf-8');
            backupData = JSON.parse(fileContent);
            
            // Handle both array format and object format with messages property
            if (!Array.isArray(backupData) && backupData.messages) {
                backupData = backupData.messages;
            }
            
            if (!Array.isArray(backupData)) {
                throw new Error('Invalid backup format: expected an array of messages or an object with messages array');
            }
        } catch (error) {
            return res.status(400).json({ error: `Failed to parse backup file: ${error.message}` });
        }

        // Fetch the target channel
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        // Create webhook for guild channels (not for DMs)
        let webhook = null;
        if (channel.type === 'GUILD_TEXT') {
            try {
                webhook = await channel.createWebhook('Message Restore', {
                    avatar: client.user.displayAvatarURL()
                });
                console.log(chalk.green(`Created webhook in channel ${channel.name}`));
            } catch (error) {
                return res.status(403).json({ 
                    error: `Failed to create webhook: ${error.message}. Make sure the bot has MANAGE_WEBHOOKS permission.`
                });
            }
        }

        // Process messages in parallel using worker threads
        const batchSize = 10; // Process 10 messages at a time
        const messages = [...backupData].reverse();
        let restoredCount = 0;
        let failedCount = 0;

        for (let i = 0; i < messages.length; i += batchSize) {
            const batch = messages.slice(i, i + batchSize);
            const workers = batch.map(message => {
                return new Promise(async (resolve) => {
                    try {
                        const messageOptions = {
                            username: message.author,
                            avatarURL: message.authorAvatar || client.user.displayAvatarURL()
                        };

                        // Handle text content
                        if (message.content?.trim()) {
                            if (channel.type === 'GUILD_TEXT') {
                                await webhook.send({
                                    content: message.content,
                                    ...messageOptions
                                });
                            } else {
                                await channel.send(message.content);
                            }
                            restoredCount++;
                        }

                        // Handle attachments
                        if (message.attachments?.length > 0) {
                            for (const attachment of message.attachments) {
                                try {
                                    if (attachment.localPath) {
                                        const possiblePaths = [
                                            path.join(path.dirname(backupFilePath), attachment.localPath),
                                            path.join(__dirname, attachment.localPath),
                                            attachment.localPath
                                        ];

                                        let foundPath = null;
                                        for (const testPath of possiblePaths) {
                                            if (fsSync.existsSync(testPath)) {
                                                foundPath = testPath;
                                                break;
                                            }
                                        }

                                        if (foundPath) {
                                            if (channel.type === 'GUILD_TEXT') {
                                                await webhook.send({
                                                    ...messageOptions,
                                                    files: [foundPath]
                                                });
                                            } else {
                                                await channel.send({ files: [foundPath] });
                                            }
                                        } else {
                                            throw new Error('Local file not found');
                                        }
                                    } else if (attachment.url || attachment.originalUrl) {
                                        const attachmentUrl = attachment.url || attachment.originalUrl;
                                        if (channel.type === 'GUILD_TEXT') {
                                            await webhook.send({
                                                content: attachmentUrl,
                                                ...messageOptions
                                            });
                                        } else {
                                            await channel.send(attachmentUrl);
                                        }
                                    }
                                    restoredCount++;
                                } catch (attachmentError) {
                                    console.error(chalk.yellow(`Failed to restore attachment: ${attachmentError.message}`));
                                    failedCount++;
                                }
                            }
                        }

                        resolve(true);
                    } catch (error) {
                        console.error(chalk.red(`Error restoring message: ${error.message}`));
                        failedCount++;
                        resolve(false);
                    }
                });
            });

            // Wait for all workers in the batch to complete
            await Promise.all(workers);
            await delay(RATE_LIMIT_DELAY * 2); // Add extra delay between batches
        }

        // Cleanup webhook if it was created
        if (webhook) {
            try {
                await webhook.delete();
            } catch (error) {
                console.error(chalk.yellow(`Failed to delete webhook: ${error.message}`));
            }
        }

        res.status(200).json({ 
            message: `Restore completed: ${restoredCount} messages restored successfully${failedCount > 0 ? `, ${failedCount} failed` : ''}`,
            restoredCount,
            failedCount
        });
    } catch (error) {
        console.error(chalk.red('Error during restore:', error.message));
        res.status(500).json({ error: error.message });
    } finally {
        // Clean up the uploaded file
        if (backupFilePath) {
            try {
                fsSync.unlinkSync(backupFilePath);
            } catch (error) {
                console.error(chalk.yellow('Error cleaning up temporary file:', error));
            }
        }
    }
});

// Serve the index page at the root URL
app.get('/', async (req, res) => {
    try {
        // Fetch the necessary data for items
        const items = []; // Replace with actual data fetching logic

        // Example: Fetching all guilds and DMs
        client.guilds.cache.forEach(guild => {
            items.push({
            id: guild.id,
            name: guild.name,
            type: 'guild',
                avatar: guild.iconURL(),
            });
        });

        client.channels.cache.filter(channel => channel.type === 'DM').forEach(dm => {
            items.push({
                id: dm.id,
                name: dm.recipient.username,
                type: 'dm',
                avatar: dm.recipient.displayAvatarURL(),
            });
        });

        // Render the index page with the items data
        res.render('index', { items });
    } catch (error) {
        console.error('Error fetching items:', error.message);
        res.status(500).send('Internal Server Error');
    }
});

// Route to download the backup file
app.get('/download/:backupId', (req, res) => {
    const backupId = req.params.backupId;
    const backupFilePath = path.join(__dirname, 'backups', `${backupId}.json`);

    if (fsSync.existsSync(backupFilePath)) {
        res.download(backupFilePath, `${backupId}.json`, (err) => {
            if (err) {
                console.error('Error downloading file:', err);
                res.status(500).send('Error downloading file');
            }
        });
    } else {
        res.status(404).send('Backup file not found');
    }
});

// Function to backup a server
async function backupServer(guild) {
    try {
        // Ensure guild is fully loaded
        guild = await client.guilds.fetch(guild.id);
        await guild.roles.fetch();
        await guild.channels.fetch();

        const backupData = {
            name: guild.name,
            icon: guild.iconURL(),
            roles: [],
            channels: [],
            categoryChannels: [],
        };

        // Backup roles (excluding @everyone)
        for (const role of guild.roles.cache.values()) {
            if (role.name !== '@everyone') {
                backupData.roles.push({
                    name: role.name,
                    color: role.hexColor,
                    hoist: role.hoist,
                    permissions: role.permissions.bitfield.toString(),
                    mentionable: role.mentionable,
                    position: role.position
                });
            }
        }

        // Backup categories first
        const categories = guild.channels.cache.filter(c => c.type === 'GUILD_CATEGORY');
        for (const category of categories.values()) {
            backupData.categoryChannels.push({
                name: category.name,
                position: category.position,
                id: category.id
            });
        }

        // Backup channels
        const nonCategoryChannels = guild.channels.cache.filter(c => c.type !== 'GUILD_CATEGORY');
        for (const channel of nonCategoryChannels.values()) {
            try {
                // Get permission overwrites safely
                let permissionOverwrites = [];
                if (channel.permissionOverwrites && channel.permissionOverwrites.cache) {
                    permissionOverwrites = Array.from(channel.permissionOverwrites.cache.values()).map(perm => ({
                        id: perm.id,
                        type: perm.type,
                        allow: perm.allow?.bitfield?.toString() || "0",
                        deny: perm.deny?.bitfield?.toString() || "0"
                    }));
                }

                const channelData = {
                    name: channel.name,
                    type: channel.type,
                    position: channel.position || 0,
                    parentId: channel.parentId || null,
                    topic: channel.topic || "",
                    nsfw: channel.nsfw || false,
                    rateLimitPerUser: channel.rateLimitPerUser || 0,
                    permissionOverwrites: permissionOverwrites,
                    messages: []
                };

                // Backup messages if it's a text channel
                if (channel.type === 'GUILD_TEXT' || channel.type === 'GUILD_NEWS') {
                    try {
                        const messages = await fetchMessagesWithRetry(channel, { limit: 100 });
                        
                        for (const message of messages.values()) {
                            const messageData = {
                                content: message.content,
                                author: message.author.username,
                                authorAvatar: message.author.displayAvatarURL({ format: 'png', dynamic: true, size: 1024 }),
                                timestamp: message.createdTimestamp,
                                attachments: message.attachments.map(att => ({
                                    url: att.url,
                                    filename: att.name,
                                    size: att.size,
                                    contentType: att.contentType
                                }))
                            };
                            channelData.messages.push(messageData);
                        }
                    } catch (error) {
                        console.error(`Error backing up messages for channel ${channel.name}:`, error.message);
                    }
                }

                backupData.channels.push(channelData);
                console.log(chalk.green(`Successfully backed up channel: ${channel.name}`));
            } catch (error) {
                console.error(chalk.yellow(`Error backing up channel ${channel.name}:`, error.message));
            }
        }

        return backupData;
    } catch (error) {
        console.error(chalk.red(`Error in backupServer: ${error.message}`));
        throw error;
    }
}

// Update the backup-server route
app.post('/backup-server', async (req, res) => {
    const { serverId } = req.body;
    
    try {
        // Fetch the guild and ensure it's loaded
        const guild = await client.guilds.fetch(serverId);
        if (!guild) {
            return res.status(404).json({ error: 'Server not found' });
        }

        // Create backup directories
        const serverName = guild.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const { backupDir, attachmentsDir, backupNumber } = await ensureBackupDirectories('servers', serverName);
        
        console.log(chalk.green(`Created backup directory: ${backupDir}`));
        console.log(chalk.green(`Created attachments directory: ${attachmentsDir}`));
        
        // Create the backup
        const backupData = await backupServer(guild);
        
        // Process attachments for each channel
        for (const channel of backupData.channels) {
            if (channel.messages) {
                for (const message of channel.messages) {
                    if (message.attachments && message.attachments.length > 0) {
                        for (const att of message.attachments) {
                            const fileExt = path.extname(att.url) || '.unknown';
                            const fileName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${fileExt}`;
                            const filePath = path.join(attachmentsDir, fileName);
                            
                            // Download the attachment
                            if (await downloadAttachment(att.url, filePath)) {
                                att.localPath = path.relative(backupDir, filePath);
                                console.log(chalk.green(`Downloaded attachment: ${att.filename} to ${filePath}`));
                            } else {
                                console.error(chalk.red(`Failed to download attachment: ${att.filename}`));
                            }
                        }
                    }
                }
            }
        }
        
        const backupPath = path.join(backupDir, 'backup.json');
        
        // Save the backup
        await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2));
        console.log(chalk.green(`Server backup saved to ${backupPath}`));
        console.log(chalk.green(`Server attachments directory: ${attachmentsDir}`));

        // Send response with the correct download URL
        res.json({ 
            message: 'Server backup created successfully',
            downloadUrl: `/download/servers/${serverName}-${backupNumber}`,
            backupDir: backupDir
        });
    } catch (error) {
        console.error(chalk.red('Error creating server backup:', error.message));
        res.status(500).json({ error: error.message });
    }
});

// Route to handle server restore
app.post('/restore-server', upload.single('backupFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No backup file provided' });
        }

        const { serverId } = req.body;
        if (!serverId) {
            return res.status(400).json({ error: 'No server ID provided' });
        }

        // Read the backup file
        const backupData = JSON.parse(fsSync.readFileSync(req.file.path, 'utf-8'));

        // Get the guild
        const guild = client.guilds.cache.get(serverId) || await client.guilds.fetch(serverId);
        if (!guild) {
            return res.status(404).json({ error: 'Server not found' });
        }

        try {
            // 1. Restore server icon and name
            res.write(JSON.stringify({ status: 'Restoring server icon and name...' }) + '\n');
            if (backupData.name) await guild.setName(backupData.name);
            if (backupData.icon) await guild.setIcon(backupData.icon);

            // 2. Delete existing channels
            res.write(JSON.stringify({ status: 'Removing existing channels...' }) + '\n');
            await Promise.all(guild.channels.cache.map(channel => channel.delete()));

            // 3. Create categories first
            res.write(JSON.stringify({ status: 'Restoring categories...' }) + '\n');
            const categoryMap = new Map();
            for (const categoryData of backupData.categoryChannels || []) {
                try {
                    const newCategory = await guild.channels.create(categoryData.name, {
                        type: 'GUILD_CATEGORY',
                        position: categoryData.position
                    });
                    categoryMap.set(categoryData.id, newCategory.id);
                    res.write(JSON.stringify({ status: `Created category: ${categoryData.name}` }) + '\n');
                } catch (error) {
                    res.write(JSON.stringify({ status: `Failed to create category ${categoryData.name}: ${error.message}` }) + '\n');
                }
            }

            // 4. Create channels and restore messages
            res.write(JSON.stringify({ status: 'Restoring channels and messages...' }) + '\n');
            for (const channelData of backupData.channels) {
                try {
                    const channel = await guild.channels.create(channelData.name, {
                        type: channelData.type,
                        topic: channelData.topic,
                        nsfw: channelData.nsfw,
                        parent: categoryMap.get(channelData.parentId),
                        rateLimitPerUser: channelData.rateLimitPerUser
                    });

                    // Create webhook for message restoration
                    const webhook = await channel.createWebhook('Restore Bot', {
                        avatar: client.user.displayAvatarURL()
                    });

                    // Restore messages with attachments
                    for (const message of channelData.messages) {
                        try {
                            const messageOptions = {
                                username: message.author,
                                avatarURL: message.authorAvatar,
                                content: message.content
                            };

                            // Send message content
                            if (message.content) {
                                await webhook.send(messageOptions);
                            }

                            // Handle attachments
                            for (const attachment of message.attachments) {
                                if (attachment.localPath) {
                                    const attachmentPath = path.join(path.dirname(req.file.path), attachment.localPath);
                                    if (fsSync.existsSync(attachmentPath)) {
                                        await webhook.send({
                                            username: message.author,
                                            avatarURL: message.authorAvatar,
                                            files: [attachmentPath]
                                        });
                                    }
                                } else if (attachment.url) {
                                    await webhook.send({
                                        username: message.author,
                                        avatarURL: message.authorAvatar,
                                        content: attachment.url
                                    });
                                }
                            }
                        } catch (error) {
                            res.write(JSON.stringify({ status: `Error restoring message in ${channelData.name}: ${error.message}` }) + '\n');
                        }
                        await delay(1000); // Rate limit delay
                    }

                    // Clean up webhook
                    await webhook.delete();
                    res.write(JSON.stringify({ status: `Restored channel: ${channelData.name}` }) + '\n');
                } catch (error) {
                    res.write(JSON.stringify({ status: `Error restoring channel ${channelData.name}: ${error.message}` }) + '\n');
                }
            }

            // 5. Restore roles
            res.write(JSON.stringify({ status: 'Restoring roles...' }) + '\n');
            for (const roleData of backupData.roles.sort((a, b) => b.position - a.position)) {
                try {
                    await guild.roles.create({
                        name: roleData.name,
                        color: roleData.color,
                        hoist: roleData.hoist,
                        permissions: BigInt(roleData.permissions),
                        mentionable: roleData.mentionable,
                        position: roleData.position
                    });
                    res.write(JSON.stringify({ status: `Created role: ${roleData.name}` }) + '\n');
                } catch (error) {
                    res.write(JSON.stringify({ status: `Failed to create role ${roleData.name}: ${error.message}` }) + '\n');
                }
            }

            res.write(JSON.stringify({ status: 'Server restore completed successfully' }) + '\n');
            res.end();
        } catch (error) {
            res.write(JSON.stringify({ status: `Server restore failed: ${error.message}` }) + '\n');
            res.end();
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    } finally {
        if (req.file) {
            fsSync.unlinkSync(req.file.path);
        }
    }
});

// Add this new endpoint to fetch server channels
app.get('/server-channels/:serverId', async (req, res) => {
  try {
    const { serverId } = req.params;
    const guild = client.guilds.cache.get(serverId) || await client.guilds.fetch(serverId);
    
    if (!guild) {
      return res.status(404).json({ error: 'Server not found' });
    }

    // Get all text channels
    const channels = guild.channels.cache
      .filter(channel => channel.type === 'GUILD_TEXT')
      .map(channel => ({
        id: channel.id,
        name: channel.name,
        parent: channel.parent?.name || 'No Category'
      }));

    res.json({ channels });
  } catch (error) {
    console.error('Error fetching server channels:', error);
    res.status(500).json({ error: error.message });
  }
});

// Initialize Server
async function startServer() {
    try {
        // Initialize all required directories
        initializeDirectories();

        // Display welcome message
        console.log(chalk.blue(figlet.textSync('Midoribot', { horizontalLayout: 'full' })));
        console.log(chalk.green('Starting Midoribot...'));

        // Login to Discord
        await client.login(process.env.DISCORD_TOKEN);
        console.log(chalk.green(`Logged in as ${client.user.tag}`));

        // Start Express server
        await new Promise((resolve, reject) => {
            const server = app.listen(PORT, () => {
                console.log(chalk.yellow(`Server running at http://localhost:${PORT}`));
                resolve();
            });
            server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    console.error(chalk.red(`Port ${PORT} is already in use. Please choose a different port or close the other application.`));
                } else {
                    console.error(chalk.red('Failed to start server:', error));
                }
                reject(error);
            });
        });
    } catch (error) {
        console.error(chalk.red('Failed to start server:', error));
        process.exit(1);
    }
}

// Start the server
startServer();

// Message Handling Functions
async function fetchMessagesWithRetry(channel, options, retries = MAX_RETRY_ATTEMPTS) {
    for (let i = 0; i < retries; i++) {
        try {
            return await channel.messages.fetch(options);
        } catch (error) {
            console.error(`Attempt ${i + 1} failed:`, error.message);
            if (i < retries - 1) await delay(RETRY_DELAY);
        }
    }
    throw new Error(`Failed to fetch messages after ${retries} attempts`);
}

// Helper function to clean filename and get extension
function getCleanFilenameAndExt(url, originalFilename) {
    let ext = '';
    
    // First try to get extension from original filename
    if (originalFilename) {
        // Remove any query parameters from the original filename
        const cleanFilename = originalFilename.split('?')[0];
        ext = path.extname(cleanFilename);
    }
    
    // If no extension from filename, try to get it from URL
    if (!ext) {
        // Remove query parameters from URL
        const cleanUrl = url.split('?')[0];
        ext = path.extname(cleanUrl);
    }
    
    // If still no extension, use .unknown
    if (!ext) {
        ext = '.unknown';
    }
    
    // Generate clean filename
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substr(2, 9);
    const cleanFilename = `${timestamp}-${randomString}${ext}`;
    
    return cleanFilename;
}

// Helper function to download attachments
async function downloadAttachment(url, savePath, originalFilename) {
    try {
        // Remove any query parameters from the URL
        const cleanUrl = url.split('?')[0];
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to download attachment: ${response.statusText}`);
        }

        // Get the clean filename without query parameters
        const cleanSavePath = savePath.split('?')[0];

        // Ensure the directory exists
        const dir = path.dirname(cleanSavePath);
        await fs.mkdir(dir, { recursive: true });

        // Stream the file instead of loading it into memory
        const fileStream = fsSync.createWriteStream(cleanSavePath);
        await streamPipeline(response.body, fileStream);

        console.log(chalk.green(`Successfully downloaded attachment to ${cleanSavePath}`));
        return true;
    } catch (error) {
        console.error(chalk.red(`Error downloading attachment: ${error.message}`));
        // Try to clean up the failed download
        try {
            if (fsSync.existsSync(savePath)) {
                await fs.unlink(savePath);
            }
        } catch (cleanupError) {
            console.error(chalk.red(`Error cleaning up failed download: ${cleanupError.message}`));
        }
        return false;
    }
}

// Add backup-dm route
app.post('/backup-dm', async (req, res) => {
    const { channelId } = req.body;
    
    try {
        // Fetch the channel
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        // Create backup
        const backupResult = await backupDMChannel(channel);
        
        // Return the correct download path based on the backup structure
        const downloadPath = `/download/${backupResult.type}/${backupResult.name}-${backupResult.backupNumber}/${backupResult.backupId}`;
        
        res.json({ 
            message: 'DM backup created successfully',
            downloadUrl: downloadPath,
            backupPath: backupResult.path
        });
    } catch (error) {
        console.error(chalk.red('Error creating DM backup:', error.message));
        res.status(500).json({ error: error.message });
    }
});

// Update the download route to handle the new path structure
app.get('/download/:type/:name/:backupId', async (req, res) => {
    const { type, name, backupId } = req.params;
    const backupPath = path.join(__dirname, 'backups', type, name, backupId);
    
    try {
        // Check if file exists
        await fs.access(backupPath);
        
        // Set appropriate headers for file download
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=${name}-${backupId}`);
        
        // Stream the file to the response
        const fileStream = fsSync.createReadStream(backupPath);
        fileStream.pipe(res);
        
        // Handle errors during streaming
        fileStream.on('error', (error) => {
            console.error(chalk.red('Error streaming backup file:', error));
            if (!res.headersSent) {
                res.status(500).send('Error downloading file');
            }
        });
    } catch (error) {
        console.error(chalk.red(`Backup file not found: ${backupPath}`));
        res.status(404).send('Backup file not found');
    }
});