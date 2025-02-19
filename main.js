require('dotenv').config();
const express = require('express');
const path = require('path');
const FileUtils = require('./src/utils/fileUtils');
const Logger = require('./src/utils/logger');
const discordService = require('./src/services/discordService');
const restoreRoutes = require('./src/routes/restore');
const config = require('./src/config/config');
const { Worker } = require('worker_threads');
const WorkerPool = require('./workerPool');
const fs = require('fs');

const app = express();

// Middleware
app.use(express.json({ limit: '500mb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Initialize required directories
FileUtils.ensureDirectoryExists(path.join(__dirname, config.PATHS.BACKUPS));
FileUtils.ensureDirectoryExists(path.join(__dirname, config.PATHS.UPLOADS));
FileUtils.ensureDirectoryExists(path.join(__dirname, config.PATHS.ATTACHMENTS));

// Initialize worker pools
const messagePool = new WorkerPool('./messageWorker.js', 2);
const downloadPool = new WorkerPool('./messageWorker.js', 2);

// Routes
app.use('/', restoreRoutes);

// Index route
app.get('/', async (req, res) => {
    try {
        const client = discordService.getClient();
        
        // Get DMs
        const dms = Array.from(client.channels.cache.values())
            .filter(channel => channel.type === 'DM')
            .map(channel => ({
                id: channel.id,
                name: channel.recipient?.username || 'Unknown User',
                avatar: channel.recipient?.displayAvatarURL({ format: 'png', size: 128 }),
                type: 'dm'
            }));

        // Get servers
        const guilds = Array.from(client.guilds.cache.values())
            .map(guild => ({
                id: guild.id,
                name: guild.name,
                avatar: guild.iconURL({ format: 'png', size: 128 }),
                type: 'guild'
            }));

        // Combine items
        const items = [...dms, ...guilds];

        res.render('index', { items });
    } catch (error) {
        Logger.error('Error rendering index:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Update the backupDMChannel function with the working version
async function backupDMChannel(channel) {
    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const backupData = messages.map(msg => ({
            author: msg.author.username,
            content: msg.content,
            attachments: msg.attachments.map(att => ({
                url: att.url,
                filename: att.name,
            })),
            timestamp: msg.createdTimestamp,
            webhookData: {
                username: msg.author.username,
                avatarURL: msg.author.avatar ? 
                    `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}` : 
                    'https://cdn.discordapp.com/embed/avatars/0.png'
            }
        }));

        // Ensure backup directory exists
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        // Generate backup ID using timestamp
        const backupId = `backup-${Date.now()}`;
        const backupFilePath = path.join(backupDir, `${backupId}.json`);
        
        // Save the backup
        await fs.promises.writeFile(backupFilePath, JSON.stringify(backupData, null, 2));
        Logger.success(`Backup saved to ${backupFilePath}`);

        return {
            success: true,
            backupId: backupId,
            path: backupFilePath,
            downloadUrl: `/download/${backupId}`
        };
    } catch (error) {
        Logger.error('Backup failed:', error);
        throw error;
    }
}

// Update the backup-dm route
app.post('/backup-dm', async (req, res) => {
    try {
        const { channelId } = req.body;
        const channel = await discordService.getClient().channels.fetch(channelId);
        
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        const result = await backupDMChannel(channel);
        res.json({
            message: 'DM backup created successfully',
            success: true
        });
    } catch (error) {
        Logger.error('Backup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add download route
app.get('/download/:backupId', (req, res) => {
    const { backupId } = req.params;
    const backupPath = path.join(__dirname, 'backups', `${backupId}.json`);

    if (!fs.existsSync(backupPath)) {
        return res.status(404).send('Backup file not found');
    }

    res.download(backupPath);
});

app.post('/backup-guild', async (req, res) => {
    // Your existing guild backup route
    // ...
});

// Initialize Server
async function startServer() {
    try {
        // Initialize Discord client
        await discordService.initialize();
        
        // Show welcome message
        Logger.showWelcome();
        Logger.info('Starting Midoribot...');

        // Start Express server
        app.listen(config.PORT, () => {
            Logger.success(`Server running at http://localhost:${config.PORT}`);
        });
    } catch (error) {
        Logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Start the server
startServer();