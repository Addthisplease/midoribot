const { Worker } = require('worker_threads');
const os = require('os');

class WorkerPool {
    constructor(workerPath, numThreads = os.cpus().length) {
        this.workerPath = workerPath;
        this.numThreads = numThreads;
        this.workers = [];
        this.freeWorkers = [];
        this.tasks = [];

        // Initialize workers
        for (let i = 0; i < this.numThreads; i++) {
            this.addNewWorker();
        }
    }

    addNewWorker() {
        const worker = new Worker(this.workerPath);
        worker.on('message', (result) => {
            // Worker becomes free
            this.freeWorkers.push(worker);
            // Get the callback for this worker's task
            const { resolve, reject } = this.tasks.shift();
            if (result.error) {
                reject(new Error(result.error));
            } else {
                resolve(result);
            }
            // Process next task if any
            this.processNextTask();
        });
        worker.on('error', (error) => {
            console.error(`Worker error: ${error}`);
            // Remove the failed worker and create a new one
            this.workers = this.workers.filter(w => w !== worker);
            this.freeWorkers = this.freeWorkers.filter(w => w !== worker);
            this.addNewWorker();
        });
        this.workers.push(worker);
        this.freeWorkers.push(worker);
    }

    async processNextTask() {
        if (this.tasks.length === 0 || this.freeWorkers.length === 0) {
            return;
        }

        const worker = this.freeWorkers.pop();
        const task = this.tasks[0];
        worker.postMessage(task.data);
    }

    async executeTask(data) {
        return new Promise((resolve, reject) => {
            this.tasks.push({ data, resolve, reject });
            this.processNextTask();
        });
    }

    async terminate() {
        await Promise.all(this.workers.map(worker => worker.terminate()));
        this.workers = [];
        this.freeWorkers = [];
        this.tasks = [];
    }
}

module.exports = WorkerPool; 