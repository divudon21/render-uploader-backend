const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

const activeUploads = new Map();
const abortControllers = new Map();

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
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/cancel', (req, res) => {
    const { uploadId } = req.body;
    if (uploadId && abortControllers.has(uploadId)) {
        abortControllers.get(uploadId).abort();
        abortControllers.delete(uploadId);
        activeUploads.set(uploadId, { status: 'error', message: 'Cancelled by user' });
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Not found' });
    }
});

app.get('/status', (req, res) => {
    const { uploadId } = req.query;
    if (activeUploads.has(uploadId)) {
        res.json(activeUploads.get(uploadId));
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

app.post('/start-upload', async (req, res) => {
    const { url, provider } = req.body;
    if (!url || !provider) return res.status(400).json({error: 'Missing params'});

    const uploadId = uuidv4();
    activeUploads.set(uploadId, { status: 'Starting', loaded: 0, total: 0, speed: 0 });
    const abortController = new AbortController();
    abortControllers.set(uploadId, abortController);

    res.json({ uploadId });

    (async () => {
        const tempFilePath = path.join(os.tmpdir(), 'upload_' + uploadId);
        try {
            let totalDownloadSize = 0;
            try {
                const headRes = await axios.head(url, { signal: abortController.signal });
                totalDownloadSize = parseInt(headRes.headers['content-length'] || 0);
            } catch (e) {}

            const response = await axios({
                url, method: 'GET', responseType: 'stream', signal: abortController.signal
            });

            if (totalDownloadSize === 0) totalDownloadSize = parseInt(response.headers['content-length'] || 0);

            let downloadedBytes = 0;
            let startTime = Date.now();
            let lastReportTime = Date.now();

            activeUploads.set(uploadId, { status: 'Downloading to Server', loaded: 0, total: totalDownloadSize, speed: 0 });

            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                const now = Date.now();
                if (now - lastReportTime > 250) {
                    const speed = downloadedBytes / ((now - startTime) / 1000);
                    activeUploads.set(uploadId, { status: 'Downloading to Server', loaded: downloadedBytes, total: totalDownloadSize, speed });
                    lastReportTime = now;
                }
            });

            const writer = fs.createWriteStream(tempFilePath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                abortController.signal.addEventListener('abort', () => {
                    writer.destroy();
                    reject(new Error('Cancelled'));
                });
            });

            activeUploads.set(uploadId, { status: 'Downloading to Server', loaded: downloadedBytes, total: totalDownloadSize || downloadedBytes, speed: 0 });

            let finalUrl = '';
            const form = new FormData();
            const fileSize = fs.statSync(tempFilePath).size;

            startTime = Date.now();
            lastReportTime = Date.now();

            const uploadConfig = {
                signal: abortController.signal,
                onUploadProgress: (progressEvent) => {
                    const now = Date.now();
                    if (now - lastReportTime > 250) {
                        const speed = progressEvent.loaded / ((now - startTime) / 1000);
                        activeUploads.set(uploadId, { status: 'Uploading to Provider', loaded: progressEvent.loaded, total: progressEvent.total || fileSize, speed });
                        lastReportTime = now;
                    }
                }
            };

            if (provider === 'catbox') {
                form.append('reqtype', 'fileupload');
                form.append('fileToUpload', fs.createReadStream(tempFilePath));
                uploadConfig.headers = form.getHeaders();
                const uploadRes = await axios.post('https://catbox.moe/user/api.php', form, uploadConfig);
                finalUrl = uploadRes.data;
            } else if (provider === 'litterbox') {
                form.append('reqtype', 'fileupload');
                form.append('time', '24h');
                form.append('fileToUpload', fs.createReadStream(tempFilePath));
                uploadConfig.headers = form.getHeaders();
                const uploadRes = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, uploadConfig);
                finalUrl = uploadRes.data;
            } else if (provider === 'gofile') {
                const serverRes = await axios.get('https://api.gofile.io/servers', { signal: abortController.signal });
                const server = serverRes.data.data.servers[0].name;
                const gofileForm = new FormData();
                gofileForm.append('file', fs.createReadStream(tempFilePath));
                uploadConfig.headers = gofileForm.getHeaders();
                const uploadRes = await axios.post(`https://${server}.gofile.io/contents/uploadfile`, gofileForm, uploadConfig);
                finalUrl = uploadRes.data.data.downloadPage;
            }

            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            activeUploads.set(uploadId, { status: 'done', url: finalUrl });
            abortControllers.delete(uploadId);

        } catch (error) {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            activeUploads.set(uploadId, { status: 'error', message: error.message === 'canceled' ? 'Cancelled by user' : (error.message || 'Upload failed') });
            abortControllers.delete(uploadId);
        }
    })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
