const { Client, Intents } = require('discord.js-selfbot-v13');
const config = require('../config/config');
const Logger = require('../utils/logger');

class DiscordService {
    constructor() {
        this.client = new Client({
            intents: [
                'GUILDS',
                'GUILD_MESSAGES',
                'GUILD_MEMBERS',
                'DIRECT_MESSAGES',
                'DIRECT_MESSAGE_REACTIONS',
                'DIRECT_MESSAGE_TYPING'
            ],
            // Enable all partials for DM support
            partials: ['CHANNEL', 'MESSAGE', 'USER', 'GUILD_MEMBER', 'REACTION']
        });
    }

    async initialize() {
        try {
            await this.client.login(config.DISCORD_TOKEN);
            Logger.success(`Logged in as ${this.client.user.tag}`);
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