require('dotenv').config();

module.exports = {
    PORT: 8321,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    RATE_LIMIT_DELAY: 1000,
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_DELAY: 5000,
    BATCH_SIZE: 10,
    PATHS: {
        BACKUPS: 'backups',
        UPLOADS: 'uploads',
        ATTACHMENTS: 'attachments'
    },
    RATE_LIMITS: {
        MESSAGES_PER_SECOND: 1,
        ATTACHMENTS_PER_SECOND: 1,
        WEBHOOK_OPERATIONS_PER_MINUTE: 30
    }
}; 