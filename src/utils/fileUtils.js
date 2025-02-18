const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const config = require('../config/config');

class FileUtils {
    static ensureDirectoryExists(dirPath) {
        if (!fsSync.existsSync(dirPath)) {
            fsSync.mkdirSync(dirPath, { recursive: true });
            return true;
        }
        return false;
    }

    static async getNextBackupNumber(baseDir) {
        try {
            await fs.mkdir(baseDir, { recursive: true });
            const files = await fs.readdir(baseDir);
            const backupNumbers = files
                .filter(f => f.match(/^[a-z0-9_]+-\d+$/))
                .map(f => parseInt(f.match(/-(\d+)$/)?.[1] || '0'));
            return Math.max(0, ...backupNumbers) + 1;
        } catch (error) {
            return 1;
        }
    }

    static async ensureBackupDirectories(type, name) {
        const baseDir = path.join(process.cwd(), config.PATHS.BACKUPS, type);
        await fs.mkdir(baseDir, { recursive: true });
        
        const backupNumber = await this.getNextBackupNumber(baseDir);
        const backupDir = path.join(baseDir, `${name}-${backupNumber}`);
        const attachmentsDir = path.join(backupDir, 'attachments');
        
        await fs.mkdir(backupDir, { recursive: true });
        await fs.mkdir(attachmentsDir, { recursive: true });
        
        return { baseDir, backupDir, attachmentsDir, backupNumber };
    }
}

module.exports = FileUtils; 