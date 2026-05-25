const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { exec, spawn } = require('child_process');

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
        const currentData = activeUploads.get(uploadId) || {};
        activeUploads.set(uploadId, { ...currentData, status: 'error', message: 'Cancelled by user', _startTime: Date.now(), speed: 0 });
        
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

app.post('/cancel-all', (req, res) => {
    activeUploads.forEach((value, key) => {
        if (value.status !== 'done' && value.status !== 'error' && value.status !== 'Cancelled by user' && value.message !== 'Cancelled by user') {
            if (abortControllers.has(key)) {
                try { abortControllers.get(key).abort(); } catch(e) {}
                abortControllers.delete(key);
            }
            activeUploads.set(key, { ...value, status: 'error', message: 'Cancelled by user', speed: 0 });
            
            const tmpDir = os.tmpdir();
            try {
                fs.readdirSync(tmpDir).forEach(file => {
                    if (file.startsWith('upload_' + key)) {
                        fs.unlinkSync(path.join(tmpDir, file));
                    }
                });
            } catch(e) {}
        }
    });
    res.json({ success: true });
});

app.get('/active-tasks', (req, res) => {
    const tasks = [];
    activeUploads.forEach((value, key) => {
        const data = { ...value };
        delete data._startTime;
        tasks.push({ id: key, ...data });
    });
    res.json({ tasks: tasks.reverse() });
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
    activeUploads.set(uploadId, { url: url, status: 'Starting', loaded: 0, total: 0, speed: 0, _startTime: Date.now() });
    const abortController = new AbortController();
    abortControllers.set(uploadId, abortController);

    res.json({ uploadId });

    (async () => {
        let tempFilePath = '';
        try {
            let actualUrl = url;
            
            // Handle GoFile and other direct download links by checking for redirects
            try {
                const checkRes = await axios.head(url, { 
                    maxRedirects: 0, 
                    validateStatus: status => status >= 200 && status < 400 
                });
                if (checkRes.headers && checkRes.headers.location) {
                    actualUrl = checkRes.headers.location;
                }
            } catch(e) {
                if (e.response && e.response.headers && e.response.headers.location) {
                    actualUrl = e.response.headers.location;
                }
            }

            let totalDownloadSize = 0;
            let downloadHeaders = {};
            try {
                const headRes = await axios.head(actualUrl, { signal: abortController.signal, timeout: 30000 });
                totalDownloadSize = parseInt(headRes.headers['content-length'] || 0);
                downloadHeaders = headRes.headers;
            } catch (e) { }

            let originalFilename = getFilenameFromUrl(actualUrl, downloadHeaders);
            if (!originalFilename) {
                const ct = downloadHeaders['content-type'] || '';
                if (ct.includes('video/mp4')) originalFilename = 'video.mp4';
                else if (ct.includes('video/x-matroska')) originalFilename = 'video.mkv';
                else if (ct.includes('application/zip')) originalFilename = 'file.zip';
                else if (ct.includes('application/vnd.android.package-archive')) originalFilename = 'app.apk';
                else originalFilename = 'file.bin';
            }
            const safeFilename = originalFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
            const actualFileName = `upload_${uploadId}_${safeFilename}`;
            tempFilePath = path.join(os.tmpdir(), actualFileName);

            let startTime = Date.now();
            activeUploads.set(uploadId, { url: url, status: 'Downloading to Server', loaded: 0, total: totalDownloadSize, speed: 0, _startTime: startTime });

            const wgetArgs = [
                '-c', 
                '-t', '10', 
                '--waitretry=2', 
                '-O', tempFilePath 
            ];

            // For GoFile we must send a fake User-Agent and follow cookies if any
            wgetArgs.push('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            if (actualUrl.includes('gofile.io')) {
                wgetArgs.push('--header=Cookie: accountToken=guest');
            }
            
            if (useProxy) {
                try {
                    wgetArgs.push(`--referer=${new URL(actualUrl).origin}/`);
                } catch(e) {}
            }
            
            wgetArgs.push(actualUrl);

            fs.writeFileSync(tempFilePath, '');

            const wgetProcess = spawn('wget', wgetArgs);

            let lastReportTime = Date.now();
            let lastLoaded = 0;
            let speedBuffer = [];

            const progressInterval = setInterval(() => {
                try {
                    if (fs.existsSync(tempFilePath)) {
                        const loaded = fs.statSync(tempFilePath).size;
                        const now = Date.now();
                        const elapsedSec = (now - lastReportTime) / 1000;
                        
                        if (elapsedSec > 0) {
                            const bytesDiff = loaded - lastLoaded;
                            if (bytesDiff >= 0) {
                                const currentSpeed = bytesDiff / elapsedSec;
                                speedBuffer.push(currentSpeed);
                                if (speedBuffer.length > 5) speedBuffer.shift();
                                const avgSpeed = speedBuffer.reduce((a, b) => a + b, 0) / speedBuffer.length;
                                
                                activeUploads.set(uploadId, { 
                                    url: url,
                                    status: 'Downloading to Server', 
                                    loaded: loaded, 
                                    total: totalDownloadSize || loaded, 
                                    speed: avgSpeed, 
                                    _startTime: startTime 
                                });
                            }
                            lastLoaded = loaded;
                            lastReportTime = now;
                        }
                    }
                } catch(e) {}
            }, 1000);

            abortController.signal.addEventListener('abort', () => {
                wgetProcess.kill('SIGKILL');
            });

            await new Promise((resolve, reject) => {
                wgetProcess.on('close', (code) => {
                    clearInterval(progressInterval);
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`Download failed (wget exit code ${code})`));
                    }
                });
                wgetProcess.on('error', (err) => {
                    clearInterval(progressInterval);
                    reject(err);
                });
            });

            const fileSize = fs.existsSync(tempFilePath) ? fs.statSync(tempFilePath).size : 0;
            
            // If the file is just an HTML page (like a GoFile block page), it failed
            if (fileSize < 100000) { // Less than 100KB, check if it's HTML
                try {
                    const content = fs.readFileSync(tempFilePath, 'utf8');
                    if (content.includes('<!DOCTYPE html>') || content.includes('<html')) {
                        throw new Error('Received HTML instead of file. Link might be protected or expired.');
                    }
                } catch(e) {
                    if (e.message.includes('Received HTML')) throw e;
                }
            }
            
            if (fileSize === 0) throw new Error('Downloaded file is empty or failed');

            const fileUrl = `${req.protocol}://${req.get('host')}/f/${actualFileName}`;
            activeUploads.set(uploadId, { url: url, status: 'done', filename: actualFileName, size: fileSize, fileUrl: fileUrl, _startTime: Date.now() });
            abortControllers.delete(uploadId);

        } catch (error) {
            try { if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch(e) {}
            const msg = error.message === 'canceled' ? 'Cancelled by user' : (error.message || 'Download failed');
            activeUploads.set(uploadId, { url: url, status: 'error', message: msg, _startTime: Date.now(), speed: 0 });
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
