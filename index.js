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

app.get('/sysinfo', (req, res) => {
    exec('df -B1 /', (err, stdout) => {
        if (err) return res.status(500).json({error: 'Failed to get disk info'});
        const lines = stdout.trim().split('\n');
        if (lines.length > 1) {
            const parts = lines[1].split(/\s+/);
            const total = parseInt(parts[1]);
            const used = parseInt(parts[2]);
            res.json({ total, used });
        } else {
            res.json({ total: 0, used: 0 });
        }
    });
});

app.get('/files', (req, res) => {
    const tmpDir = os.tmpdir();
    fs.readdir(tmpDir, (err, files) => {
        if (err) return res.status(500).json({error: 'Failed to read tmp dir'});
        const uploadFiles = [];
        files.forEach(file => {
            if (file.startsWith('upload_')) {
                const p = path.join(tmpDir, file);
                try {
                    const stat = fs.statSync(p);
                    uploadFiles.push({ name: file, size: stat.size, time: stat.mtimeMs });
                } catch (e) {}
            }
        });
        res.json({ files: uploadFiles });
    });
});

app.post('/delete-files', (req, res) => {
    const { files } = req.body;
    if (!Array.isArray(files)) return res.status(400).json({error: 'files array required'});
    const tmpDir = os.tmpdir();
    let deletedCount = 0;
    let freedBytes = 0;
    files.forEach(file => {
        if (file.startsWith('upload_')) {
            const p = path.join(tmpDir, file);
            try {
                const stat = fs.statSync(p);
                freedBytes += stat.size;
                fs.unlinkSync(p);
                deletedCount++;
            } catch (e) {}
        }
    });
    res.json({ success: true, deletedCount, freedBytes });
});

app.post('/cleanup', (req, res) => {
    const tmpDir = os.tmpdir();
    let deletedCount = 0;
    let freedBytes = 0;
    fs.readdir(tmpDir, (err, files) => {
        if (err) return res.status(500).json({error: 'Failed to read tmp dir'});
        files.forEach(file => {
            if (file.startsWith('upload_')) {
                const p = path.join(tmpDir, file);
                try {
                    const stat = fs.statSync(p);
                    freedBytes += stat.size;
                    fs.unlinkSync(p);
                    deletedCount++;
                } catch (e) {}
            }
        });
        res.json({ success: true, deletedCount, freedBytes });
    });
});

app.post('/cancel', (req, res) => {
    const { uploadId } = req.body;
    if (uploadId && activeUploads.has(uploadId)) {
        const controller = activeUploads.get(uploadId);
        controller.abort();
        activeUploads.delete(uploadId);
        res.json({ success: true, message: 'Upload cancelled' });
    } else {
        res.json({ success: false, message: 'Upload ID not found' });
    }
});

app.get('/upload-stream', async (req, res) => {
    const { url, provider, uploadId } = req.query;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    if (!url || !provider || !uploadId) {
        sendEvent({ stage: 'error', message: 'Missing url, provider, or uploadId' });
        return res.end();
    }

    const abortController = new AbortController();
    activeUploads.set(uploadId, abortController);

    const tempFilePath = path.join(os.tmpdir(), 'upload_' + uuidv4());
    
    try {
        let totalDownloadSize = 0;
        try {
            const headRes = await axios.head(url, { signal: abortController.signal });
            totalDownloadSize = parseInt(headRes.headers['content-length'] || 0);
        } catch (e) {}

        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            signal: abortController.signal
        });

        if (totalDownloadSize === 0) {
            totalDownloadSize = parseInt(response.headers['content-length'] || 0);
        }

        let downloadedBytes = 0;
        let startTime = Date.now();
        let lastReportTime = Date.now();

        response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const now = Date.now();
            if (now - lastReportTime > 250) {
                const speed = downloadedBytes / ((now - startTime) / 1000);
                sendEvent({ stage: 'Downloading to Server', loaded: downloadedBytes, total: totalDownloadSize, speed });
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
                reject(new Error('canceled'));
            });
        });

        sendEvent({ stage: 'Downloading to Server', loaded: downloadedBytes, total: totalDownloadSize || downloadedBytes, speed: 0 });

        // Upload
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
                    sendEvent({ stage: 'Uploading to Provider', loaded: progressEvent.loaded, total: progressEvent.total || fileSize, speed });
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
        } else {
            throw new Error('Invalid provider');
        }

        fs.unlinkSync(tempFilePath);
        activeUploads.delete(uploadId);
        sendEvent({ stage: 'done', url: finalUrl });
        res.end();

    } catch (error) {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        activeUploads.delete(uploadId);
        sendEvent({ stage: 'error', message: error.message === 'canceled' ? 'Cancelled by user' : (error.message || 'Upload failed') });
        res.end();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
