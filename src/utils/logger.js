const chalk = require('chalk');
const figlet = require('figlet');

class Logger {
    static showWelcome() {
        console.log(chalk.blue(figlet.textSync('Midoribot', { horizontalLayout: 'full' })));
    }

    static info(message) {
        console.log(chalk.blue(`[INFO] ${message}`));
    }

    static success(message) {
        console.log(chalk.green(`[SUCCESS] ${message}`));
    }

    static error(message, error) {
        console.error(chalk.red(`[ERROR] ${message}`), error || '');
    }

    static warn(message) {
        console.log(chalk.yellow(`[WARN] ${message}`));
    }
}

module.exports = Logger; 