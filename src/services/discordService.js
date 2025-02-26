const { Client } = require('discord.js-selfbot-v13');
const config = require('../config/config');
const Logger = require('../utils/logger');

class DiscordService {
    constructor() {
        this.client = new Client({
            checkUpdate: false,
            syncStatus: false,
            ws: {
                properties: {
                    browser: 'Discord iOS'
                }
            }
        });

        // Handle client events
        this.client.on('ready', () => {
            Logger.success(`Logged in as ${this.client.user.tag}`);
        });

        this.client.on('error', (error) => {
            Logger.error('Discord client error:', error);
        });

        this.client.on('disconnect', () => {
            Logger.warn('Discord client disconnected');
        });
    }

    async initialize() {
        try {
            await this.client.login(config.DISCORD_TOKEN);
            return true;
        } catch (error) {
            Logger.error('Failed to login to Discord:', error);
            return false;
        }
    }

    getClient() {
        return this.client;
    }
}

module.exports = new DiscordService(); 