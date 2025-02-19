const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const Logger = require('../utils/logger');
const config = require('../config/config');
const { delay } = require('../utils/helpers');
const fetch = require('node-fetch');

class RestoreService {
    constructor(client) {
        this.client = client;
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

            Logger.info(`Attempting to fetch channels - Source: ${sourceChannelId}, Target: ${targetChannelId}`);

            // Get source and target channels with better error handling
            let sourceChannel;
            if (type === 'dm') {
                try {
                    // For DMs, we need to create/fetch the DM channel
                    const user = await this.client.users.fetch(sourceChannelId);
                    sourceChannel = await user.createDM();
                    Logger.success(`Created/fetched DM channel for user: ${user.tag}`);
                } catch (error) {
                    Logger.error(`Failed to fetch/create DM channel: ${error.message}`);
                    throw new Error(`Could not access DM channel (User ID: ${sourceChannelId})`);
                }
            } else {
                sourceChannel = await this.client.channels.fetch(sourceChannelId)
                    .catch(error => {
                        Logger.error(`Failed to fetch source channel: ${error.message}`);
                        throw new Error(`Source channel not found or not accessible (ID: ${sourceChannelId})`);
                    });
            }

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
                // Fetch messages
                const messages = await sourceChannel.messages.fetch({ limit: 100 })
                    .catch(error => {
                        Logger.error(`Failed to fetch messages: ${error.message}`);
                        throw new Error('Could not fetch messages from the source channel');
                    });

                if (!messages || messages.size === 0) {
                    throw new Error('No messages found in the source channel');
                }

                const sortedMessages = Array.from(messages.values())
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
}

module.exports = RestoreService; 