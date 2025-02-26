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
                    username: message.author?.username || message.author || 'Unknown User',
                    avatarURL: message.webhookData?.avatarURL || message.author?.avatarURL,
                    files: [],
                    embeds: message.embeds || [],
                    allowedMentions: { parse: [] }
                };

                // Handle attachments with rate limiting
                if (message.attachments?.length > 0) {
                    const validAttachments = [];
                    for (const attachment of message.attachments) {
                        if (attachment.url) {
                            validAttachments.push({
                                attachment: attachment.url,
                                name: attachment.name || 'attachment'
                            });
                        }
                    }

                    // Send attachments in batches of 10 (Discord's limit)
                    if (validAttachments.length > 0) {
                        for (let i = 0; i < validAttachments.length; i += 10) {
                            const batch = validAttachments.slice(i, i + 10);
                            await webhookClient.send({
                                ...webhookData,
                                content: i === 0 ? webhookData.content : '',
                                files: batch
                            });
                            await delay(1000 / RATE_LIMITS.ATTACHMENTS_PER_SECOND);
                        }
                    } else if (webhookData.content || webhookData.embeds.length > 0) {
                        // Send text-only message if we have content or embeds
                        await webhookClient.send(webhookData);
                    }
                } else if (webhookData.content || webhookData.embeds.length > 0) {
                    // Send text-only message if we have content or embeds
                    await webhookClient.send(webhookData);
                }

                results.push({ success: true, messageId: message.id });
                messageCount++;
                lastMessageTime = Date.now();

                // Add extra delay every 30 messages (webhook rate limit)
                if (messageCount % RATE_LIMITS.WEBHOOK_OPERATIONS_PER_MINUTE === 0) {
                    await delay(2000); // Extra delay to prevent webhook rate limits
                }

            } catch (error) {
                results.push({ 
                    error: error.message, 
                    messageId: message.id,
                    code: error.code
                });
                
                // Handle rate limits explicitly
                if (error.code === 429) { // Rate limit error
                    const retryAfter = error.retryAfter || 5000;
                    await delay(retryAfter);
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