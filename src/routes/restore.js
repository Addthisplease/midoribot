const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const RestoreService = require('../services/restoreService');
const Logger = require('../utils/logger');
const discordService = require('../services/discordService');

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
        return res.status(400).json({ error: 'Missing source or target channel ID' });
    }

    try {
        const result = await restoreService.restoreDirectMessages(sourceChannelId, targetChannelId, type);
        res.json(result);
    } catch (error) {
        Logger.error('Direct restore error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router; 