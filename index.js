const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { exec, spawn } = require('child_process');

const app = express();
app.use(express.json());

// CORS for frontend access
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const activeUploads = new Map();
const abortControllers = new Map();

// Keep alive & cleanup stale
setInterval(() => {
  activeUploads.forEach((value, key) => {
    if (value._startTime && Date.now() - value._startTime > 30 * 60 * 1000) {
      activeUploads.delete(key);
      abortControllers.delete(key);
    }
  });
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
    if (file.startsWith('upload_') || file.startsWith('yt_')) {
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
      if (file.startsWith('upload_') || file.startsWith('yt_')) {
        const p = path.join(tmpDir, file);
        try {
          const stat = fs.statSync(p);
          const isYt = file.startsWith('yt_');
          uploadFiles.push({ 
            name: file, 
            size: stat.size, 
            time: stat.mtimeMs,
            type: isYt ? 'yt-dlp' : 'direct'
          });
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
  if (!name || (!name.startsWith('upload_') && !name.startsWith('yt_'))) return res.status(400).json({error: 'Invalid file'});
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
    activeUploads.set(uploadId, { status: 'error', message: 'Cancelled by user' });
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
  return 'uploaded_file';
}

// Original upload endpoint (kept for compatibility)
app.post('/start-upload', async (req, res) => {
  const { url, provider, useProxy } = req.body;
  if (!url || !provider) return res.status(400).json({error: 'Missing params'});

  const uploadId = uuidv4();
  activeUploads.set(uploadId, { status: 'Starting', loaded: 0, total: 0, speed: 0, _startTime: Date.now() });
  const abortController = new AbortController();
  abortControllers.set(uploadId, abortController);

  res.json({ uploadId });

  (async () => {
    const tempFilePath = path.join(os.tmpdir(), 'upload_' + uploadId);
    try {
      let totalDownloadSize = 0;
      let downloadHeaders = {};
      try {
        const headRes = await axios.head(url, { signal: abortController.signal, timeout: 30000 });
        totalDownloadSize = parseInt(headRes.headers['content-length'] || 0);
        downloadHeaders = headRes.headers;
      } catch (e) { }

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
          'Referer': new URL(url).origin + '/',
          'Connection': 'keep-alive'
        };
      }

      const response = await axios(downloadConfig);

      if (totalDownloadSize === 0) totalDownloadSize = parseInt(response.headers['content-length'] || 0);
      if (!downloadHeaders['content-disposition']) downloadHeaders = response.headers;
      const filename = getFilenameFromUrl(url, downloadHeaders);

      let downloadedBytes = 0;
      let startTime = Date.now();
      let lastReportTime = Date.now();

      activeUploads.set(uploadId, { status: 'Downloading to Server', loaded: 0, total: totalDownloadSize, speed: 0, _startTime: startTime });

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
      console.log(`Downloaded ${filename} (${fileSize} bytes), uploading to ${provider}...`);

      startTime = Date.now();
      lastReportTime = Date.now();

      const uploadConfig = {
        signal: abortController.signal,
        timeout: 900000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        onUploadProgress: (progressEvent) => {
          const now = Date.now();
          if (now - lastReportTime > 300) {
            const elapsed = (now - startTime) / 1000;
            const speed = elapsed > 0 ? progressEvent.loaded / elapsed : 0;
            activeUploads.set(uploadId, {
              status: 'Uploading to ' + provider,
              loaded: progressEvent.loaded,
              total: progressEvent.total || fileSize,
              speed,
              _startTime: startTime
            });
            lastReportTime = now;
          }
        }
      };

      let finalUrl = '';

      if (provider === 'gofile') {
        const serverRes = await axios.get('https://api.gofile.io/servers', { signal: abortController.signal, timeout: 15000 });
        const server = serverRes.data.data.servers[0].name;
        const form = new FormData();
        form.append('file', fs.createReadStream(tempFilePath), { filename });
        uploadConfig.headers = form.getHeaders();
        const uploadRes = await axios.post(`https://${server}.gofile.io/contents/uploadfile`, form, uploadConfig);
        if (uploadRes.data && uploadRes.data.data && uploadRes.data.data.downloadPage) {
          finalUrl = uploadRes.data.data.downloadPage;
        } else {
          throw new Error('Gofile: unexpected response');
        }
      } else if (provider === 'catbox') {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', fs.createReadStream(tempFilePath), { filename });
        uploadConfig.headers = form.getHeaders();
        const uploadRes = await axios.post('https://catbox.moe/user/api.php', form, uploadConfig);
        const resText = String(uploadRes.data || '').trim();
        if (resText.startsWith('http')) finalUrl = resText;
        else throw new Error('Catbox: ' + resText);
      } else if (provider === 'litterbox') {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('time', '24h');
        form.append('fileToUpload', fs.createReadStream(tempFilePath), { filename });
        uploadConfig.headers = form.getHeaders();
        const uploadRes = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, uploadConfig);
        const resText = String(uploadRes.data || '').trim();
        if (resText.startsWith('http')) finalUrl = resText;
        else throw new Error('Litterbox: ' + resText);
      } else if (provider === '0x0') {
        const form = new FormData();
        form.append('file', fs.createReadStream(tempFilePath), { filename });
        uploadConfig.headers = form.getHeaders();
        const uploadRes = await axios.post('https://0x0.st', form, uploadConfig);
        const resText = String(uploadRes.data || '').trim();
        if (resText.startsWith('http')) finalUrl = resText;
        else throw new Error('0x0.st: ' + resText);
      } else if (provider === 'fileio') {
        const form = new FormData();
        form.append('file', fs.createReadStream(tempFilePath), { filename });
        uploadConfig.headers = form.getHeaders();
        const uploadRes = await axios.post('https://file.io', form, uploadConfig);
        const data = uploadRes.data;
        finalUrl = data && (data.link || (data.success && data.link));
        if (!finalUrl) throw new Error('File.io error');
      } else if (provider === 'transfersh') {
        const fileStream = fs.createReadStream(tempFilePath);
        const encodedFilename = encodeURIComponent(filename);
        uploadConfig.headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': fileSize };
        const uploadRes = await axios.put(`https://transfer.sh/${encodedFilename}`, fileStream, uploadConfig);
        const resText = String(uploadRes.data || '').trim();
        if (resText.startsWith('http')) finalUrl = resText;
        else throw new Error('transfer.sh: ' + resText);
      } else {
        throw new Error('Unknown provider: ' + provider);
      }

      try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch(e) {}
      if (!finalUrl || !finalUrl.startsWith('http')) throw new Error('Invalid final URL');

      console.log(`Upload done: ${provider} -> ${finalUrl}`);
      activeUploads.set(uploadId, { status: 'done', url: finalUrl });
      abortControllers.delete(uploadId);
    } catch (error) {
      try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch(e) {}
      const msg = error.message === 'canceled' ? 'Cancelled by user' : (error.message || 'Upload failed');
      activeUploads.set(uploadId, { status: 'error', message: msg });
      abortControllers.delete(uploadId);
    }
  })();
});

// NEW: yt-dlp download endpoint for Do It app
app.post('/start-yt-download', async (req, res) => {
  const { url, format = 'video' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const downloadId = uuidv4();
  activeUploads.set(downloadId, { 
    status: 'Starting yt-dlp', 
    loaded: 0, 
    total: 100, 
    speed: 0, 
    _startTime: Date.now(),
    type: 'yt-dlp',
    url: url 
  });

  res.json({ downloadId });

  (async () => {
    const basePath = path.join(os.tmpdir(), `yt_${downloadId}`);
    try {
      // Check if yt-dlp exists
      await new Promise((resolve, reject) => {
        exec('which yt-dlp || echo "not found"', (err, stdout) => {
          if (stdout.includes('not found')) {
            reject(new Error('yt-dlp not found on server. Run build to install it.'));
          } else resolve();
        });
      });

      let args = [
        '-o', `${basePath}.%(ext)s`,
        '--no-playlist',
        '--no-mtime',
        '--newline',
        '--progress'
      ];

      if (format === 'audio') {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
      } else {
        args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
      }
      args.push(url);

      activeUploads.set(downloadId, { 
        status: 'Downloading with yt-dlp', 
        loaded: 0, 
        total: 100, 
        speed: 0, 
        _startTime: Date.now(),
        type: 'yt-dlp' 
      });

      const ytProcess = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let lastPercent = 0;
      let outputBuffer = '';

      ytProcess.stdout.on('data', (data) => {
        outputBuffer += data.toString();
        // Parse progress
        const percentMatch = outputBuffer.match(/(\d+\.?\d*)%/);
        if (percentMatch) {
          const percent = Math.min(100, parseFloat(percentMatch[1]));
          if (percent > lastPercent) {
            lastPercent = percent;
            activeUploads.set(downloadId, { 
              status: 'Downloading', 
              loaded: percent, 
              total: 100, 
              speed: 0,
              _startTime: Date.now(),
              type: 'yt-dlp' 
            });
          }
        }
        // Keep last 500 chars
        if (outputBuffer.length > 500) outputBuffer = outputBuffer.slice(-500);
      });

      ytProcess.stderr.on('data', (data) => {
        console.error('yt-dlp:', data.toString().trim());
      });

      await new Promise((resolve, reject) => {
        ytProcess.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`yt-dlp failed with code ${code}`));
        });
        ytProcess.on('error', (err) => reject(err));
      });

      // Find the downloaded file
      const files = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`yt_${downloadId}`));
      if (files.length === 0) throw new Error('Download file not found after yt-dlp');

      const actualFile = path.join(os.tmpdir(), files[0]);
      const fileSize = fs.statSync(actualFile).size;
      const fileName = files[0];

      // Optional: Get title using yt-dlp
      let title = 'Downloaded Media';
      try {
        const titleProc = spawn('yt-dlp', ['--print', 'title', '--no-download', url]);
        let titleOut = '';
        titleProc.stdout.on('data', d => titleOut += d);
        await new Promise(r => titleProc.on('close', r));
        if (titleOut.trim()) title = titleOut.trim().slice(0, 80);
      } catch (e) {}

      activeUploads.set(downloadId, { 
        status: 'done', 
        fileName,
        fileSize,
        downloadUrl: `/download-yt/${downloadId}`,
        title,
        type: 'yt-dlp'
      });
      console.log(`yt-dlp done: ${fileName} (${fileSize} bytes)`);
    } catch (error) {
      const msg = error.message || 'yt-dlp download failed';
      activeUploads.set(downloadId, { status: 'error', message: msg, type: 'yt-dlp' });
      console.error('yt-dlp error:', msg);
    }
  })();
});

// Serve downloaded yt-dlp files
app.get('/download-yt/:id', (req, res) => {
  const { id } = req.params;
  const files = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`yt_${id}`));
  if (files.length === 0) {
    return res.status(404).send('File not found or expired');
  }
  const filePath = path.join(os.tmpdir(), files[0]);
  // Try to get nice name from status if possible, else use file
  const niceName = files[0].replace(/^yt_[^.]+\./, 'download.');
  res.download(filePath, niceName);
});

// Health check for yt-dlp
app.get('/yt-health', (req, res) => {
  exec('yt-dlp --version', (err, stdout) => {
    if (err) {
      return res.json({ available: false, error: 'yt-dlp not installed' });
    }
    res.json({ available: true, version: stdout.trim() });
  });
});

app.get('/server-stats', (req, res) => {
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  const cpuModel = cpus[0] ? cpus[0].model : 'Unknown';

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
      cpu: { model: cpuModel, cores: cpuCount, usage: parseFloat(cpuUsage), loadAvg: loadAvg.map(l => parseFloat(l.toFixed(2))) },
      memory: { total: totalMem, used: usedMem, free: freeMem },
      disk: { total: diskTotal, used: diskUsed },
      system: { platform: os.platform(), arch: os.arch(), nodeVersion: process.version, uptime: uptimeSec, processUptime },
      activeUploads: activeUploads.size
    });
  });
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Do It Backend - yt-dlp Downloader + Uploader', 
    activeUploads: activeUploads.size, 
    uptime: process.uptime(),
    features: ['direct-upload', 'yt-dlp-video-audio']
  });
});

app.get('/ping', (req, res) => {
  res.json({ pong: true, time: Date.now(), app: 'Do It' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Do It Server running on port ${PORT}`));
