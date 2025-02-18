require('dotenv').config();
const express = require('express');
const path = require('path');
const FileUtils = require('./src/utils/fileUtils');
const Logger = require('./src/utils/logger');
const discordService = require('./src/services/discordService');
const restoreRoutes = require('./src/routes/restore');
const config = require('./src/config/config');

const app = express();

// Middleware
app.use(express.json({ limit: '500mb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Initialize required directories
FileUtils.ensureDirectoryExists(path.join(__dirname, config.PATHS.BACKUPS));
FileUtils.ensureDirectoryExists(path.join(__dirname, config.PATHS.UPLOADS));
FileUtils.ensureDirectoryExists(path.join(__dirname, config.PATHS.ATTACHMENTS));

// Routes
app.use('/', restoreRoutes);

// Keep your existing routes for backup and other functionality
// ...

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