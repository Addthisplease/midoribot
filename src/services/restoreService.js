const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const Logger = require('../utils/logger');
const config = require('../config/config');
const { delay } = require('../utils/helpers');

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
            // Get source and target channels
            const sourceChannel = await this.client.channels.fetch(sourceChannelId);
            const targetChannel = await this.client.channels.fetch(targetChannelId);

            if (!sourceChannel || !targetChannel) {
                throw new Error('One or both channels not found');
            }

            Logger.info(`Starting restore from ${type === 'guild' ? 'server' : 'DM'} ${sourceChannel.id} to ${targetChannel.id}`);
            let restoredCount = 0;
            let failedCount = 0;

            // Create webhook for target channel if it's a guild channel
            let webhook = null;
            if (targetChannel.type === 'GUILD_TEXT') {
                webhook = await targetChannel.createWebhook('Message Restore Bot', {
                    avatar: this.client.user.displayAvatarURL()
                });
            }

            // Fetch messages with appropriate limit based on type
            const fetchLimit = type === 'guild' ? 100 : 50; // Adjust limits as needed
            const messages = await sourceChannel.messages.fetch({ limit: fetchLimit });
            const sortedMessages = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

            for (const message of sortedMessages) {
                try {
                    // Handle content, attachments, and embeds separately
                    const hasAttachments = message.attachments.size > 0;
                    const hasContent = message.content?.trim().length > 0;
                    const hasEmbeds = message.embeds?.length > 0;

                    if (webhook) {
                        // For server channels, use webhook
                        const baseOptions = {
                            username: message.author.username,
                            avatarURL: message.author.displayAvatarURL(),
                            embeds: [] // Initialize embeds array
                        };

                        // Handle embeds
                        if (hasEmbeds) {
                            const validEmbeds = message.embeds.filter(embed => {
                                // Filter out empty embeds
                                return embed.data && (
                                    embed.data.title || 
                                    embed.data.description || 
                                    embed.data.fields?.length > 0 ||
                                    embed.data.image ||
                                    embed.data.thumbnail
                                );
                            });

                            if (validEmbeds.length > 0) {
                                await webhook.send({
                                    ...baseOptions,
                                    embeds: validEmbeds.map(embed => embed.data)
                                });
                                await delay(1000);
                            }
                        }

                        // Handle content
                        if (hasContent) {
                            await webhook.send({
                                ...baseOptions,
                                content: message.content
                            });
                            await delay(1000);
                        }

                        // Handle attachments
                        if (hasAttachments) {
                            for (const [_, attachment] of message.attachments) {
                                await webhook.send({
                                    ...baseOptions,
                                    files: [attachment.url]
                                });
                                await delay(1000);
                            }
                        }
                    } else {
                        // For DMs, send directly
                        // Handle embeds
                        if (hasEmbeds) {
                            const validEmbeds = message.embeds.filter(embed => {
                                return embed.data && (
                                    embed.data.title || 
                                    embed.data.description || 
                                    embed.data.fields?.length > 0 ||
                                    embed.data.image ||
                                    embed.data.thumbnail
                                );
                            });

                            if (validEmbeds.length > 0) {
                                await targetChannel.send({
                                    embeds: validEmbeds.map(embed => embed.data)
                                });
                                await delay(1000);
                            }
                        }

                        // Handle content
                        if (hasContent) {
                            await targetChannel.send({
                                content: message.content
                            });
                            await delay(1000);
                        }

                        // Handle attachments
                        if (hasAttachments) {
                            for (const [_, attachment] of message.attachments) {
                                await targetChannel.send({
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

            // Cleanup webhook
            if (webhook) {
                await webhook.delete();
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
}

module.exports = RestoreService; 