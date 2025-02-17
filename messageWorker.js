const { workerData, parentPort } = require('worker_threads');
const { Client } = require('discord.js-selfbot-v13');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const client = new Client();

async function fetchMessages(data) {
    try {
        await client.login(data.token);
        const channel = await client.channels.fetch(data.channelId);
        
        if (!channel) {
            throw new Error('Channel not found');
        }

        const messages = [];
        let lastId;
        
        while (true) {
            const options = { limit: 100 };
            if (lastId) options.before = lastId;
            
            const fetchedMessages = await channel.messages.fetch(options);
            if (!fetchedMessages || fetchedMessages.size === 0) break;
            
            messages.push(...Array.from(fetchedMessages.values()).map(msg => ({
                content: msg.content,
                author: {
                    username: msg.author.username,
                    id: msg.author.id,
                    avatar: msg.author.avatar 
                        ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png` 
                        : 'https://cdn.discordapp.com/embed/avatars/0.png'
                },
                attachments: Array.from(msg.attachments.values()),
                createdTimestamp: msg.createdTimestamp
            })));
            lastId = fetchedMessages.last().id;
            
            await delay(1000); // Rate limit delay
        }

        return { messages };
    } catch (error) {
        return { error: error.message };
    }
}

async function downloadAttachment(data) {
    try {
        const { url, savePath } = data;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to download: ${response.statusText}`);
        }

        const buffer = await response.buffer();
        await fs.writeFile(savePath, buffer);

        return { success: true, path: savePath };
    } catch (error) {
        return { error: error.message };
    }
}

async function processMessageBatch(data) {
    try {
        const { messages, webhook, channelId, isGroupDM } = data;
        const results = [];

        for (const message of messages) {
            try {
                const messageOptions = {
                    username: message.author.username,
                    avatarURL: message.author.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png',
                    content: message.content
                };

                if (isGroupDM) {
                    await client.channels.cache.get(channelId).send(messageOptions);
                } else {
                    await webhook.send(messageOptions);
                }

                results.push({ success: true, messageId: message.id });
            } catch (error) {
                results.push({ error: error.message, messageId: message.id });
            }
            await delay(1000);
        }

        return { results };
    } catch (error) {
        return { error: error.message };
    }
}

// Handle different types of tasks
parentPort.on('message', async (task) => {
    let result;
    
    switch (task.type) {
        case 'fetchMessages':
            result = await fetchMessages(task.data);
            break;
        case 'downloadAttachment':
            result = await downloadAttachment(task.data);
            break;
        case 'processMessageBatch':
            result = await processMessageBatch(task.data);
            break;
        default:
            result = { error: `Unknown task type: ${task.type}` };
    }
    
    parentPort.postMessage(result);
}); 