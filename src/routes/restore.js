const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const RestoreService = require('../services/restoreService');
const Logger = require('../utils/logger');
const discordService = require('../services/discordService');
const fs = require('fs');

const restoreService = new RestoreService(discordService.getClient());

router.post('/restore-with-webhook', upload.single('backupFile'), async (req, res) => {
    const { channelId } = req.body;
    const backupFilePath = req.file?.path;

    if (!channelId || !backupFilePath) {
        return res.status(400).json({ error: 'Missing channel ID or backup file' });
    }

    try {
        const result = await restoreService.restoreMessages(channelId, backupFilePath);
        res.json(result);
    } catch (error) {
        Logger.error('Restore error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        // Cleanup uploaded file
        if (backupFilePath) {
            try {
                require('fs').unlinkSync(backupFilePath);
            } catch (error) {
                Logger.error('Error cleaning up file:', error);
            }
        }
    }
});

router.post('/restore-direct', async (req, res) => {
    const { sourceChannelId, targetChannelId, type } = req.body;

    if (!sourceChannelId || !targetChannelId) {
        return res.status(400).json({ 
            error: 'Missing required fields',
            details: {
                sourceChannelId: sourceChannelId ? 'provided' : 'missing',
                targetChannelId: targetChannelId ? 'provided' : 'missing'
            }
        });
    }

    try {
        // Validate channel IDs format
        if (!/^\d+$/.test(sourceChannelId) || !/^\d+$/.test(targetChannelId)) {
            return res.status(400).json({ 
                error: 'Invalid channel ID format. Channel IDs must be numbers.',
                details: {
                    sourceChannelId,
                    targetChannelId
                }
            });
        }

        // Validate channel type
        if (type && !['dm', 'group'].includes(type)) {
            return res.status(400).json({
                error: 'Invalid channel type. Must be either "dm" or "group".',
                details: { type }
            });
        }

        const result = await restoreService.restoreDirectMessages(sourceChannelId, targetChannelId, type);
        res.json(result);
    } catch (error) {
        Logger.error('Direct restore error:', error);
        
        // Handle specific Discord API error codes
        let statusCode = 500;
        let errorMessage = error.message;
        
        switch (error.code) {
            case 10013:
                statusCode = 404;
                errorMessage = `The user ID ${sourceChannelId} does not exist on Discord.`;
                break;
            case 50001:
                statusCode = 403;
                errorMessage = `Cannot access the user. They may have blocked the bot or have DMs disabled.`;
                break;
            case 50007:
                statusCode = 403;
                errorMessage = `Cannot send messages to this user. They have DMs disabled or have blocked the bot.`;
                break;
            case 10003:
                statusCode = 404;
                errorMessage = `The channel ID ${targetChannelId} does not exist.`;
                break;
            case 50013:
                statusCode = 403;
                errorMessage = `The bot lacks permissions to access the target channel.`;
                break;
            default:
                if (error.code) {
                    statusCode = error.code >= 500 ? 500 : 400;
                }
        }
        
        res.status(statusCode).json({ 
            error: errorMessage,
            details: {
                sourceChannelId,
                targetChannelId,
                type,
                errorCode: error.code
            }
        });
    }
});

router.post('/restore-server', upload.single('backupFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No backup file provided' });
        }

        const { serverId } = req.body;
        if (!serverId) {
            return res.status(400).json({ error: 'No server ID provided' });
        }

        // Validate server ID format
        if (!/^\d+$/.test(serverId)) {
            return res.status(400).json({ error: 'Invalid server ID format. Server ID must be a number.' });
        }

        // Read and parse the backup file
        let backupData;
        try {
            const fileContent = await fs.promises.readFile(req.file.path, 'utf-8');
            backupData = JSON.parse(fileContent);

            // Handle both array format (messages) and object format (server backup)
            if (Array.isArray(backupData)) {
                // Group messages by channelId and channelName
                const messagesByChannel = backupData.reduce((acc, message) => {
                    const channelId = message.channelId;
                    const channelName = message.channelName || 'restored-chat';
                    
                    if (!acc[channelId]) {
                        acc[channelId] = {
                            name: channelName,
                            messages: []
                        };
                    }
                    acc[channelId].messages.push(message);
                    return acc;
                }, {});

                // Convert to server backup format
                backupData = {
                    channels: Object.entries(messagesByChannel).map(([channelId, data]) => ({
                        name: data.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase(), // Sanitize channel name
                        type: 'text',
                        messages: data.messages
                    })),
                    roles: [] // No roles to restore
                };
            } else if (typeof backupData === 'object') {
                // If it's already a server backup, ensure required structure
                if (!backupData.channels) {
                    backupData.channels = [];
                }
                if (!backupData.roles) {
                    backupData.roles = [];
                }
            } else {
                throw new Error('Invalid backup data format');
            }

        } catch (error) {
            return res.status(400).json({ 
                error: 'Invalid backup file',
                details: error.message
            });
        }

        // Perform the restore
        const result = await restoreService.restoreServer(serverId, backupData);
        res.json(result);
    } catch (error) {
        Logger.error('Server restore error:', error);
        
        // Handle specific error cases
        if (error.code === 50001) {
            return res.status(403).json({ 
                error: 'Bot lacks required permissions',
                details: error.message
            });
        } else if (error.code === 10004) {
            return res.status(404).json({ 
                error: 'Guild not found',
                details: error.message
            });
        }

        res.status(500).json({ 
            error: 'Failed to restore server',
            details: error.message
        });
    } finally {
        // Cleanup uploaded file
        if (req.file?.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (error) {
                Logger.error('Error cleaning up file:', error);
            }
        }
    }
});

// Add endpoint to fetch server channels
router.get('/api/servers/:serverId/channels', async (req, res) => {
    try {
        const { serverId } = req.params;

        // Validate server ID
        if (!/^\d+$/.test(serverId)) {
            return res.status(400).json({ error: 'Invalid server ID format' });
        }

        // Get the guild
        const guild = await discordService.getClient().guilds.fetch(serverId);
        if (!guild) {
            return res.status(404).json({ error: 'Server not found' });
        }

        // Get channels
        const channels = guild.channels.cache
            .filter(channel => channel.type === 'GUILD_TEXT')
            .map(channel => ({
                id: channel.id,
                name: channel.name,
                type: channel.type,
                parentId: channel.parentId
            }));

        res.json(channels);
    } catch (error) {
        Logger.error('Error fetching channels:', error);
        res.status(500).json({ error: 'Failed to fetch channels' });
    }
});

module.exports = router; 