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
            if (type === 'dm') {
                try {
                    // First check if we can fetch the user
                    let user;
                    try {
                        user = await this.client.users.fetch(sourceChannelId, { force: true });
                    } catch (userError) {
                        Logger.error(`Failed to fetch user: ${userError.message}`);
                        throw new Error(`User not found or not accessible (ID: ${sourceChannelId})`);
                    }

                    if (!user) {
                        throw new Error(`User not found (ID: ${sourceChannelId})`);
                    }

                    Logger.info(`Found user: ${user.tag} (${user.id})`);

                    // Then try to create DM channel
                    try {
                        sourceChannel = await user.createDM();
                        if (!sourceChannel) {
                            throw new Error('Failed to create DM channel');
                        }
                    } catch (dmError) {
                        Logger.error(`Failed to create DM channel: ${dmError.message}`);
                        throw new Error(`Could not create DM channel with user ${user.tag} (${user.id})`);
                    }

                    Logger.success(`Created/fetched DM channel for user: ${user.tag}`);
                } catch (error) {
                    Logger.error(`Failed to setup DM channel: ${error.message}`);
                    throw new Error(`Could not access DM channel (User ID: ${sourceChannelId}) - ${error.message}`);
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
                throw new Error(`Invalid channel type: ${type}`);
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
                    
                    // Add a small delay to avoid rate limits
                    await delay(1000);
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

                        // Prepare webhook data
                        const webhookData = {
                            username: message.author.username,
                            avatarURL: message.author.displayAvatarURL(),
                            content: message.content,
                            embeds: message.embeds,
                            files: []
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
                        Logger.success(`Restored message ${restoredCount}`);

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
            Logger.info(`Found ${backupData.channels?.length || 0} channels in backup data`);

            // Verify bot permissions
            const botMember = await guild.members.fetch(this.client.user.id);
            const requiredPermissions = ['ManageChannels', 'ManageRoles', 'ManageWebhooks', 'ManageGuild'];
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

            // Store created channels for message restoration
            const createdChannels = new Map();

            // PHASE 1: Channel Creation
            if (backupData.channels && backupData.channels.length > 0) {
                Logger.info('=== PHASE 1: Creating Channels ===');
                
                // Delete existing channels if specified
                await Promise.all(guild.channels.cache
                    .filter(channel => channel.deletable)
                    .map(channel => channel.delete()
                        .catch(error => {
                            Logger.error(`Failed to delete channel ${channel.name}:`, error);
                            progress.errors.push({ type: 'channel_deletion', name: channel.name, error: error.message });
                        })
                    )
                );

                // First, create categories
                Logger.info('Creating categories...');
                const categoryChannels = backupData.channels
                    .filter(c => {
                        // More comprehensive category type checking
                        const type = (c.type || '').toLowerCase();
                        return type === 'category' || 
                               type === 'guild_category' || 
                               type === '4' || // Discord API category type
                               c.isCategory; // Backup format support
                    })
                    .sort((a, b) => (a.position || 0) - (b.position || 0));

                Logger.info(`Found ${categoryChannels.length} categories to restore`);
                const categories = new Map();

                // First pass: Create all categories
                for (const categoryData of categoryChannels) {
                    try {
                        const categoryName = this.sanitizeChannelName(categoryData.name || 'Unnamed Category');
                        
                        Logger.info(`Creating category: ${categoryName}`);
                        
                        // Create category with enhanced settings
                        const category = await guild.channels.create(categoryName, {
                            type: 4, // Use raw type number for category
                            position: categoryData.position || 0,
                            permissionOverwrites: categoryData.permissionOverwrites?.map(overwrite => ({
                                id: overwrite.id,
                                type: overwrite.type || 'role',
                                allow: BigInt(overwrite.allow || 0),
                                deny: BigInt(overwrite.deny || 0)
                            })) || [],
                            reason: `Server restore: Creating category ${categoryName}`
                        });

                        // Store all possible references
                        categories.set(categoryData.id, category.id);
                        categories.set(categoryData.name, category.id);
                        categories.set(categoryName, category.id); // Store sanitized name too
                        categories.set(`${category.id}_position`, categoryData.position || 0);
                        
                        Logger.success(`Created category: ${categoryName} (ID: ${category.id})`);
                        
                        // Verify category creation
                        const createdCategory = await guild.channels.fetch(category.id);
                        if (!createdCategory) {
                            throw new Error('Category creation verification failed');
                        }

                        // Log category details
                        Logger.info(`Category Details:
                            Name: ${createdCategory.name}
                            Position: ${createdCategory.position}
                            Created At: ${createdCategory.createdAt}
                            Children Count: ${createdCategory.children?.size || 0}
                            Permissions: ${createdCategory.permissionOverwrites.cache.size} overwrites
                        `);

                        await delay(1000); // Rate limit handling
                    } catch (error) {
                        Logger.error(`Failed to create category ${categoryData.name}:`, error);
                        progress.errors.push({ 
                            type: 'category_creation', 
                            name: categoryData.name, 
                            error: error.message 
                        });
                    }
                }

                // Second pass: Update all category positions at once
                try {
                    const categoryPositions = Array.from(categories.entries())
                        .filter(([key]) => key.endsWith('_position'))
                        .map(([key, position]) => ({
                            channel: categories.get(key.replace('_position', '')),
                            position: Math.min(position, 2147483647)
                        }))
                        .sort((a, b) => a.position - b.position);

                    if (categoryPositions.length > 0) {
                        Logger.info(`Updating positions for ${categoryPositions.length} categories`);
                        
                        // Process in smaller batches with verification
                        const batchSize = 10;
                        for (let i = 0; i < categoryPositions.length; i += batchSize) {
                            const batch = categoryPositions.slice(i, i + batchSize);
                            await guild.channels.setPositions(batch);
                            
                            // Verify positions
                            for (const pos of batch) {
                                const channel = await guild.channels.fetch(pos.channel);
                                if (channel && channel.position !== pos.position) {
                                    Logger.warn(`Position mismatch for category ${channel.name}: Expected ${pos.position}, Got ${channel.position}`);
                                    // Try to fix position individually
                                    await channel.setPosition(pos.position);
                                }
                            }
                            
                            await delay(1000);
                        }
                        Logger.success('Category positions updated successfully');
                    }
                } catch (error) {
                    Logger.error('Failed to update category positions:', error);
                    progress.errors.push({ 
                        type: 'category_position', 
                        error: error.message 
                    });
                }

                // Then create text and voice channels
                Logger.info('Creating channels...');
                const nonCategoryChannels = backupData.channels
                    .filter(c => c.type !== 'category' && c.type !== 'GUILD_CATEGORY')
                    .sort((a, b) => (a.position || 0) - (b.position || 0));

                for (const channelData of nonCategoryChannels) {
                    try {
                        // Use original channel name, only remove invalid characters if necessary
                        let channelName = channelData.name;
                        if (!channelName) {
                            channelName = 'unnamed-channel';
                        } else {
                            // Only remove characters that Discord doesn't allow in channel names
                            // Keep emojis and most special characters
                            channelName = channelName
                                .replace(/[^a-zA-Z0-9-_\u0020-\u007E\u00A0-\uFFFF]/g, '') // Keep most Unicode chars
                                .trim();
                            
                            // If name becomes empty after sanitization, use a default
                            if (!channelName) {
                                channelName = 'unnamed-channel';
                            }
                        }
                        
                        Logger.info(`Creating channel: ${channelName} (original: ${channelData.name})`);
                        
                        // Determine parent category
                        let parentId = null;
                        if (channelData.parentId) {
                            parentId = categories.get(channelData.parentId);
                        } else if (channelData.parent) {
                            parentId = categories.get(channelData.parent);
                        }

                        // Map channel types
                        let channelType;
                        switch(channelData.type?.toLowerCase()) {
                            case 'text':
                            case 'guild_text':
                                channelType = 'GUILD_TEXT';
                                break;
                            case 'voice':
                            case 'guild_voice':
                                channelType = 'GUILD_VOICE';
                                break;
                            case 'category':
                            case 'guild_category':
                                channelType = 'GUILD_CATEGORY';
                                break;
                            case 'news':
                            case 'guild_news':
                                channelType = 'GUILD_NEWS';
                                break;
                            case 'store':
                            case 'guild_store':
                                channelType = 'GUILD_STORE';
                                break;
                            case 'stage':
                            case 'guild_stage_voice':
                                channelType = 'GUILD_STAGE_VOICE';
                                break;
                            case 'forum':
                            case 'guild_forum':
                                channelType = 'GUILD_FORUM';
                                break;
                            default:
                                channelType = 'GUILD_TEXT'; // Fallback to text channel
                        }

                        // Prepare channel creation options
                        const channelOptions = {
                            type: channelType,
                            topic: channelData.topic || '',
                            nsfw: channelData.nsfw || false,
                            rateLimitPerUser: channelData.rateLimitPerUser || 0,
                            parent: parentId,
                            position: channelData.position || 0,
                            permissionOverwrites: channelData.permissionOverwrites || [],
                            bitrate: channelData.bitrate, // For voice channels
                            userLimit: channelData.userLimit, // For voice channels
                            defaultAutoArchiveDuration: channelData.defaultAutoArchiveDuration || 1440,
                            defaultThreadRateLimitPerUser: channelData.defaultThreadRateLimitPerUser
                        };

                        // Remove undefined options
                        Object.keys(channelOptions).forEach(key => 
                            channelOptions[key] === undefined && delete channelOptions[key]
                        );

                        const newChannel = await guild.channels.create(channelName, channelOptions);

                        // Handle forum-specific settings if it's a forum channel
                        if (channelType === 'GUILD_FORUM' && channelData.availableTags) {
                            try {
                                // Set forum-specific settings
                                await newChannel.setAvailableTags(channelData.availableTags);
                                
                                // Set default forum layout
                                if (channelData.defaultForumLayout) {
                                    await newChannel.setDefaultForumLayout(channelData.defaultForumLayout);
                                }
                                
                                // Set default reaction emoji
                                if (channelData.defaultReactionEmoji) {
                                    await newChannel.setDefaultReactionEmoji(channelData.defaultReactionEmoji);
                                }
                                
                                // Set default sort order
                                if (channelData.defaultSortOrder) {
                                    await newChannel.setDefaultSortOrder(channelData.defaultSortOrder);
                                }

                                // Set guidelines
                                if (channelData.guidelines) {
                                    await newChannel.setGuidelines(channelData.guidelines);
                                }

                                Logger.success(`Forum settings restored for ${channelName}`);
                                await delay(1000); // Rate limit handling
                            } catch (error) {
                                Logger.error(`Failed to set forum settings for ${channelName}:`, error);
                            }
                        }

                        // Store channel info for message and post restoration
                        if ((channelType === 'GUILD_TEXT' || channelType === 'GUILD_FORUM') && 
                            (channelData.messages?.length > 0 || channelData.posts?.length > 0)) {
                            createdChannels.set(channelName, {
                                channel: newChannel,
                                messages: channelData.messages || [],
                                posts: channelData.posts || [],
                                type: channelType
                            });
                        }

                        progress.channelsRestored++;
                        Logger.success(`Created channel: ${channelName}`);
                        await delay(1000);
                    } catch (error) {
                        Logger.error(`Failed to create channel ${channelData.name}:`, error);
                        progress.errors.push({ 
                            type: 'channel_creation', 
                            name: channelData.name, 
                            error: error.message 
                        });
                    }
                }

                // Update channel positions
                const channelPositions = guild.channels.cache
                    .filter(channel => channel.type !== 'GUILD_CATEGORY')
                    .map((channel, index) => ({
                        channel: channel.id,
                        position: Math.min(index, 2147483647) // Ensure position stays within int32 bounds
                    }));

                try {
                    // Set positions in smaller batches to avoid rate limits
                    const batchSize = 10;
                    for (let i = 0; i < channelPositions.length; i += batchSize) {
                        const batch = channelPositions.slice(i, i + batchSize);
                        await guild.channels.setPositions(batch);
                        await delay(1000); // Add delay between batches
                    }
                    Logger.success('Channel positions updated successfully');
                } catch (error) {
                    Logger.error('Failed to update channel positions:', error);
                    // Continue execution even if position update fails
                }

                Logger.success('Channel creation completed!');

                // Verify categories and their channels
                Logger.info('Verifying category structure...');
                for (const [categoryName, categoryInfo] of categories) {
                    if (categoryName.endsWith('_position')) continue;
                    
                    try {
                        const category = await guild.channels.fetch(categoryInfo);
                        if (!category) continue;

                        const children = category.children.cache;
                        Logger.info(`Category ${category.name}: ${children.size} channels`);

                        // Check if any channels are missing their parent
                        const missingParent = Array.from(children.values())
                            .filter(channel => !channel.parent || channel.parent.id !== category.id);

                        if (missingParent.length > 0) {
                            Logger.warn(`Found ${missingParent.length} channels with incorrect parent in ${category.name}`);
                            
                            // Try to fix parent relationships
                            for (const channel of missingParent) {
                                try {
                                    await channel.setParent(category.id, { lockPermissions: false });
                                    Logger.success(`Fixed parent for channel ${channel.name}`);
                                    await delay(1000);
                                } catch (error) {
                                    Logger.error(`Failed to fix parent for channel ${channel.name}:`, error);
                                }
                            }
                        }
                    } catch (error) {
                        Logger.error(`Failed to verify category ${categoryName}:`, error);
                    }
                }
                Logger.success('Category verification completed!');
            }

            // PHASE 2: Message and Post Restoration
            if (createdChannels.size > 0) {
                Logger.info('=== PHASE 2: Restoring Messages and Posts ===');
                
                for (const [channelName, channelInfo] of createdChannels) {
                    const { channel, messages, posts, type } = channelInfo;
                    
                    if (type === 'GUILD_FORUM') {
                        Logger.info(`Restoring forum posts for channel: ${channelName} (${posts.length} posts)`);
                        
                        const webhook = await channel.createWebhook('Forum Restore', {
                            avatar: this.client.user.displayAvatarURL()
                        });

                        try {
                            const batchSize = 5; // Smaller batch size for forum posts due to complexity
                            for (let i = 0; i < posts.length; i += batchSize) {
                                const postBatch = posts.slice(i, i + batchSize);
                                Logger.info(`Processing forum post batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(posts.length/batchSize)} for ${channelName}`);
                                
                                for (const post of postBatch) {
                                    try {
                                        // Create forum post
                                        const thread = await channel.threads.create({
                                            name: post.name || 'Restored Post',
                                            message: {
                                                content: post.content || '',
                                                files: post.attachments || [],
                                                embeds: post.embeds || []
                                            },
                                            appliedTags: post.tags || [],
                                            reason: 'Server restore: Forum post restoration'
                                        });

                                        // Restore post messages
                                        if (post.messages?.length > 0) {
                                            for (const message of post.messages) {
                                                await webhook.send({
                                                    threadId: thread.id,
                                                    content: message.content,
                                                    username: message.author?.username || 'Unknown User',
                                                    avatarURL: message.author?.avatarURL,
                                                    files: message.attachments || [],
                                                    embeds: message.embeds || []
                                                });
                                                await delay(1000);
                                            }
                                        }

                                        // Set post metadata
                                        if (post.pinned) {
                                            await thread.setLocked(post.locked || false);
                                            await thread.setArchived(post.archived || false);
                                            await thread.setPinned(true);
                                        }

                                        progress.messagesRestored++;
                                        Logger.success(`Restored forum post: ${post.name}`);
                                    } catch (error) {
                                        Logger.error(`Failed to restore forum post: ${error.message}`);
                                        progress.errors.push({
                                            type: 'forum_post',
                                            name: post.name,
                                            error: error.message
                                        });
                                    }
                                    await delay(2000); // Additional delay between posts
                                }
                            }
                        } finally {
                            await webhook.delete();
                            Logger.info(`Completed forum post restore for ${channelName}`);
                        }
                    } else if (type === 'GUILD_TEXT' && messages.length > 0) {
                        Logger.info(`Restoring messages for channel: ${channelName} (${messages.length} messages)`);

                        const webhook = await channel.createWebhook('Message Restore', {
                            avatar: this.client.user.displayAvatarURL()
                        });

                        try {
                            const batchSize = 10;
                            for (let i = 0; i < messages.length; i += batchSize) {
                                const messageBatch = messages.slice(i, i + batchSize);
                                Logger.info(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(messages.length/batchSize)} for ${channelName}`);
                                
                                const result = await this.messagePool.executeTask({
                                    type: 'processMessageBatch',
                                    data: {
                                        messages: messageBatch,
                                        webhook: {
                                            id: webhook.id,
                                            token: webhook.token,
                                            url: webhook.url
                                        },
                                        channelId: channel.id
                                    }
                                });

                                if (result.error) {
                                    Logger.error(`Batch error in ${channelName}: ${result.error}`);
                                    progress.errors.push({
                                        type: 'message_batch',
                                        channel: channelName,
                                        error: result.error
                                    });
                                } else {
                                    progress.messagesRestored += result.results.filter(r => r.success).length;
                                }

                                await delay(2000);
                            }
                        } finally {
                            await webhook.delete();
                            Logger.info(`Completed message restore for ${channelName}`);
                        }
                    }
                }
                Logger.success('Message and post restoration completed!');
            }

            return {
                success: true,
                progress,
                message: `Server restored successfully: ${progress.channelsRestored} channels, ${progress.messagesRestored} messages. ${progress.errors.length} errors occurred.`,
                errors: progress.errors
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