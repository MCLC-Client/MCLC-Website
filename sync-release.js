const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const REPO = 'Fernsehheft/MCLC-Client';
const DOWNLOAD_DIR = path.join(__dirname, 'download');
const VERSION_FILE = path.join(__dirname, 'version.json');
const EXE_NAME = 'MCLC-Setup.exe';

async function syncRelease() {
    try {
        console.log(`[Sync] Checking for latest release in ${REPO}...`);
        const response = await axios.get(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: { 'User-Agent': 'MCLC-Sync-Agent' }
        });

        const release = response.data;
        const version = release.tag_name;
        console.log(`[Sync] Found version: ${version}`);
        const asset = release.assets.find(a => a.name.endsWith('.exe'));
        if (!asset) {
            throw new Error('No .exe asset found in the latest release.');
        }

        const downloadUrl = asset.browser_download_url;
        console.log(`[Sync] Downloading ${asset.name} from ${downloadUrl}...`);
        await fs.ensureDir(DOWNLOAD_DIR);
        const targetPath = path.join(DOWNLOAD_DIR, EXE_NAME);
        const downloadResponse = await axios({
            url: downloadUrl,
            method: 'GET',
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(targetPath);
        downloadResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log(`[Sync] Successfully downloaded to ${targetPath}`);
        const versionData = {
            version: version,
            lastSynced: new Date().toISOString(),
            downloadUrl: `https://mclc.pluginhub.de/download/${EXE_NAME}`
        };

        await fs.writeJson(VERSION_FILE, versionData, { spaces: 4 });
        console.log(`[Sync] Updated version.json`);

        console.log('[Sync] All done!');
    } catch (error) {
        console.error('[Sync] Error:', error.message);
        process.exit(1);
    }
}

syncRelease();