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
const upload = require('./src/utils/upload');

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
        const backupData = {
            type: 'dm',
            channelId: channel.id,
            messages: messages.map(msg => ({
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
            }))
        };

        // Ensure backup directory exists
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        // Generate backup ID using consistent format
        const timestamp = Date.now();
        const backupId = `backup-dm-${channel.id}-${timestamp}`;
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
            Logger.error(`Channel not found: ${channelId}`);
            return res.status(404).json({ error: 'Channel not found' });
        }

        Logger.info(`Starting DM backup for channel: ${channel.id} (${channel.recipient?.username || 'Unknown User'})`);
        
        const result = await backupDMChannel(channel);
        Logger.success(`DM backup completed: ${result.path}`);
        
        res.json({
            message: 'DM backup created successfully',
            success: true,
            details: {
                channelId: channel.id,
                recipientName: channel.recipient?.username || 'Unknown User',
                backupPath: result.path,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        Logger.error('DM Backup error:', error);
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

// Update the backup-guild route
app.post('/backup-guild', async (req, res) => {
    try {
        const { serverId } = req.body;
        const server = await discordService.getClient().guilds.fetch(serverId);
        
        if (!server) {
            Logger.error(`Server not found: ${serverId}`);
            return res.status(404).json({ error: 'Server not found' });
        }

        Logger.info(`Starting backup for server: ${server.name} (${server.id})`);

        const backupData = {
            type: 'guild',
            serverId: server.id,
            serverName: server.name,
            icon: server.iconURL(),
            roles: [],
            channels: []
        };

        // Backup roles
        Logger.info('Backing up roles...');
        server.roles.cache.forEach(role => {
            if (!role.managed && role.id !== server.id) {
                backupData.roles.push({
                    name: role.name,
                    color: role.color,
                    hoist: role.hoist,
                    position: role.position,
                    permissions: role.permissions.bitfield.toString(),
                    mentionable: role.mentionable
                });
            }
        });

        // First backup categories
        Logger.info('Backing up categories...');
        const categories = server.channels.cache.filter(c => c.type === 'GUILD_CATEGORY');
        for (const [_, category] of categories) {
            backupData.channels.push({
                name: category.name,
                type: 'GUILD_CATEGORY',
                position: category.position,
                permissionOverwrites: Array.from(category.permissionOverwrites.cache.values()).map(p => ({
                    id: p.id,
                    type: p.type,
                    allow: p.allow.bitfield.toString(),
                    deny: p.deny.bitfield.toString()
                }))
            });
        }

        // Then backup all other channels
        Logger.info('Backing up channels...');
        const channels = server.channels.cache.filter(c => c.type !== 'GUILD_CATEGORY');
        
        for (const [_, channel] of channels) {
            try {
                const channelData = {
                    name: channel.name,
                    type: channel.type,
                    position: channel.position,
                    topic: channel.topic,
                    nsfw: channel.nsfw,
                    bitrate: channel.bitrate,
                    userLimit: channel.userLimit,
                    rateLimitPerUser: channel.rateLimitPerUser,
                    parent: channel.parent?.name,
                    permissionOverwrites: Array.from(channel.permissionOverwrites.cache.values()).map(p => ({
                        id: p.id,
                        type: p.type,
                        allow: p.allow.bitfield.toString(),
                        deny: p.deny.bitfield.toString()
                    })),
                    messages: []
                };

                // Backup messages for text channels
                if (channel.type === 'GUILD_TEXT') {
                    Logger.info(`Fetching messages from #${channel.name}...`);
                    const messages = await channel.messages.fetch({ limit: 100 });
                    channelData.messages = messages.map(msg => ({
                        content: msg.content,
                        author: msg.author.username,
                        timestamp: msg.createdTimestamp,
                        attachments: Array.from(msg.attachments.values()).map(att => ({
                            url: att.url,
                            name: att.name
                        })),
                        embeds: msg.embeds,
                        webhookData: {
                            username: msg.author.username,
                            avatarURL: msg.author.displayAvatarURL()
                        }
                    }));
                    Logger.success(`✓ Backed up ${messages.size} messages from #${channel.name}`);
                }

                backupData.channels.push(channelData);
            } catch (error) {
                Logger.error(`Failed to backup channel #${channel.name}:`, error);
            }
        }

        // Save backup
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = Date.now();
        const backupId = `backup-guild-${server.id}-${timestamp}`;
        const backupPath = path.join(backupDir, `${backupId}.json`);
        
        await fs.promises.writeFile(backupPath, JSON.stringify(backupData, null, 2));
        Logger.success(`Server backup saved to: ${backupPath}`);

        res.json({
            message: `Server backup completed successfully`,
            success: true,
            backupId,
            details: {
                serverName: server.name,
                roles: backupData.roles.length,
                channels: backupData.channels.length,
                backupPath,
                timestamp: new Date().toISOString()
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
  const { backupId, targetId, type } = req.body;

  if (!backupId || !targetId || !type) {
    return res.status(400).json({ error: 'Missing backupId, targetId, or type' });
  }

  try {
    // Validate target channel/server first
    const client = discordService.getClient();
    let targetEntity;

    try {
      if (type === 'dm') {
        // For DMs, first try to fetch the channel
        targetEntity = await client.channels.fetch(targetId).catch(async () => {
          // If channel fetch fails, try to create a DM channel with the user
          const user = await client.users.fetch(targetId);
          return await user.createDM();
        });

        if (!targetEntity) {
          return res.status(404).json({ 
            error: 'Target channel not found or inaccessible',
            details: 'Could not find or create DM channel with the specified ID'
          });
        }

        // Check if bot can send messages to this channel
        if (!targetEntity.permissionsFor(client.user)?.has(['SEND_MESSAGES', 'MANAGE_WEBHOOKS'])) {
          return res.status(403).json({ 
            error: 'Insufficient permissions',
            details: 'Bot needs SEND_MESSAGES and MANAGE_WEBHOOKS permissions in the target channel'
          });
        }
      } else if (type === 'guild') {
        targetEntity = await client.guilds.fetch(targetId);
        if (!targetEntity) {
          return res.status(404).json({ 
            error: 'Target server not found',
            details: 'Could not find the specified server'
          });
        }

        // Check if bot has required permissions in the server
        const botMember = await targetEntity.members.fetch(client.user.id);
        if (!botMember.permissions.has(['MANAGE_CHANNELS', 'MANAGE_WEBHOOKS'])) {
          return res.status(403).json({ 
            error: 'Insufficient permissions',
            details: 'Bot needs MANAGE_CHANNELS and MANAGE_WEBHOOKS permissions in the target server'
          });
        }
      } else {
        return res.status(400).json({ error: 'Invalid restore type. Must be "dm" or "guild"' });
      }
    } catch (error) {
      Logger.error('Failed to validate target:', error);
      return res.status(404).json({ 
        error: 'Target validation failed',
        details: error.message
      });
    }

    // List all files in the backups directory
    const backupDir = path.join(__dirname, 'backups');
    const files = await fs.promises.readdir(backupDir);
    
    // Find a matching backup file
    const backupFile = files.find(file => 
      file.includes(backupId) || // Match by ID
      file.includes(`backup-${type}`) || // Match by type
      file.includes(`server-${backupId}`) // Match server backups
    );

    if (!backupFile) {
      Logger.error('No matching backup file found in directory. Available files:', files);
      return res.status(404).json({ 
        error: 'Backup file not found',
        details: {
          availableFiles: files,
          searchedFor: backupId
        }
      });
    }

    const backupFilePath = path.join(backupDir, backupFile);
    Logger.success(`Found backup file: ${backupFilePath}`);

    // Read and parse backup data
    let backupData;
    try {
      const fileContent = await fs.promises.readFile(backupFilePath, 'utf8');
      Logger.info('Successfully read backup file');
      
      try {
        backupData = JSON.parse(fileContent);
        Logger.info('Successfully parsed backup data');
      } catch (parseError) {
        Logger.error('Failed to parse backup file:', parseError);
        return res.status(400).json({ 
          error: 'Invalid backup file format: Failed to parse JSON',
          details: parseError.message
        });
      }
    } catch (readError) {
      Logger.error('Failed to read backup file:', readError);
      return res.status(500).json({ 
        error: 'Failed to read backup file',
        details: readError.message
      });
    }

    // Handle different backup data formats
    if (Array.isArray(backupData)) {
      backupData = { messages: backupData };
    } else if (typeof backupData === 'object') {
      // If it's a DM backup
      if (backupData.type === 'dm' && backupData.messages) {
        // Already in correct format
      }
      // If it's a guild backup
      else if (backupData.type === 'guild' && backupData.channels) {
        backupData = {
          messages: backupData.channels.flatMap(channel => channel.messages || [])
        };
      }
      // If neither messages nor channels exist, check if it's a single message
      else if (!backupData.messages && !backupData.channels) {
        if (backupData.content || backupData.author) {
          backupData = { messages: [backupData] };
        } else {
          return res.status(400).json({ 
            error: 'Invalid backup data format',
            details: 'Backup file does not contain any valid message data'
          });
        }
      }
    } else {
      return res.status(400).json({ 
        error: 'Invalid backup data format',
        details: 'Backup data must be an array of messages or a valid backup object'
      });
    }

    // Validate that we have messages to restore
    if (!backupData.messages || !Array.isArray(backupData.messages) || backupData.messages.length === 0) {
      return res.status(400).json({ 
        error: 'No messages to restore',
        details: 'The backup file contains no valid messages'
      });
    }

    Logger.info(`Found ${backupData.messages.length} messages to restore`);

    if (type === 'guild') {
      // Get target guild
      const guild = await discordService.getClient().guilds.fetch(targetId);
      if (!guild) {
        return res.status(404).json({ error: 'Target server not found' });
      }

      // Check bot permissions
      const botMember = await guild.members.fetch(discordService.getClient().user.id);
      if (!botMember.permissions.has(['MANAGE_CHANNELS', 'MANAGE_WEBHOOKS'])) {
        return res.status(403).json({ error: 'Bot lacks required permissions in target server' });
      }

      // Restore server
      const result = await restoreGuild(backupData, targetId);
      res.status(200).json({ message: result.message });
    } else if (type === 'dm') {
      // Get target channel
      const channel = await discordService.getClient().channels.fetch(targetId);
      if (!channel) {
        return res.status(404).json({ error: 'Target channel not found' });
      }

      // Check bot permissions
      if (!channel.permissionsFor(discordService.getClient().user.id).has(['SEND_MESSAGES', 'MANAGE_WEBHOOKS'])) {
        return res.status(403).json({ error: 'Bot lacks required permissions in target channel' });
      }

      // Create webhook
      let webhook = null;
      try {
        webhook = await channel.createWebhook('Message Restore', {
          avatar: discordService.getClient().user.displayAvatarURL()
        });
      } catch (error) {
        return res.status(500).json({ error: 'Failed to create webhook' });
      }

      try {
        // Sort messages by timestamp
        const messages = backupData.messages.sort((a, b) => a.timestamp - b.timestamp);
        let restoredCount = 0;
        let failedCount = 0;

        // Restore messages with rate limiting
        for (const message of messages) {
          try {
            // Send message content
            if (message.content?.trim()) {
              await webhook.send({
                content: message.content,
                username: message.author || 'Unknown User',
                avatarURL: message.webhookData?.avatarURL
              });
              await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit between messages
            }

            // Send attachments
            if (message.attachments?.length > 0) {
              for (const attachment of message.attachments) {
                try {
                  await webhook.send({
                    files: [{
                      attachment: attachment.url,
                      name: attachment.filename || attachment.name || 'attachment'
                    }],
                    username: message.author || 'Unknown User',
                    avatarURL: message.webhookData?.avatarURL
                  });
                  await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit between attachments
                } catch (attachError) {
                  Logger.error(`Failed to restore attachment: ${attachError.message}`);
                }
              }
            }

            restoredCount++;
            Logger.success(`Restored message ${restoredCount}`);
          } catch (messageError) {
            Logger.error(`Failed to restore message: ${messageError.message}`);
            failedCount++;

            // Stop if too many consecutive failures
            if (failedCount > 5) {
              throw new Error('Too many consecutive failures, stopping restore');
            }
          }
        }

        res.status(200).json({
          message: `Restored ${restoredCount} messages${failedCount > 0 ? ` (${failedCount} failed)` : ''}`
        });
      } finally {
        // Always clean up webhook
        if (webhook) {
          try {
            await webhook.delete();
          } catch (error) {
            Logger.error('Failed to delete webhook:', error);
          }
        }
      }
    } else {
      return res.status(400).json({ error: 'Invalid restore type' });
    }
  } catch (error) {
    Logger.error('Restore failed:', error);
    res.status(500).json({ error: error.message });
  }
});

async function restoreGuild(backupData, targetGuildId, clearServerBeforeRestore = true) {
    const guild = await discordService.getClient().guilds.fetch(targetGuildId);
    if (!guild) throw new Error('Guild not found');

    // Validate backup data structure
    if (!backupData || typeof backupData !== 'object') {
        throw new Error('Invalid backup data format');
    }

    backupData.channels = backupData.channels || [];
    backupData.roles = backupData.roles || [];

    Logger.info(`Restoring guild with ${backupData.channels.length} channels and ${backupData.roles.length} roles`);

    if (clearServerBeforeRestore) {
        Logger.info('Clearing existing channels and roles...');
        await Promise.all(
            guild.channels.cache
                .filter(channel => channel.deletable)
                .map(channel => channel.delete().catch(err => Logger.error(`Failed to delete channel ${channel.name}:`, err)))
        );
        await Promise.all(
            guild.roles.cache
                .filter(role => role.editable && !role.managed && role.id !== guild.id)
                .map(role => role.delete().catch(err => Logger.error(`Failed to delete role ${role.name}:`, err)))
        );
    }

    let restoredRoles = 0;
    let restoredChannels = 0;
    let restoredMessages = 0;
    let failedCount = 0;

    try {
        // First restore roles
        Logger.info('Restoring roles...');
        const roles = new Map();
        for (const roleData of backupData.roles.sort((a, b) => b.position - a.position)) {
            try {
                const role = await guild.roles.create({
                    name: roleData.name,
                    color: roleData.color,
                    hoist: roleData.hoist,
                    permissions: BigInt(roleData.permissions || '0'),
                    mentionable: roleData.mentionable,
                    position: roleData.position,
                    reason: 'Server Restore'
                });
                roles.set(roleData.name, role.id);
                restoredRoles++;
                await delay(1000);
            } catch (error) {
                Logger.error(`Failed to create role ${roleData.name}:`, error);
                failedCount++;
            }
        }

        // Then restore categories
        Logger.info('Restoring categories...');
        const categories = new Map();
        const categoryChannels = backupData.channels.filter(c => 
            c && (c.type === 'GUILD_CATEGORY' || c.type === 4)
        );

        for (const categoryData of categoryChannels) {
            try {
                const category = await guild.channels.create({
                    name: categoryData.name,
                    type: 4,
                    permissionOverwrites: categoryData.permissionOverwrites?.map(p => ({
                        id: roles.get(p.id) || p.id,
                        type: p.type,
                        allow: BigInt(p.allow || '0'),
                        deny: BigInt(p.deny || '0')
                    })) || [],
                    position: categoryData.position,
                    reason: 'Server Restore'
                });
                categories.set(categoryData.name, category.id);
                restoredChannels++;
                await delay(1000);
            } catch (error) {
                Logger.error(`Failed to create category ${categoryData.name}:`, error);
                failedCount++;
            }
        }

        // Finally restore channels
        Logger.info('Restoring channels and messages...');
        const channels = backupData.channels.filter(c => 
            c && c.type !== 'GUILD_CATEGORY' && c.type !== 4
        );

        for (const channelData of channels) {
            try {
                const channel = await guild.channels.create({
                    name: channelData.name,
                    type: typeof channelData.type === 'string' ? 0 : channelData.type, // Default to text channel
                    topic: channelData.topic,
                    nsfw: channelData.nsfw,
                    bitrate: channelData.bitrate,
                    userLimit: channelData.userLimit,
                    parent: channelData.parent ? categories.get(channelData.parent) : null,
                    permissionOverwrites: channelData.permissionOverwrites?.map(p => ({
                        id: roles.get(p.id) || p.id,
                        type: p.type,
                        allow: BigInt(p.allow || '0'),
                        deny: BigInt(p.deny || '0')
                    })) || [],
                    rateLimitPerUser: channelData.rateLimitPerUser,
                    position: channelData.position,
                    reason: 'Server Restore'
                });

                // Restore messages if present
                if (channelData.messages?.length > 0) {
                    const webhook = await channel.createWebhook({
                        name: 'Server Restore',
                        avatar: discordService.getClient().user.displayAvatarURL()
                    });

                    try {
                        for (const message of channelData.messages) {
                            try {
                                const webhookData = {
                                    content: message.content || '',
                                    username: message.author?.username || message.author || 'Unknown User',
                                    avatarURL: message.webhookData?.avatarURL,
                                    files: [],
                                    embeds: message.embeds || [],
                                    allowedMentions: { parse: [] }
                                };

                                // Handle attachments
                                if (message.attachments?.length > 0) {
                                    webhookData.files = message.attachments.map(att => ({
                                        attachment: att.url,
                                        name: att.name || 'attachment'
                                    }));
                                }

                                await webhook.send(webhookData);
                                restoredMessages++;
                                await delay(1000);
                            } catch (error) {
                                Logger.error(`Failed to restore message in ${channel.name}:`, error);
                                failedCount++;
                            }
                        }
                    } finally {
                        await webhook.delete().catch(console.error);
                    }
                }
                restoredChannels++;
                await delay(1000);
            } catch (error) {
                Logger.error(`Failed to restore channel ${channelData.name}:`, error);
                failedCount++;
            }
        }

        return {
            success: true,
            restoredRoles,
            restoredChannels,
            restoredMessages,
            failedCount,
            message: `Restored ${restoredRoles} roles, ${restoredChannels} channels, ${restoredMessages} messages${failedCount > 0 ? `, ${failedCount} failed` : ''}`
        };

    } catch (error) {
        Logger.error('Server restore failed:', error);
        throw error;
    }
}

// Add delay helper function if not already present
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// Add upload and restore endpoint
app.post('/restore-with-webhook', upload.single('backupFile'), async (req, res) => {
  try {
    const { targetId } = req.body;
    const uploadedFile = req.file;

    if (!targetId || !uploadedFile) {
      return res.status(400).json({ error: 'Missing target ID or backup file' });
    }

    // Read the uploaded file
    const fileContent = await fs.promises.readFile(uploadedFile.path, 'utf8');
    let backupData;
    
    try {
      backupData = JSON.parse(fileContent);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid backup file format' });
    }

    // Get target channel
    const channel = await discordService.getClient().channels.fetch(targetId);
    if (!channel) {
      return res.status(404).json({ error: 'Target channel not found' });
    }

    // Check permissions
    if (!channel.permissionsFor(discordService.getClient().user.id).has(['SEND_MESSAGES', 'MANAGE_WEBHOOKS'])) {
      return res.status(403).json({ error: 'Bot lacks required permissions in target channel' });
    }

    // Create webhook
    const webhook = await channel.createWebhook('Message Restore', {
      avatar: discordService.getClient().user.displayAvatarURL()
    });

    try {
      // Handle different backup formats
      const messages = Array.isArray(backupData) ? backupData :
        backupData.messages ? backupData.messages :
        backupData.channels ? backupData.channels.flatMap(c => c.messages) : [];

      let restoredCount = 0;
      let failedCount = 0;

      // Sort messages by timestamp if available
      const sortedMessages = messages.sort((a, b) => 
        (a.timestamp || 0) - (b.timestamp || 0)
      );

      for (const message of sortedMessages) {
        try {
          // Send message content
          if (message.content?.trim()) {
            await webhook.send({
              content: message.content,
              username: message.author || message.webhookData?.username || 'Unknown User',
              avatarURL: message.webhookData?.avatarURL
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          // Send attachments
          if (message.attachments?.length > 0) {
            for (const attachment of message.attachments) {
              try {
                if (attachment.url) {
                  await webhook.send({
                    files: [{
                      attachment: attachment.url,
                      name: attachment.filename || attachment.name || 'attachment'
                    }],
                    username: message.author || message.webhookData?.username || 'Unknown User',
                    avatarURL: message.webhookData?.avatarURL
                  });
                  await new Promise(resolve => setTimeout(resolve, 1000));
                }
              } catch (attachError) {
                Logger.error(`Failed to restore attachment: ${attachError.message}`);
              }
            }
          }

          restoredCount++;
          Logger.success(`Restored message ${restoredCount}`);
        } catch (error) {
          Logger.error(`Failed to restore message: ${error.message}`);
          failedCount++;

          if (failedCount > 5) {
            throw new Error('Too many consecutive failures, stopping restore');
          }
        }
      }

      res.json({
        success: true,
        message: `Restored ${restoredCount} messages${failedCount > 0 ? ` (${failedCount} failed)` : ''}`
      });
    } finally {
      // Cleanup
      if (webhook) {
        try {
          await webhook.delete();
        } catch (error) {
          Logger.error('Failed to delete webhook:', error);
        }
      }
      // Delete uploaded file
      try {
        await fs.promises.unlink(uploadedFile.path);
      } catch (error) {
        Logger.error('Failed to delete uploaded file:', error);
      }
    }
  } catch (error) {
    Logger.error('Restore failed:', error);
    res.status(500).json({ error: error.message });
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
