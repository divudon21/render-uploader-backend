const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

const activeUploads = new Map();
const abortControllers = new Map();

// Keep alive & internal memory cleanup + 24h auto-delete
setInterval(() => {
    const now = Date.now();
    activeUploads.forEach((value, key) => {
        if (value.status === 'done' || value.status === 'error' || value.status === 'Cancelled by user') {
            if (value._startTime && now - value._startTime > 2 * 60 * 60 * 1000) {
                activeUploads.delete(key);
                abortControllers.delete(key);
            }
        } else {
            if (value._startTime && now - value._startTime > 3 * 60 * 60 * 1000) {
                activeUploads.delete(key);
                abortControllers.delete(key);
            }
        }
    });

    // 24 hours file auto-delete
    const tmpDir = os.tmpdir();
    try {
        fs.readdirSync(tmpDir).forEach(file => {
            if (file.startsWith('upload_')) {
                const p = path.join(tmpDir, file);
                try {
                    const stats = fs.statSync(p);
                    if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
                        fs.unlinkSync(p);
                        console.log(`Auto-deleted file older than 24h: ${file}`);
                    }
                } catch(e) {}
            }
        });
    } catch(e) {}
}, 60000);

app.get('/sysinfo', (req, res) => {
    exec('df -B1 /', (err, stdout) => {
        if (err) return res.status(500).json({error: 'Failed to get disk info'});
        const lines = stdout.trim().split('\n');
        if (lines.length > 1) {
            const parts = lines[1].split(/\s+/);
            res.json({ total: parseInt(parts[1]), used: parseInt(parts[2]) });
        } else {
            res.json({ total: 0, used: 0 });
        }
    });
});

app.post('/cleanup', (req, res) => {
    const tmpDir = os.tmpdir();
    let deletedCount = 0; let freedBytes = 0;
    fs.readdirSync(tmpDir).forEach(file => {
        if (file.startsWith('upload_')) {
            const p = path.join(tmpDir, file);
            try {
                freedBytes += fs.statSync(p).size;
                fs.unlinkSync(p);
                deletedCount++;
            } catch (e) {}
        }
    });
    res.json({ success: true, deletedCount, freedBytes });
});

app.get('/files', (req, res) => {
    const tmpDir = os.tmpdir();
    const uploadFiles = [];
    try {
        fs.readdirSync(tmpDir).forEach(file => {
            if (file.startsWith('upload_')) {
                const p = path.join(tmpDir, file);
                try {
                    const stat = fs.statSync(p);
                    uploadFiles.push({ name: file, size: stat.size, time: stat.mtimeMs });
                } catch (e) {}
            }
        });
        uploadFiles.sort((a, b) => b.time - a.time);
        res.json({ files: uploadFiles });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/delete', (req, res) => {
    const { name } = req.body;
    if (!name || !name.startsWith('upload_')) return res.status(400).json({error: 'Invalid file'});
    const p = path.join(os.tmpdir(), name);
    try {
        if (fs.existsSync(p)) { fs.unlinkSync(p); res.json({ success: true }); }
        else { res.status(404).json({ error: 'File not found' }); }
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/cancel', (req, res) => {
    const { uploadId } = req.body;
    if (uploadId && abortControllers.has(uploadId)) {
        abortControllers.get(uploadId).abort();
        abortControllers.delete(uploadId);
        activeUploads.set(uploadId, { status: 'error', message: 'Cancelled by user', _startTime: Date.now() });
        
        // Permanently delete file immediately
        const tmpDir = os.tmpdir();
        try {
            fs.readdirSync(tmpDir).forEach(file => {
                if (file.startsWith('upload_' + uploadId)) {
                    fs.unlinkSync(path.join(tmpDir, file));
                }
            });
        } catch(e) {}
        
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Not found' });
    }
});

app.get('/status', (req, res) => {
    const { uploadId } = req.query;
    if (activeUploads.has(uploadId)) {
        const data = { ...activeUploads.get(uploadId) };
        delete data._startTime; 
        res.json(data);
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

// Serve downloaded files (res.sendFile supports Range headers out of the box for video streaming / resume)
app.get('/f/:filename', (req, res) => {
    const p = path.join(os.tmpdir(), req.params.filename);
    if (fs.existsSync(p)) {
        res.sendFile(p);
    } else {
        res.status(404).send('File not found or expired');
    }
});

function getFilenameFromUrl(url, headers) {
    const cd = headers && headers['content-disposition'];
    if (cd) {
        const match = cd.match(/filename[^;=\n]*=(['"]?)([^'"\n]*)\1/);
        if (match && match[2]) return match[2];
    }
    try {
        const urlPath = new URL(url).pathname;
        const parts = urlPath.split('/');
        const last = parts[parts.length - 1];
        if (last && last.includes('.')) return decodeURIComponent(last);
    } catch(e) {}
    return null;
}

app.post('/start-upload', async (req, res) => {
    const { url, useProxy } = req.body;
    if (!url) return res.status(400).json({error: 'Missing params'});

    const uploadId = uuidv4();
    activeUploads.set(uploadId, { status: 'Starting', loaded: 0, total: 0, speed: 0, _startTime: Date.now() });
    const abortController = new AbortController();
    abortControllers.set(uploadId, abortController);

    res.json({ uploadId });

    (async () => {
        let tempFilePath = '';
        try {
            let totalDownloadSize = 0;
            let downloadHeaders = {};
            try {
                const headRes = await axios.head(url, { signal: abortController.signal, timeout: 30000 });
                totalDownloadSize = parseInt(headRes.headers['content-length'] || 0);
                downloadHeaders = headRes.headers;
            } catch (e) { /* HEAD may fail, continue */ }

            const downloadConfig = {
                url, method: 'GET', responseType: 'stream',
                signal: abortController.signal, timeout: 600000,
                maxRedirects: 10
            };

            if (useProxy) {
                downloadConfig.headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Referer': new URL(url).origin + '/',
                    'Connection': 'keep-alive'
                };
            }

            const response = await axios(downloadConfig);

            if (totalDownloadSize === 0) totalDownloadSize = parseInt(response.headers['content-length'] || 0);
            if (!downloadHeaders['content-disposition']) downloadHeaders = response.headers;
            
            let originalFilename = getFilenameFromUrl(url, downloadHeaders);
            if (!originalFilename) {
                const ct = response.headers['content-type'] || '';
                if (ct.includes('video/mp4')) originalFilename = 'video.mp4';
                else if (ct.includes('video/x-matroska')) originalFilename = 'video.mkv';
                else if (ct.includes('application/zip')) originalFilename = 'file.zip';
                else originalFilename = 'file.bin';
            }
            const safeFilename = originalFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
            const actualFileName = `upload_${uploadId}_${safeFilename}`;
            tempFilePath = path.join(os.tmpdir(), actualFileName);

            let downloadedBytes = 0;
            let startTime = Date.now();
            let lastReportTime = Date.now();

            activeUploads.set(uploadId, { status: 'Downloading to Server', loaded: 0, total: totalDownloadSize, speed: 0, _startTime: Date.now() });

            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                const now = Date.now();
                if (now - lastReportTime > 300) {
                    const elapsed = (now - startTime) / 1000;
                    const speed = elapsed > 0 ? downloadedBytes / elapsed : 0;
                    activeUploads.set(uploadId, { status: 'Downloading to Server', loaded: downloadedBytes, total: totalDownloadSize || 0, speed, _startTime: startTime });
                    lastReportTime = now;
                }
            });

            const writer = fs.createWriteStream(tempFilePath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                abortController.signal.addEventListener('abort', () => { writer.destroy(); reject(new Error('Cancelled')); });
            });

            const fileSize = fs.statSync(tempFilePath).size;
            console.log(`Downloaded ${actualFileName} successfully (${fileSize} bytes) and stored locally.`);

            // Link generation & success
            const fileUrl = `${req.protocol}://${req.get('host')}/f/${actualFileName}`;
            activeUploads.set(uploadId, { status: 'done', filename: actualFileName, size: fileSize, fileUrl: fileUrl, _startTime: Date.now() });
            abortControllers.delete(uploadId);

        } catch (error) {
            try { if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch(e) {}
            const msg = error.message === 'canceled' ? 'Cancelled by user' : (error.message || 'Download failed');
            console.error(`Download error: ${msg}`);
            activeUploads.set(uploadId, { status: 'error', message: msg, _startTime: Date.now() });
            abortControllers.delete(uploadId);
        }
    })();
});

app.get('/server-stats', (req, res) => {
    const cpus = os.cpus();
    const cpuCount = cpus.length;
    const cpuModel = cpus[0] ? cpus[0].model : 'Unknown';
    const cpuSpeed = cpus[0] ? cpus[0].speed : 0;

    let totalIdle = 0, totalTick = 0;
    cpus.forEach(cpu => {
        for (const type in cpu.times) totalTick += cpu.times[type];
        totalIdle += cpu.times.idle;
    });
    const cpuUsage = ((1 - totalIdle / totalTick) * 100).toFixed(1);

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const uptimeSec = os.uptime();
    const processUptime = process.uptime();

    const platform = os.platform();
    const arch = os.arch();
    const hostname = os.hostname();
    const nodeVersion = process.version;

    exec('df -B1 /', (err, stdout) => {
        let diskTotal = 0, diskUsed = 0;
        if (!err) {
            const lines = stdout.trim().split('\n');
            if (lines.length > 1) {
                const parts = lines[1].split(/\s+/);
                diskTotal = parseInt(parts[1] || 0);
                diskUsed = parseInt(parts[2] || 0);
            }
        }

        const loadAvg = os.loadavg();

        res.json({
            cpu: {
                model: cpuModel,
                cores: cpuCount,
                speed: cpuSpeed,
                usage: parseFloat(cpuUsage),
                loadAvg: loadAvg.map(l => parseFloat(l.toFixed(2)))
            },
            memory: {
                total: totalMem,
                used: usedMem,
                free: freeMem
            },
            disk: {
                total: diskTotal,
                used: diskUsed
            },
            system: {
                platform: platform,
                arch: arch,
                hostname: hostname,
                nodeVersion: nodeVersion,
                uptime: uptimeSec,
                processUptime: processUptime
            },
            activeUploads: activeUploads.size
        });
    });
});

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'FastGo Backend', activeUploads: activeUploads.size, uptime: process.uptime() });
});

app.get('/ping', (req, res) => {
    res.json({ pong: true, time: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
