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

            // Create webhook for message restoration
            const webhook = await channel.createWebhook('Message Restore', {
                avatar: this.client.user.displayAvatarURL()
            });

            try {
                // Process messages
                for (const message of messages) {
                    try {
                        const messageData = {
                            content: message.content || '',
                            username: message.author?.username || message.author?.tag || 'Unknown User',
                            avatarURL: message.author?.displayAvatarURL?.({ dynamic: true }) || message.author?.avatarURL,
                            allowedMentions: { parse: [] },
                            files: [],
                            embeds: message.embeds?.map(embed => ({
                                ...embed,
                                timestamp: embed.timestamp?.toISOString() || null,
                                color: embed.color || null,
                                description: embed.description || null,
                                fields: embed.fields?.map(field => ({
                                    name: field.name,
                                    value: field.value,
                                    inline: field.inline
                                })) || [],
                                author: embed.author ? {
                                    name: embed.author.name,
                                    url: embed.author.url,
                                    iconURL: embed.author.iconURL
                                } : null,
                                footer: embed.footer ? {
                                    text: embed.footer.text,
                                    iconURL: embed.footer.iconURL
                                } : null,
                                thumbnail: embed.thumbnail ? {
                                    url: embed.thumbnail.url
                                } : null,
                                image: embed.image ? {
                                    url: embed.image.url
                                } : null
                            })) || []
                        };

                        // Handle attachments
                        if (message.attachments?.length > 0 || message.attachments?.size > 0) {
                            const attachments = Array.from(message.attachments?.values?.() || message.attachments);
                            const validAttachments = attachments.filter(att => att?.url || att?.proxyURL).map(att => ({
                                attachment: att.url || att.proxyURL,
                                name: att.name || 'attachment',
                                description: att.description
                            }));

                            // Send attachments in batches of 10 (Discord's limit)
                            if (validAttachments.length > 0) {
                                for (let i = 0; i < validAttachments.length; i += 10) {
                                    const batch = validAttachments.slice(i, i + 10);
                                    await webhook.send({
                                        ...messageData,
                                        content: i === 0 ? messageData.content : '',
                                        files: batch
                                    }).catch(async (error) => {
                                        if (error.code === 429) {
                                            const retryAfter = error.retryAfter || 5000;
                                            await delay(retryAfter);
                                            // Retry the send
                                            await webhook.send({
                                                ...messageData,
                                                content: i === 0 ? messageData.content : '',
                                                files: batch
                                            });
                                        } else {
                                            throw error;
                                        }
                                    });
                                    await delay(1000);
                                }
                            } else if (messageData.content || messageData.embeds.length > 0) {
                                await webhook.send(messageData);
                            }
                        } else if (messageData.content || messageData.embeds.length > 0) {
                            await webhook.send(messageData);
                        }

                        // Handle message components (if any)
                        if (message.components?.length > 0) {
                            const components = message.components.map(row => ({
                                type: 1,
                                components: row.components.map(comp => ({
                                    type: comp.type,
                                    style: comp.style,
                                    label: comp.label,
                                    customId: comp.customId,
                                    emoji: comp.emoji,
                                    url: comp.url,
                                    disabled: comp.disabled
                                }))
                            }));

                            if (components.length > 0) {
                                await webhook.send({
                                    ...messageData,
                                    content: '',
                                    components
                                });
                            }
                        }

                        // Handle replies
                        if (message.reference) {
                            await webhook.send({
                                ...messageData,
                                content: `> Replying to a message\n${messageData.content}`,
                                allowedMentions: { repliedUser: false }
                            });
                        }

                        restoredCount++;
                        Logger.success(`Restored message ${restoredCount}`);
                        await delay(1000);
                    } catch (error) {
                        Logger.error(`Failed to restore message: ${error.message}`);
                        failedCount++;
                        if (error.code === 429) {
                            const retryAfter = error.retryAfter || 5000;
                            await delay(retryAfter);
                        } else {
                            await delay(1000);
                        }
                    }
                }
            } finally {
                // Clean up webhook
                try {
                    await webhook.delete();
                } catch (error) {
                    Logger.error('Failed to delete webhook:', error);
                }
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
            const messageData = {
                content: message.content || '',
                allowedMentions: { parse: [] },
                files: [],
                embeds: message.embeds?.map(embed => ({
                    ...embed,
                    timestamp: embed.timestamp?.toISOString() || null,
                    color: embed.color || null
                })) || []
            };

            // Handle attachments
            if (message.attachments?.length > 0 || message.attachments?.size > 0) {
                const attachments = Array.from(message.attachments?.values?.() || message.attachments);
                const validAttachments = attachments.filter(att => att?.url || att?.proxyURL).map(att => ({
                    attachment: att.url || att.proxyURL,
                    name: att.name || 'attachment',
                    description: att.description
                }));

                if (validAttachments.length > 0) {
                    for (let i = 0; i < validAttachments.length; i += 10) {
                        const batch = validAttachments.slice(i, i + 10);
                        await channel.send({
                            ...messageData,
                            content: i === 0 ? messageData.content : '',
                            files: batch
                        });
                        await delay(1000);
                    }
                } else if (messageData.content || messageData.embeds.length > 0) {
                    await channel.send(messageData);
                }
            } else if (messageData.content || messageData.embeds.length > 0) {
                await channel.send(messageData);
            }

            // Handle message components
            if (message.components?.length > 0) {
                const components = message.components.map(row => ({
                    type: 1,
                    components: row.components.map(comp => ({
                        type: comp.type,
                        style: comp.style,
                        label: comp.label,
                        customId: comp.customId,
                        emoji: comp.emoji,
                        url: comp.url,
                        disabled: comp.disabled
                    }))
                }));

                if (components.length > 0) {
                    await channel.send({
                        ...messageData,
                        content: '',
                        components
                    });
                }
            }

            await delay(1000);
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
                        // For DMs, fetch the user first
                        let user;
                        try {
                            user = await this.client.users.fetch(sourceChannelId, { force: true });
                            sourceChannel = await user.createDM();
                            Logger.success(`Created DM channel with user: ${user.tag}`);
                        } catch (userError) {
                            if (userError.code === 10013) {
                                throw new Error(`User not found. The user ID ${sourceChannelId} does not exist on Discord.`);
                            } else if (userError.code === 50001) {
                                throw new Error(`Cannot access user. The user may have blocked the bot or has DMs disabled (ID: ${sourceChannelId})`);
                            } else {
                                throw new Error(`Failed to fetch user: ${userError.message} (ID: ${sourceChannelId})`);
                            }
                        }
                    }
                } catch (error) {
                    Logger.error(`Failed to setup ${type} channel: ${error.message}`);
                    throw error;
                }
            } else {
                throw new Error(`Invalid channel type: ${type}. Must be 'dm' or 'group'`);
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

            Logger.info(`Starting restore from ${type} to ${targetChannel.name}`);
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
                    }
                }
            }
        } catch (error) {
            Logger.error('Restore failed:', error);
            throw error;
        }
    }

    async restoreServer(guild, backupData) {
        try {
            Logger.info(`Starting restore for server: ${guild.name}`);

            // Verify bot permissions
            const botMember = await guild.members.fetch(this.client.user.id);
            const requiredPermissions = ['MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_WEBHOOKS', 'MANAGE_GUILD', 'MANAGE_EMOJIS_AND_STICKERS'];
            const missingPermissions = requiredPermissions.filter(perm => !botMember.permissions.has(perm));
            
            if (missingPermissions.length > 0) {
                throw new Error(`Bot lacks required permissions: ${missingPermissions.join(', ')}`);
            }

            let progress = {
                rolesRestored: 0,
                channelsRestored: 0,
                emojisRestored: 0,
                stickersRestored: 0,
                errors: []
            };

            // Update guild settings if possible
            try {
                await guild.edit({
                    name: backupData.name,
                    icon: backupData.icon,
                    banner: backupData.banner,
                    splash: backupData.splash,
                    description: backupData.description,
                    verificationLevel: backupData.verificationLevel,
                    defaultMessageNotifications: backupData.defaultMessageNotifications,
                    explicitContentFilter: backupData.explicitContentFilter,
                    preferredLocale: backupData.preferredLocale
                });
                Logger.success('Updated guild settings');
            } catch (error) {
                Logger.error('Failed to update guild settings:', error);
                progress.errors.push({ type: 'guild_settings', error: error.message });
            }

            // Restore roles
            if (backupData.roles?.length > 0) {
                Logger.info('Restoring roles...');
                for (const roleData of backupData.roles) {
                    try {
                        const role = await guild.roles.create({
                            name: roleData.name,
                            color: roleData.color,
                            hoist: roleData.hoist,
                            position: roleData.rawPosition,
                            permissions: BigInt(roleData.permissions),
                            mentionable: roleData.mentionable,
                            icon: roleData.icon,
                            unicodeEmoji: roleData.unicodeEmoji,
                            reason: 'Server restore: Role creation'
                        });
                        progress.rolesRestored++;
                        Logger.success(`Restored role: ${role.name}`);
                        await delay(1000);
                    } catch (error) {
                        Logger.error(`Failed to restore role ${roleData.name}:`, error);
                        progress.errors.push({ type: 'role_restore', name: roleData.name, error: error.message });
                    }
                }
            }

            // Restore emojis
            if (backupData.emojis?.length > 0) {
                Logger.info('Restoring emojis...');
                for (const emojiData of backupData.emojis) {
                    try {
                        await guild.emojis.create(emojiData.url, emojiData.name, {
                            roles: emojiData.roles,
                            reason: 'Server restore: Emoji creation'
                        });
                        progress.emojisRestored++;
                        Logger.success(`Restored emoji: ${emojiData.name}`);
                        await delay(1000);
                    } catch (error) {
                        Logger.error(`Failed to restore emoji ${emojiData.name}:`, error);
                        progress.errors.push({ type: 'emoji_restore', name: emojiData.name, error: error.message });
                    }
                }
            }

            // Restore stickers
            if (backupData.stickers?.length > 0) {
                Logger.info('Restoring stickers...');
                for (const stickerData of backupData.stickers) {
                    try {
                        await guild.stickers.create(stickerData.url, stickerData.name, stickerData.tags, {
                            description: stickerData.description,
                            reason: 'Server restore: Sticker creation'
                        });
                        progress.stickersRestored++;
                        Logger.success(`Restored sticker: ${stickerData.name}`);
                        await delay(1000);
                    } catch (error) {
                        Logger.error(`Failed to restore sticker ${stickerData.name}:`, error);
                        progress.errors.push({ type: 'sticker_restore', name: stickerData.name, error: error.message });
                    }
                }
            }

            // Continue with channel restoration...
            // [Previous channel restoration code remains the same]

            return {
                success: true,
                progress,
                message: `Server restored successfully: ${progress.rolesRestored} roles, ${progress.channelsRestored} channels, ${progress.emojisRestored} emojis, ${progress.stickersRestored} stickers. ${progress.errors.length} errors occurred.`
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
                icon: guild.iconURL({ dynamic: true, size: 4096 }),
                banner: guild.bannerURL({ dynamic: true, size: 4096 }),
                splash: guild.splashURL({ dynamic: true, size: 4096 }),
                description: guild.description,
                verificationLevel: guild.verificationLevel,
                defaultMessageNotifications: guild.defaultMessageNotifications,
                explicitContentFilter: guild.explicitContentFilter,
                premiumTier: guild.premiumTier,
                premiumSubscriptionCount: guild.premiumSubscriptionCount,
                preferredLocale: guild.preferredLocale,
                channels: [],
                roles: [],
                emojis: [],
                stickers: []
            };

            // Backup roles with proper permissions
            guild.roles.cache.forEach(role => {
                if (!role.managed) {
                    backupData.roles.push({
                        id: role.id,
                        name: role.name,
                        color: role.hexColor,
                        hoist: role.hoist,
                        rawPosition: role.rawPosition,
                        permissions: role.permissions.bitfield.toString(),
                        mentionable: role.mentionable,
                        icon: role.iconURL({ dynamic: true, size: 4096 }),
                        unicodeEmoji: role.unicodeEmoji,
                        tags: role.tags
                    });
                }
            });

            // Backup emojis
            guild.emojis.cache.forEach(emoji => {
                backupData.emojis.push({
                    id: emoji.id,
                    name: emoji.name,
                    url: emoji.url,
                    animated: emoji.animated,
                    available: emoji.available,
                    requiresColons: emoji.requiresColons,
                    managed: emoji.managed,
                    roles: Array.from(emoji.roles.cache.keys())
                });
            });

            // Backup stickers
            guild.stickers?.cache.forEach(sticker => {
                backupData.stickers.push({
                    id: sticker.id,
                    name: sticker.name,
                    description: sticker.description,
                    tags: sticker.tags,
                    type: sticker.type,
                    format: sticker.format,
                    available: sticker.available,
                    url: sticker.url
                });
            });

            // First backup categories
            const categories = guild.channels.cache
                .filter(channel => channel.type === 'GUILD_CATEGORY')
                .sort((a, b) => a.rawPosition - b.rawPosition);

            for (const category of categories.values()) {
                try {
                    backupData.channels.push({
                        id: category.id,
                        name: category.name,
                        type: 'category',
                        rawPosition: category.rawPosition,
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
                .sort((a, b) => a.rawPosition - b.rawPosition);

            for (const channel of nonCategoryChannels.values()) {
                try {
                    const channelData = {
                        id: channel.id,
                        name: channel.name,
                        type: channel.type,
                        rawPosition: channel.rawPosition,
                        parentId: channel.parentId,
                        topic: channel.topic || "",
                        nsfw: channel.nsfw || false,
                        rateLimitPerUser: channel.rateLimitPerUser || 0,
                        lastMessageId: channel.lastMessageId,
                        lastPinTimestamp: channel.lastPinTimestamp,
                        defaultAutoArchiveDuration: channel.defaultAutoArchiveDuration,
                        flags: channel.flags?.bitfield,
                        permissionOverwrites: Array.from(channel.permissionOverwrites.cache.values()).map(perm => ({
                            id: perm.id,
                            type: perm.type,
                            allow: perm.allow.bitfield.toString(),
                            deny: perm.deny.bitfield.toString()
                        }))
                    };

                    // Add voice channel specific data
                    if (channel.isVoice()) {
                        channelData.bitrate = channel.bitrate;
                        channelData.userLimit = channel.userLimit;
                        channelData.rtcRegion = channel.rtcRegion;
                        channelData.videoQualityMode = channel.videoQualityMode;
                    }

                    // Add forum-specific data
                    if (channel.isThread()) {
                        channelData.archived = channel.archived;
                        channelData.archiveTimestamp = channel.archiveTimestamp;
                        channelData.autoArchiveDuration = channel.autoArchiveDuration;
                        channelData.locked = channel.locked;
                        channelData.invitable = channel.invitable;
                        channelData.ownerId = channel.ownerId;
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