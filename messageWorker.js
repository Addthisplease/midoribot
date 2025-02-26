const { workerData, parentPort } = require('worker_threads');
const { WebhookClient } = require('discord.js-selfbot-v13');
const fetch = require('node-fetch');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Rate limit configuration
const RATE_LIMITS = {
    MESSAGES_PER_SECOND: 1,
    ATTACHMENTS_PER_SECOND: 1,
    WEBHOOK_OPERATIONS_PER_MINUTE: 30
};

async function processMessageBatch(data) {
    try {
        const { messages, webhook, channelId } = data;
        const webhookClient = new WebhookClient({ 
            id: webhook.id, 
            token: webhook.token,
            url: webhook.url
        });
        
        const results = [];
        let messageCount = 0;
        let lastMessageTime = Date.now();

        for (const message of messages) {
            try {
                // Implement rate limiting
                const timeSinceLastMessage = Date.now() - lastMessageTime;
                if (timeSinceLastMessage < (1000 / RATE_LIMITS.MESSAGES_PER_SECOND)) {
                    await delay(1000 / RATE_LIMITS.MESSAGES_PER_SECOND - timeSinceLastMessage);
                }

                const webhookData = {
                    content: message.content || '',
                    username: message.author?.username || message.author?.tag || 'Unknown User',
                    avatarURL: message.author?.displayAvatarURL?.() || message.author?.avatarURL,
                    files: [],
                    embeds: message.embeds?.map(embed => ({
                        ...embed,
                        timestamp: embed.timestamp?.toISOString() || null
                    })) || [],
                    allowedMentions: { parse: [] },
                    threadId: message.thread?.id
                };

                // Handle attachments with rate limiting
                if (message.attachments?.size > 0 || message.attachments?.length > 0) {
                    const attachments = Array.from(message.attachments?.values?.() || message.attachments);
                    const validAttachments = attachments.filter(att => att?.url || att?.proxyURL).map(att => ({
                        attachment: att.url || att.proxyURL,
                        name: att.name || 'attachment'
                    }));

                    // Send attachments in batches of 10 (Discord's limit)
                    if (validAttachments.length > 0) {
                        for (let i = 0; i < validAttachments.length; i += 10) {
                            const batch = validAttachments.slice(i, i + 10);
                            await webhookClient.send({
                                ...webhookData,
                                content: i === 0 ? webhookData.content : '',
                                files: batch
                            }).catch(async (error) => {
                                if (error.code === 429) {
                                    const retryAfter = error.retryAfter || 5000;
                                    await delay(retryAfter);
                                    // Retry the send
                                    await webhookClient.send({
                                        ...webhookData,
                                        content: i === 0 ? webhookData.content : '',
                                        files: batch
                                    });
                                } else {
                                    throw error;
                                }
                            });
                            await delay(1000 / RATE_LIMITS.ATTACHMENTS_PER_SECOND);
                        }
                    } else if (webhookData.content || webhookData.embeds.length > 0) {
                        await webhookClient.send(webhookData);
                    }
                } else if (webhookData.content || webhookData.embeds.length > 0) {
                    await webhookClient.send(webhookData);
                }

                results.push({ success: true, messageId: message.id });
                messageCount++;
                lastMessageTime = Date.now();

                // Add extra delay every 30 messages (webhook rate limit)
                if (messageCount % RATE_LIMITS.WEBHOOK_OPERATIONS_PER_MINUTE === 0) {
                    await delay(2000);
                }

            } catch (error) {
                results.push({ 
                    error: error.message, 
                    messageId: message.id,
                    code: error.code,
                    retryAfter: error.retryAfter
                });
                
                // Handle rate limits explicitly
                if (error.code === 429) {
                    const retryAfter = error.retryAfter || 5000;
                    await delay(retryAfter);
                } else {
                    Logger.error(`Error processing message ${message.id}:`, error);
                }
            }
        }

        webhookClient.destroy();
        return { results };
    } catch (error) {
        return { error: error.message };
    }
}

// Handle messages from the parent process
parentPort.on('message', async (task) => {
    let result;
    
    switch (task.type) {
        case 'processMessageBatch':
            result = await processMessageBatch(task.data);
            break;
        default:
            result = { error: `Unknown task type: ${task.type}` };
    }
    
    parentPort.postMessage(result);
}); 