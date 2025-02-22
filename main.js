require('dotenv').config();
const express = require('express');
const path = require('path');
const FileUtils = require('./src/utils/fileUtils');
const Logger = require('./src/utils/logger');
const discordService = require('./src/services/discordService');
const restoreRoutes = require('./src/routes/restore');
const config = require('./src/config/config');
const { Worker } = require('worker_threads');
const WorkerPool = require('./workerPool');
const fs = require('fs');

const app = express();

// Middleware
app.use(express.json({ limit: '500mb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Initialize required directories
FileUtils.ensureDirectoryExists(path.join(__dirname, config.PATHS.BACKUPS));
FileUtils.ensureDirectoryExists(path.join(__dirname, config.PATHS.UPLOADS));
FileUtils.ensureDirectoryExists(path.join(__dirname, config.PATHS.ATTACHMENTS));

// Initialize worker pools
const messagePool = new WorkerPool('./messageWorker.js', 2);
const downloadPool = new WorkerPool('./messageWorker.js', 2);

// Routes
app.use('/', restoreRoutes);

// Index route
app.get('/', async (req, res) => {
    try {
        const client = discordService.getClient();
        
        // Get DMs
        const dms = Array.from(client.channels.cache.values())
            .filter(channel => channel.type === 'DM')
            .map(channel => ({
                id: channel.id,
                name: channel.recipient?.username || 'Unknown User',
                avatar: channel.recipient?.displayAvatarURL({ format: 'png', size: 128 }),
                type: 'dm'
            }));

        // Get servers
        const guilds = Array.from(client.guilds.cache.values())
            .map(guild => ({
                id: guild.id,
                name: guild.name,
                avatar: guild.iconURL({ format: 'png', size: 128 }),
                type: 'guild'
            }));

        // Combine items
        const items = [...dms, ...guilds];

        res.render('index', { items });
    } catch (error) {
        Logger.error('Error rendering index:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Update the backupDMChannel function with the working version
async function backupDMChannel(channel) {
    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const backupData = messages.map(msg => ({
            author: msg.author.username,
            content: msg.content,
            attachments: msg.attachments.map(att => ({
                url: att.url,
                filename: att.name,
            })),
            timestamp: msg.createdTimestamp,
            webhookData: {
                username: msg.author.username,
                avatarURL: msg.author.avatar ? 
                    `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}` : 
                    'https://cdn.discordapp.com/embed/avatars/0.png'
            }
        }));

        // Ensure backup directory exists
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        // Generate backup ID using timestamp
        const backupId = `backup-${Date.now()}`;
        const backupFilePath = path.join(backupDir, `${backupId}.json`);
        
        // Save the backup
        await fs.promises.writeFile(backupFilePath, JSON.stringify(backupData, null, 2));
        Logger.success(`Backup saved to ${backupFilePath}`);

        return {
            success: true,
            backupId: backupId,
            path: backupFilePath,
            downloadUrl: `/download/${backupId}`
        };
    } catch (error) {
        Logger.error('Backup failed:', error);
        throw error;
    }
}

// Update the backup-dm route
app.post('/backup-dm', async (req, res) => {
    try {
        const { channelId } = req.body;
        const channel = await discordService.getClient().channels.fetch(channelId);
        
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        const result = await backupDMChannel(channel);
        res.json({
            message: 'DM backup created successfully',
            success: true
        });
    } catch (error) {
        Logger.error('Backup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add download route
app.get('/download/:backupId', (req, res) => {
    const { backupId } = req.params;
    const backupPath = path.join(__dirname, 'backups', `${backupId}.json`);

    if (!fs.existsSync(backupPath)) {
        return res.status(404).send('Backup file not found');
    }

    res.download(backupPath);
});

// Add this route for server backups
app.post('/backup-guild', async (req, res) => {
    try {
        const { serverId } = req.body;
        const server = await discordService.getClient().guilds.fetch(serverId);
        
        if (!server) {
            return res.status(404).json({ error: 'Server not found' });
        }

        Logger.info(`Starting backup for server: ${server.name}`);

        // Get all text channels that we have access to
        const channels = server.channels.cache.filter(channel => 
            channel.type === 'GUILD_TEXT' && 
            channel.permissionsFor(server.members.me).has(['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'])
        );

        let totalMessages = 0;
        let skippedChannels = 0;
        const backupData = [];

        for (const [_, channel] of channels) {
            try {
                Logger.info(`Backing up channel #${channel.name}...`);
                const messages = await channel.messages.fetch({ limit: 100 }).catch(error => {
                    Logger.warn(`Skipping channel #${channel.name} - No access`);
                    skippedChannels++;
                    return null;
                });

                if (!messages) continue;

                const channelMessages = messages.map(msg => ({
                    author: msg.author.username,
                    content: msg.content,
                    attachments: Array.from(msg.attachments.values()).map(att => ({
                        url: att.url,
                        name: att.name
                    })),
                    timestamp: msg.createdTimestamp,
                    channelId: channel.id,
                    channelName: channel.name,
                    webhookData: {
                        username: msg.author.username,
                        avatarURL: msg.author.displayAvatarURL()
                    }
                }));

                backupData.push(...channelMessages);
                totalMessages += messages.size;
                Logger.success(`Backed up ${messages.size} messages from #${channel.name}`);
            } catch (error) {
                Logger.error(`Failed to backup channel #${channel.name}:`, error);
                skippedChannels++;
            }
        }

        if (backupData.length === 0) {
            return res.status(400).json({ 
                error: 'No messages could be backed up. Check bot permissions.' 
            });
        }

        // Save backup
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const backupId = `server-${server.id}-${Date.now()}`;
        const backupPath = path.join(backupDir, `${backupId}.json`);
        
        await fs.promises.writeFile(backupPath, JSON.stringify(backupData, null, 2));

        const summary = `Server backup completed: ${totalMessages} messages backed up` + 
                       (skippedChannels > 0 ? ` (${skippedChannels} channels skipped)` : '');

        res.json({
            message: summary,
            success: true,
            backupId,
            details: {
                totalMessages,
                skippedChannels,
                channelsProcessed: channels.size - skippedChannels
            }
        });
    } catch (error) {
        Logger.error('Server backup failed:', error);
        res.status(500).json({ 
            error: 'Failed to backup server: ' + (error.message || 'Unknown error') 
        });
    }
});

// Add manual restore endpoint
app.post('/restore', async (req, res) => {
  const { backupId, targetId, type, clearServer } = req.body;

  if (!backupId || !targetId || !type) {
    return res.status(400).json({ error: 'Missing backupId, targetId, or type' });
  }

  const backupFilePath = path.join(__dirname, 'backups', `backup-${type}-${backupId}.json`);
  if (!fs.existsSync(backupFilePath)) {
    return res.status(404).json({ error: 'Backup file not found' });
  }

  try {
    if (type === 'guild') {
      await restoreGuild(backupFilePath, targetId, clearServer);
      res.status(200).json({ message: 'Guild restore successful!' });
    } else if (type === 'dm') {
      await restoreDM(backupFilePath, targetId);
      res.status(200).json({ message: 'DM restore successful!' });
    } else {
      res.status(400).json({ error: 'Invalid restore type' });
    }
  } catch (error) {
    Logger.error('Error while restoring:', error.message);
    res.status(500).json({ error: error.message });
  }
});

async function restoreDM(backupFilePath, targetChannelId) {
  try {
    const channel = await discordService.getClient().channels.fetch(targetChannelId);
    if (!channel) {
      throw new Error('Channel not found');
    }

    const backupData = JSON.parse(await fs.promises.readFile(backupFilePath, 'utf-8'));
    backupData.messages.reverse();
    let webhook;
    const webhooks = await channel.fetchWebhooks();
    if (webhooks.size > 0) {
      webhook = webhooks.first();
      Logger.info(`Using existing webhook: ${webhook.name}`);
    } else {
      webhook = await channel.createWebhook('Restore Bot', {
        avatar: discordService.getClient().user.displayAvatarURL()
      });
      Logger.info(`Created new webhook: ${webhook.name}`);
    }

    let restoredCount = 0;
    let failedCount = 0;

    for (const messageBackup of backupData.messages) {
      try {
        const files = [];
        for (const att of messageBackup.attachments) {
          if (att.url) {
            files.push({
              attachment: att.url,
              name: att.filename || 'attachment'
            });
          }
        }

        let content = messageBackup.content || ' '; // Use a space if content is empty

        if (files.length === 0) {
          await webhook.send({
            content: content,
            username: messageBackup.author.username,
            avatarURL: messageBackup.author.avatar
          });
        } else {
          await webhook.send({
            content: content,
            username: messageBackup.author.username,
            avatarURL: messageBackup.author.avatar,
            files: files
          });
        }
        restoredCount++;
        await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit delay
      } catch (error) {
        Logger.error(`Failed to restore message: ${error.message}`);
        failedCount++;
      }
    }

    return {
      success: true,
      restoredCount,
      failedCount,
      message: `Restored ${restoredCount} messages${failedCount > 0 ? `, ${failedCount} failed` : ''}`
    };
  } catch (error) {
    Logger.error('Error while restoring:', error.message);
    throw error;
  }
}

async function restoreGuild(backupFilePath, targetGuildId, clearServerBeforeRestore = true) {
  const guild = await discordService.getClient().guilds.fetch(targetGuildId);
  if (!guild) throw new Error('Guild not found');

  const backupData = JSON.parse(await fs.promises.readFile(backupFilePath, 'utf-8'));
  
  if (clearServerBeforeRestore) {
    Logger.info('Clearing existing channels...');
    await Promise.all(
      guild.channels.cache
        .filter(channel => channel.deletable)
        .map(channel => channel.delete())
    );
  }

  let restoredChannels = 0;
  let restoredMessages = 0;
  let failedCount = 0;

  // Group messages by channel
  const channelMessages = {};
  for (const message of backupData) {
    const channelName = message.channelName || 'restored-chat';
    if (!channelMessages[channelName]) {
      channelMessages[channelName] = [];
    }
    channelMessages[channelName].push(message);
  }

  // Create channels and restore messages
  for (const [channelName, messages] of Object.entries(channelMessages)) {
    try {
      const channel = await guild.channels.create(channelName, {
        type: 'GUILD_TEXT'
      });

      const webhook = await channel.createWebhook('Server Restore', {
        avatar: discordService.getClient().user.displayAvatarURL()
      });

      for (const message of messages) {
        try {
          // Send message content
          if (message.content?.trim()) {
            await webhook.send({
              content: message.content,
              username: message.webhookData?.username || message.author,
              avatarURL: message.webhookData?.avatarURL
            });
          }

          // Send attachments separately
          if (message.attachments?.length > 0) {
            for (const attachment of message.attachments) {
              if (attachment.url) {
                await webhook.send({
                  username: message.webhookData?.username || message.author,
                  avatarURL: message.webhookData?.avatarURL,
                  files: [{
                    attachment: attachment.url,
                    name: attachment.filename || 'attachment'
                  }]
                });
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
          }

          restoredMessages++;
          Logger.success(`Restored message ${restoredMessages} in ${channel.name}`);
        } catch (error) {
          Logger.error(`Failed to restore message in ${channel.name}: ${error.message}`);
          failedCount++;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      await webhook.delete().catch(console.error);
      restoredChannels++;
    } catch (error) {
      Logger.error(`Failed to restore channel: ${error.message}`);
      failedCount++;
    }
  }

  return {
    success: true,
    restoredChannels,
    restoredMessages,
    failedCount,
    message: `Restored ${restoredChannels} channels, ${restoredMessages} messages${failedCount > 0 ? `, ${failedCount} failed` : ''}`
  };
}

// Add restore direct endpoint
app.post('/restore-direct', async (req, res) => {
    try {
        const { sourceChannelId, targetChannelId } = req.body;
        const client = discordService.getClient();

        if (!sourceChannelId || !targetChannelId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        try {
            // Get source and target channels
            const sourceChannel = await client.channels.fetch(sourceChannelId);
            const targetChannel = await client.channels.fetch(targetChannelId);

            if (!sourceChannel || !targetChannel) {
                return res.status(404).json({ error: 'One or both channels not found' });
            }

            // Fetch messages from source channel
            const messages = await sourceChannel.messages.fetch({ limit: 100 });
            
            // Create webhook for restore
            const webhook = await targetChannel.createWebhook('Message Restore', {
                avatar: client.user.displayAvatarURL()
            });

            let restoredCount = 0;
            let failedCount = 0;

            // Process messages in chronological order
            const sortedMessages = Array.from(messages.values())
                .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

            for (const message of sortedMessages) {
                try {
                    await webhook.send({
                        content: message.content,
                        username: message.author.username,
                        avatarURL: message.author.displayAvatarURL(),
                        files: Array.from(message.attachments.values()).map(att => ({
                            attachment: att.url,
                            name: att.name || 'attachment'
                        }))
                    });
                    restoredCount++;
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit delay
                } catch (error) {
                    Logger.error(`Failed to restore message: ${error.message}`);
                    failedCount++;
                }
            }

            // Cleanup webhook
            await webhook.delete().catch(console.error);

            return res.json({
                message: `Restored ${restoredCount} messages${failedCount > 0 ? `, ${failedCount} failed` : ''}`,
                success: true
            });

        } catch (error) {
            Logger.error('Direct restore failed:', error);
            return res.status(500).json({ error: error.message });
        }
    } catch (error) {
        Logger.error('Restore failed:', error);
        return res.status(500).json({ error: error.message });
    }
});

// Add download backup endpoint
app.get('/download-backup/:backupId', async (req, res) => {
  try {
    const { backupId } = req.params;
    const backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
    
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    
    res.download(backupPath);
  } catch (error) {
    Logger.error('Failed to download backup:', error);
    res.status(500).json({ error: 'Failed to download backup' });
  }
});

// Add delete backup endpoint
app.delete('/delete-backup/:backupId', async (req, res) => {
  try {
    const { backupId } = req.params;
    const backupPath = path.join(__dirname, 'backups', `${backupId}.json`);
    
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    
    await fs.promises.unlink(backupPath);
    res.json({ message: 'Backup deleted successfully' });
  } catch (error) {
    Logger.error('Failed to delete backup:', error);
    res.status(500).json({ error: 'Failed to delete backup' });
  }
});

// Add backup selected DMs endpoint
app.post('/backup-selected-dms', async (req, res) => {
  try {
    const { channelIds } = req.body;
    if (!channelIds || !Array.isArray(channelIds)) {
      return res.status(400).json({ error: 'Invalid channel IDs' });
    }

    const results = [];
    for (const channelId of channelIds) {
      try {
        const channel = await discordService.getClient().channels.fetch(channelId);
        const result = await backupDMChannel(channel);
        results.push(result);
      } catch (error) {
        Logger.error(`Failed to backup DM ${channelId}:`, error);
      }
    }

    res.json({
      message: `Successfully backed up ${results.length} DMs`,
      results
    });
  } catch (error) {
    Logger.error('Failed to backup selected DMs:', error);
    res.status(500).json({ error: 'Failed to backup selected DMs' });
  }
});

// Initialize Server
async function startServer() {
    try {
        // Initialize Discord client
        await discordService.initialize();
        
        // Show welcome message
        Logger.showWelcome();
        Logger.info('Starting Midoribot...');

        // Start Express server
        app.listen(config.PORT, () => {
            Logger.success(`Server running at http://localhost:${config.PORT}`);
        });
    } catch (error) {
        Logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Start the server
startServer();