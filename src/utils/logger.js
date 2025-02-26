const chalk = require('chalk');
const figlet = require('figlet');

class Logger {
    static showWelcome() {
        console.log(figlet.textSync('Midoribot', { horizontalLayout: 'full' }));
    }

    static info(message) {
        console.log(`[INFO] ${message}`);
    }

    static success(message) {
        console.log(`[SUCCESS] ${message}`);
    }

    static error(message, error) {
        console.error(`[ERROR] ${message}`, error || '');
    }

    static warn(message) {
        console.log(`[WARN] ${message}`);
    }
}

module.exports = Logger; 