const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

app.post('/upload', async (req, res) => {
    const { url, provider } = req.body;
    if (!url || !provider) {
        return res.status(400).json({ error: 'Missing url or provider' });
    }

    const tempFilePath = path.join(__dirname, uuidv4());

    try {
        console.log(`Downloading from ${url}...`);
        const writer = fs.createWriteStream(tempFilePath);
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        let finalUrl = '';
        console.log(`Uploading to ${provider}...`);

        const form = new FormData();
        form.append('fileToUpload', fs.createReadStream(tempFilePath));

        if (provider === 'catbox') {
            form.append('reqtype', 'fileupload');
            const uploadRes = await axios.post('https://catbox.moe/user/api.php', form, {
                headers: form.getHeaders()
            });
            finalUrl = uploadRes.data;
        } else if (provider === 'litterbox') {
            form.append('reqtype', 'fileupload');
            form.append('time', '24h');
            const uploadRes = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
                headers: form.getHeaders()
            });
            finalUrl = uploadRes.data;
        } else if (provider === 'gofile') {
            const serverRes = await axios.get('https://api.gofile.io/servers');
            const server = serverRes.data.data.servers[0].name;
            const gofileForm = new FormData();
            gofileForm.append('file', fs.createReadStream(tempFilePath));
            const uploadRes = await axios.post(`https://${server}.gofile.io/contents/uploadfile`, gofileForm, {
                headers: gofileForm.getHeaders()
            });
            finalUrl = uploadRes.data.data.downloadPage;
        } else {
            throw new Error('Invalid provider selected');
        }

        fs.unlinkSync(tempFilePath);
        console.log(`Success: ${finalUrl}`);
        res.json({ success: true, url: finalUrl });

    } catch (error) {
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
        }
        console.error(error);
        res.status(500).json({ error: error.message || 'Upload failed' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
