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

            let webhook = null;
            let restoredCount = 0;
            let failedCount = 0;

            // Create webhook for server channels
            if (channel.type === 'GUILD_TEXT') {
                webhook = await channel.createWebhook('Message Restore Bot', {
                    avatar: this.client.user.displayAvatarURL()
                });
            }

            // Process messages in batches
            const batchSize = 10;
            for (let i = 0; i < messages.length; i += batchSize) {
                const batch = messages.slice(i, i + batchSize);
                
                for (const message of batch) {
                    try {
                        if (channel.type === 'GUILD_TEXT' && webhook) {
                            // For server channels, use webhook
                            const messageOptions = {
                                username: message.webhookData?.username || message.author,
                                avatarURL: message.webhookData?.avatarURL,
                                content: message.content
                            };

                            if (message.content?.trim()) {
                                await webhook.send(messageOptions);
                            }

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
                        } else {
                            // For DMs, send directly
                            if (message.content?.trim()) {
                                await channel.send(message.content);
                            }

                            if (message.attachments?.length > 0) {
                                for (const attachment of message.attachments) {
                                    if (attachment.url) {
                                        await channel.send({ files: [attachment.url] });
                                        await delay(1000);
                                    }
                                }
                            }
                        }
                        restoredCount++;
                    } catch (error) {
                        Logger.error(`Failed to restore message: ${error.message}`);
                        failedCount++;
                    }
                    await delay(1000); // Rate limit between messages
                }
                
                await delay(2000); // Additional delay between batches
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
}

module.exports = RestoreService; 