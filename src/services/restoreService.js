const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const Logger = require('../utils/logger');
const config = require('../config/config');
const { delay } = require('../utils/helpers');
const fetch = require('node-fetch');
const { Worker } = require('worker_threads');
const WorkerPool = require('../../workerPool');

class RestoreService {
    constructor(client) {
        this.client = client;
        this.messagePool = new WorkerPool(
            path.join(__dirname, '../../messageWorker.js'),
            2  // Use 2 worker threads
        );
    }

    // Helper to sanitize channel name while preserving emojis
    sanitizeChannelName(name) {
        // Preserve emoji patterns (both unicode and custom discord emojis)
        const emojiPattern = /(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26FF]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])|<:[^:]+:[0-9]+>/g;
        
        // Split name into emoji and non-emoji parts
        const parts = name.split(emojiPattern);
        const emojis = name.match(emojiPattern) || [];
        
        // Sanitize non-emoji parts and reconstruct with emojis
        let sanitizedParts = parts.map(part => 
            part.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
        );
        
        // Reconstruct name with emojis
        let finalName = '';
        for (let i = 0; i < Math.max(sanitizedParts.length, emojis.length); i++) {
            if (sanitizedParts[i]) finalName += sanitizedParts[i];
            if (emojis[i]) finalName += emojis[i];
        }
        
        // Ensure the name is not empty and starts with a valid character
        finalName = finalName.trim();
        if (!finalName || /^[^a-z0-9]/.test(finalName)) {
            finalName = 'channel-' + finalName;
        }
        
        return finalName;
    }

    async restoreMessages(channelId, backupFilePath) {
        try {
            // Read and parse backup file
            const fileContent = await fs.readFile(backupFilePath, 'utf-8');
            let messages;
            
            try {
                const backupData = JSON.parse(fileContent);
                messages = Array.isArray(backupData) ? backupData : backupData.messages || [];
                messages = messages.sort((a, b) => a.timestamp - b.timestamp);
            } catch (error) {
                throw new Error(`Failed to parse backup file: ${error.message}`);
            }

            // Get target channel
            const channel = await this.client.channels.fetch(channelId);
            if (!channel) {
                throw new Error('Channel not found');
            }

            Logger.info(`Starting restore to channel ${channel.id}`);
            let restoredCount = 0;
            let failedCount = 0;

            // Process messages
            for (const message of messages) {
                try {
                    // Send content
                    if (message.content?.trim()) {
                        await channel.send({
                            content: message.content
                        });
                    }

                    // Send attachments
                    if (message.attachments?.length > 0) {
                        for (const attachment of message.attachments) {
                            if (attachment.url) {
                                await channel.send({
                                    files: [attachment.url]
                                });
                                await delay(1000);
                            }
                        }
                    }
                    restoredCount++;
                    Logger.success(`Restored message ${restoredCount}`);
                } catch (error) {
                    Logger.error(`Failed to restore message: ${error.message}`);
                    failedCount++;
                }
                await delay(1000);
            }

            return {
                success: true,
                restoredCount,
                failedCount,
                message: `Restored ${restoredCount} messages${failedCount > 0 ? `, ${failedCount} failed` : ''}`
            };
        } catch (error) {
            Logger.error('Restore failed:', error);
            throw error;
        }
    }

    async restoreDMMessage(channel, message) {
        try {
            // Send text content
            if (message.content?.trim()) {
                await channel.send({
                    content: message.content,
                    // For DMs, we don't use webhooks, so we send as the bot
                    allowedMentions: { parse: [] } // Prevent unwanted mentions
                });
            }

            // Send attachments
            if (message.attachments?.length > 0) {
                for (const attachment of message.attachments) {
                    try {
                        if (attachment.url) {
                            await channel.send({
                                files: [attachment.url],
                                allowedMentions: { parse: [] }
                            });
                        }
                        await this.delay(1000); // Rate limit between attachments
                    } catch (error) {
                        Logger.error(`Failed to restore attachment: ${error.message}`);
                    }
                }
            }
            await this.delay(1000); // Rate limit between messages
        } catch (error) {
            Logger.error(`Failed to restore DM message: ${error.message}`);
            throw error;
        }
    }

    async restoreServerMessage(webhook, message) {
        const messageOptions = {
            username: message.webhookData?.username || message.author,
            avatarURL: message.webhookData?.avatarURL,
            content: message.content
        };

        // Send text content
        if (message.content?.trim()) {
            await webhook.send(messageOptions);
        }

        // Send attachments
        if (message.attachments?.length > 0) {
            for (const attachment of message.attachments) {
                if (attachment.url) {
                    await webhook.send({
                        ...messageOptions,
                        files: [attachment.url]
                    });
                    await delay(1000);
                }
            }
        }
    }

    async restoreDirectMessages(sourceChannelId, targetChannelId, type = 'dm') {
        try {
            // Validate channel IDs
            if (!sourceChannelId || !targetChannelId) {
                throw new Error('Source and target channel IDs are required');
            }

            // Validate ID format
            if (!/^\d+$/.test(sourceChannelId) || !/^\d+$/.test(targetChannelId)) {
                throw new Error('Invalid channel ID format. IDs must be numeric.');
            }

            Logger.info(`Attempting to fetch channels - Source: ${sourceChannelId}, Target: ${targetChannelId}`);

            // Get source and target channels with better error handling
            let sourceChannel;
            if (type === 'dm' || type === 'group') {
                try {
                    // For group DMs, we can fetch the channel directly
                    if (type === 'group') {
                        try {
                            sourceChannel = await this.client.channels.fetch(sourceChannelId);
                            if (!sourceChannel) {
                                throw new Error('Group channel not found');
                            }
                            Logger.success(`Found group channel: ${sourceChannel.name}`);
                        } catch (error) {
                            Logger.error(`Failed to fetch group channel: ${error.message}`);
                            throw new Error(`Could not access group channel (ID: ${sourceChannelId})`);
                        }
                    } else {
                        // Existing DM channel code...
                        let user;
                        try {
                            user = await this.client.users.fetch(sourceChannelId, { force: true });
                        } catch (userError) {
                            if (userError.code === 10013) {
                                const error = new Error(`User not found. The user ID ${sourceChannelId} does not exist on Discord.`);
                                error.code = 10013;
                                throw error;
                            } else if (userError.code === 50001) {
                                const error = new Error(`Cannot access user. The user may have blocked the bot or has DMs disabled (ID: ${sourceChannelId})`);
                                error.code = 50001;
                                throw error;
                            } else {
                                const error = new Error(`Failed to fetch user: ${userError.message} (ID: ${sourceChannelId})`);
                                error.code = userError.code;
                                throw error;
                            }
                        }

                        // ... existing DM channel creation code ...
                    }

                    Logger.success(`Created/fetched ${type} channel`);
                } catch (error) {
                    Logger.error(`Failed to setup ${type} channel: ${error.message}`);
                    const newError = new Error(`Could not access ${type} channel (ID: ${sourceChannelId}) - ${error.message}`);
                    newError.code = error.code;
                    throw newError;
                }
            } else if (type === 'guild') {
                try {
                    // Get the channel directly instead of searching through all guilds
                    sourceChannel = await this.client.channels.fetch(sourceChannelId);
                    if (!sourceChannel) {
                        throw new Error('Channel not found');
                    }
                    Logger.success(`Found server channel: #${sourceChannel.name} in ${sourceChannel.guild.name}`);
                } catch (error) {
                    Logger.error(`Failed to fetch server channel: ${error.message}`);
                    throw new Error(`Could not access server channel (ID: ${sourceChannelId})`);
                }
            } else {
                throw new Error(`Invalid channel type: ${type}. Must be 'dm', 'group', or 'guild'`);
            }

            // Get target channel
            const targetChannel = await this.client.channels.fetch(targetChannelId)
                .catch(error => {
                    Logger.error(`Failed to fetch target channel: ${error.message}`);
                    throw new Error(`Target channel not found or not accessible (ID: ${targetChannelId})`);
                });

            // Validate channel types and permissions
            if (!targetChannel.isText()) {
                throw new Error('Target channel must be a text channel');
            }

            // Check permissions for target channel
            const permissions = targetChannel.permissionsFor(this.client.user);
            if (!permissions.has(['SEND_MESSAGES', 'MANAGE_WEBHOOKS'])) {
                throw new Error('Bot lacks required permissions in target channel (needs SEND_MESSAGES and MANAGE_WEBHOOKS)');
            }

            Logger.info(`Starting restore from ${type === 'dm' ? 'DM' : 'server'} to ${targetChannel.name}`);
            let restoredCount = 0;
            let failedCount = 0;

            // Create webhook for target channel
            let webhook = null;
            try {
                webhook = await targetChannel.createWebhook('Message Restore Bot', {
                    avatar: this.client.user.displayAvatarURL()
                });
                Logger.success('Created webhook for message restore');
            } catch (error) {
                Logger.error('Failed to create webhook:', error);
                throw new Error(`Failed to create webhook: ${error.message}. Check bot permissions.`);
            }

            try {
                // Fetch all messages using pagination
                let allMessages = [];
                let lastId = null;
                let hasMore = true;

                while (hasMore) {
                    const options = { limit: 100 };
                    if (lastId) {
                        options.before = lastId;
                    }

                    const messages = await sourceChannel.messages.fetch(options);
                    
                    if (messages.size === 0) {
                        hasMore = false;
                        break;
                    }

                    allMessages = [...allMessages, ...Array.from(messages.values())];
                    lastId = messages.last().id;
                    
                    await delay(1000); // Rate limit handling
                }

                if (allMessages.length === 0) {
                    throw new Error('No messages found in the source channel');
                }

                const sortedMessages = allMessages
                    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

                Logger.info(`Found ${sortedMessages.length} messages to restore`);

                for (const message of sortedMessages) {
                    try {
                        // Skip empty messages
                        if (!message.content && !message.attachments.size && !message.embeds.length) {
                            continue;
                        }

                        // Prepare webhook data with original sender info
                        const webhookData = {
                            username: message.author.username,
                            avatarURL: message.author.displayAvatarURL(),
                            content: message.content || '',
                            embeds: message.embeds || [],
                            files: [],
                            allowedMentions: { parse: [] } // Prevent unwanted pings
                        };

                        // Handle attachments
                        if (message.attachments.size > 0) {
                            for (const [_, attachment] of message.attachments) {
                                try {
                                    // Verify attachment is accessible
                                    const response = await fetch(attachment.url, { method: 'HEAD' });
                                    if (response.ok) {
                                        webhookData.files.push({
                                            attachment: attachment.url,
                                            name: attachment.name
                                        });
                                    }
                                } catch (error) {
                                    Logger.error(`Failed to verify attachment ${attachment.url}:`, error);
                                }
                            }
                        }

                        // Send message through webhook
                        await webhook.send(webhookData);
                        restoredCount++;
                        Logger.success(`Restored message ${restoredCount} from ${webhookData.username}`);

                        // Rate limiting
                        await delay(1000);
                    } catch (error) {
                        Logger.error(`Failed to restore message:`, error);
                        failedCount++;
                    }
                }

                return {
                    success: true,
                    restoredCount,
                    failedCount,
                    message: `Restored ${restoredCount} messages${failedCount > 0 ? `, ${failedCount} failed` : ''}`
                };
            } finally {
                // Cleanup webhook
                if (webhook) {
                    try {
                        await webhook.delete();
                        Logger.info('Cleaned up webhook');
                    } catch (error) {
                        Logger.error('Failed to delete webhook:', error);
                        // Don't throw here as it's cleanup code
                    }
                }
            }
        } catch (error) {
            Logger.error('Restore failed:', error);
            throw error;
        }
    }

    async restoreServer(serverId, backupData) {
        try {
            const guild = await this.client.guilds.fetch(serverId);
            if (!guild) {
                throw new Error('Server not found');
            }

            Logger.info(`Starting restore for server: ${guild.name}`);

            // Verify bot permissions
            const botMember = await guild.members.fetch(this.client.user.id);
            const requiredPermissions = ['MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_WEBHOOKS', 'MANAGE_GUILD'];
            const missingPermissions = requiredPermissions.filter(perm => !botMember.permissions.has(perm));
            
            if (missingPermissions.length > 0) {
                throw new Error(`Bot lacks required permissions: ${missingPermissions.join(', ')}`);
            }

            let progress = {
                rolesRestored: 0,
                channelsRestored: 0,
                messagesRestored: 0,
                errors: []
            };

            // PHASE 1: Restore Roles
            if (backupData.roles && backupData.roles.length > 0) {
                Logger.info('=== PHASE 1: Restoring Roles ===');
                
                // Delete existing roles if specified
                if (backupData.clearExistingRoles) {
                    await Promise.all(guild.roles.cache
                        .filter(role => role.editable && !role.managed)
                        .map(role => role.delete()
                            .catch(error => {
                                Logger.error(`Failed to delete role ${role.name}:`, error);
                                progress.errors.push({ type: 'role_deletion', name: role.name, error: error.message });
                            })
                        )
                    );
                }

                // Sort roles by position (highest first)
                const sortedRoles = backupData.roles
                    .sort((a, b) => (b.position || 0) - (a.position || 0));

                for (const roleData of sortedRoles) {
                    try {
                        if (roleData.managed) continue; // Skip managed roles

                        const role = await guild.roles.create({
                            name: roleData.name,
                            color: roleData.color,
                            hoist: roleData.hoist,
                            position: roleData.position,
                            permissions: BigInt(roleData.permissions),
                            mentionable: roleData.mentionable,
                            reason: 'Server restore: Role creation'
                        });

                        progress.rolesRestored++;
                        Logger.success(`Created role: ${role.name}`);
                        await delay(1000);
                    } catch (error) {
                        Logger.error(`Failed to create role ${roleData.name}:`, error);
                        progress.errors.push({ type: 'role_creation', name: roleData.name, error: error.message });
                    }
                }
            }

            // PHASE 2: Channel Creation
            if (backupData.channels && backupData.channels.length > 0) {
                Logger.info('=== PHASE 2: Creating Channels ===');
                
                // Delete existing channels if specified
                if (backupData.clearExistingChannels) {
                    await Promise.all(guild.channels.cache
                        .filter(channel => channel.deletable)
                        .map(channel => channel.delete()
                            .catch(error => {
                                Logger.error(`Failed to delete channel ${channel.name}:`, error);
                                progress.errors.push({ type: 'channel_deletion', name: channel.name, error: error.message });
                            })
                        )
                    );
                }

                // First create categories
                const categories = new Map();
                const categoryChannels = backupData.channels
                    .filter(c => c.type === 'GUILD_CATEGORY' || c.type === 'category')
                    .sort((a, b) => (a.position || 0) - (b.position || 0));

                for (const categoryData of categoryChannels) {
                    try {
                        const categoryOptions = {
                            type: 'GUILD_CATEGORY',
                            position: categoryData.position || 0,
                            permissionOverwrites: categoryData.permissionOverwrites?.map(perm => ({
                                id: perm.id,
                                type: perm.type || 'role',
                                allow: BigInt(perm.allow || '0'),
                                deny: BigInt(perm.deny || '0')
                            })) || [],
                            reason: 'Server restore: Category creation'
                        };

                        const category = await guild.channels.create(categoryData.name, categoryOptions);
                        categories.set(categoryData.id, category.id);
                        categories.set(categoryData.name, category.id); // Also map by name for flexibility
                        progress.channelsRestored++;
                        Logger.success(`Created category: ${category.name}`);
                        await delay(1000);
                    } catch (error) {
                        Logger.error(`Failed to create category ${categoryData.name}:`, error);
                        progress.errors.push({ type: 'category_creation', name: categoryData.name, error: error.message });
                    }
                }

                // Then create other channels
                const nonCategoryChannels = backupData.channels
                    .filter(c => c.type !== 'GUILD_CATEGORY' && c.type !== 'category')
                    .sort((a, b) => (a.position || 0) - (b.position || 0));

                for (const channelData of nonCategoryChannels) {
                    try {
                        // Map channel types
                        let channelType = channelData.type;
                        if (typeof channelType === 'string') {
                            channelType = channelType.toUpperCase();
                            if (!channelType.startsWith('GUILD_')) {
                                channelType = `GUILD_${channelType}`;
                            }
                        }

                        // Find parent category
                        let parentId = null;
                        if (channelData.parentId) {
                            parentId = categories.get(channelData.parentId);
                        } else if (channelData.parent) {
                            parentId = categories.get(channelData.parent);
                        } else if (channelData.categoryName) {
                            parentId = categories.get(channelData.categoryName);
                        }

                        const channelOptions = {
                            type: channelType,
                            topic: channelData.topic,
                            nsfw: channelData.nsfw,
                            bitrate: channelData.bitrate,
                            userLimit: channelData.userLimit,
                            rateLimitPerUser: channelData.rateLimitPerUser,
                            position: channelData.position,
                            permissionOverwrites: channelData.permissionOverwrites?.map(perm => ({
                                id: perm.id,
                                type: perm.type || 'role',
                                allow: BigInt(perm.allow || '0'),
                                deny: BigInt(perm.deny || '0')
                            })) || [],
                            parent: parentId,
                            reason: 'Server restore: Channel creation'
                        };

                        const channel = await guild.channels.create(channelData.name, channelOptions);
                        progress.channelsRestored++;
                        Logger.success(`Created channel: ${channel.name} ${parentId ? 'in category' : ''}`);

                        // Restore messages if present
                        if (channelData.messages && channelData.messages.length > 0) {
                            const webhook = await channel.createWebhook('Message Restore', {
                                avatar: this.client.user.displayAvatarURL()
                            });

                            try {
                                for (const message of channelData.messages) {
                                    try {
                                        await webhook.send({
                                            content: message.content,
                                            username: message.author?.username || 'Unknown User',
                                            avatarURL: message.author?.avatarURL,
                                            embeds: message.embeds || [],
                                            files: message.attachments || [],
                                            allowedMentions: { parse: [] }
                                        });
                                        progress.messagesRestored++;
                                        await delay(1000);
                                    } catch (error) {
                                        Logger.error(`Failed to restore message in ${channel.name}:`, error);
                                    }
                                }
                            } finally {
                                await webhook.delete().catch(console.error);
                            }
                        }

                        await delay(1000);
                    } catch (error) {
                        Logger.error(`Failed to create channel ${channelData.name}:`, error);
                        progress.errors.push({ type: 'channel_creation', name: channelData.name, error: error.message });
                    }
                }

                // Update channel positions
                try {
                    // First update category positions
                    const categoryPositions = Array.from(guild.channels.cache.values())
                        .filter(channel => channel.type === 'GUILD_CATEGORY')
                        .sort((a, b) => (a.position || 0) - (b.position || 0))
                        .map(channel => ({
                            channel: channel.id,
                            position: channel.position
                        }));

                    if (categoryPositions.length > 0) {
                        await guild.channels.setPositions(categoryPositions);
                        Logger.success('Updated category positions');
                    }

                    // Then update channel positions within categories
                    const channelPositions = Array.from(guild.channels.cache.values())
                        .filter(channel => channel.type !== 'GUILD_CATEGORY')
                        .sort((a, b) => (a.position || 0) - (b.position || 0))
                        .map(channel => ({
                            channel: channel.id,
                            position: channel.position
                        }));

                    if (channelPositions.length > 0) {
                        await guild.channels.setPositions(channelPositions);
                        Logger.success('Updated channel positions');
                    }
                } catch (error) {
                    Logger.error('Failed to update channel positions:', error);
                    progress.errors.push({ type: 'position_update', error: error.message });
                }
            }

            return {
                success: true,
                progress,
                message: `Server restored successfully: ${progress.rolesRestored} roles, ${progress.channelsRestored} channels, ${progress.messagesRestored} messages. ${progress.errors.length} errors occurred.`
            };
        } catch (error) {
            Logger.error('Server restore failed:', error);
            throw error;
        }
    }

    async backupServer(guild) {
        try {
            Logger.info(`Starting backup for server: ${guild.name}`);

            const backupData = {
                id: guild.id,
                name: guild.name,
                icon: guild.iconURL(),
                channels: [],
                roles: []
            };

            // Backup roles first
            guild.roles.cache.forEach(role => {
                backupData.roles.push({
                    id: role.id,
                    name: role.name,
                    color: role.color,
                    hoist: role.hoist,
                    position: role.position,
                    permissions: role.permissions.bitfield.toString(),
                    mentionable: role.mentionable
                });
            });

            // First backup categories
            const categories = guild.channels.cache
                .filter(channel => channel.type === 'GUILD_CATEGORY')
                .sort((a, b) => a.position - b.position);

            for (const category of categories.values()) {
                try {
                    backupData.channels.push({
                        id: category.id,
                        name: category.name,
                        type: 'category',
                        position: category.position,
                        permissionOverwrites: Array.from(category.permissionOverwrites.cache.values()).map(perm => ({
                            id: perm.id,
                            type: perm.type,
                            allow: perm.allow.bitfield.toString(),
                            deny: perm.deny.bitfield.toString()
                        }))
                    });
                } catch (error) {
                    Logger.error(`Failed to backup category ${category.name}:`, error);
                }
            }

            // Then backup other channels
            const nonCategoryChannels = guild.channels.cache
                .filter(channel => channel.type !== 'GUILD_CATEGORY')
                .sort((a, b) => a.position - b.position);

            for (const channel of nonCategoryChannels.values()) {
                try {
                    const channelData = {
                        id: channel.id,
                        name: channel.name,
                        type: channel.type,
                        position: channel.position,
                        parentId: channel.parentId,
                        topic: channel.topic || "",
                        nsfw: channel.nsfw || false,
                        rateLimitPerUser: channel.rateLimitPerUser || 0,
                        permissionOverwrites: Array.from(channel.permissionOverwrites.cache.values()).map(perm => ({
                            id: perm.id,
                            type: perm.type,
                            allow: perm.allow.bitfield.toString(),
                            deny: perm.deny.bitfield.toString()
                        }))
                    };

                    // Add forum-specific data
                    if (channel.type === 'GUILD_FORUM') {
                        channelData.availableTags = channel.availableTags || [];
                        channelData.defaultForumLayout = channel.defaultForumLayout;
                        channelData.defaultReactionEmoji = channel.defaultReactionEmoji;
                        channelData.defaultSortOrder = channel.defaultSortOrder;
                        channelData.defaultThreadRateLimitPerUser = channel.defaultThreadRateLimitPerUser;
                        channelData.guidelines = channel.guidelines;
                        channelData.posts = [];

                        // Backup forum posts (threads)
                        Logger.info(`Backing up forum posts for ${channel.name}`);
                        
                        // Get active threads first
                        const activeThreads = await channel.threads.fetchActive();
                        let threads = activeThreads.threads;
                        
                        // Then get archived threads
                        const archivedThreads = await channel.threads.fetchArchived();
                        threads = threads.concat(archivedThreads.threads);

                        for (const thread of threads.values()) {
                            try {
                                const threadData = {
                                    name: thread.name,
                                    content: thread.startMessage?.content,
                                    createdTimestamp: thread.createdTimestamp,
                                    archived: thread.archived,
                                    locked: thread.locked,
                                    pinned: thread.pinned,
                                    tags: thread.appliedTags,
                                    messages: [],
                                    attachments: [],
                                    embeds: thread.startMessage?.embeds || []
                                };

                                // Backup thread attachments
                                if (thread.startMessage?.attachments) {
                                    threadData.attachments = Array.from(thread.startMessage.attachments.values())
                                        .map(att => ({
                                            url: att.url,
                                            name: att.name,
                                            description: att.description
                                        }));
                                }

                                // Backup thread messages
                                let lastId = null;
                                let hasMore = true;

                                while (hasMore) {
                                    const options = { limit: 100 };
                                    if (lastId) options.before = lastId;

                                    const messages = await thread.messages.fetch(options);
                                    if (messages.size === 0) {
                                        hasMore = false;
                                        break;
                                    }

                                    for (const message of messages.values()) {
                                        if (message.id === thread.startMessage?.id) continue; // Skip the initial post

                                        threadData.messages.push({
                                            content: message.content,
                                            author: {
                                                username: message.author.username,
                                                avatarURL: message.author.displayAvatarURL()
                                            },
                                            attachments: Array.from(message.attachments.values()).map(att => ({
                                                url: att.url,
                                                name: att.name,
                                                description: att.description
                                            })),
                                            embeds: message.embeds,
                                            timestamp: message.createdTimestamp
                                        });
                                    }

                                    lastId = messages.last().id;
                                    await delay(1000); // Rate limit handling
                                }

                                channelData.posts.push(threadData);
                                Logger.success(`Backed up forum post: ${thread.name}`);
                            } catch (error) {
                                Logger.error(`Failed to backup forum post ${thread.name}:`, error);
                            }
                        }
                    }

                    backupData.channels.push(channelData);
                    Logger.success(`Backed up channel: ${channel.name}`);
                } catch (error) {
                    Logger.error(`Failed to backup channel ${channel.name}:`, error);
                }
            }

            return backupData;
        } catch (error) {
            Logger.error('Server backup failed:', error);
            throw error;
        }
    }
}

module.exports = RestoreService; 