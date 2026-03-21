const fs = require('fs');
const path = require('path');
const CODES_DIR = path.join(__dirname, 'codes');
if (!fs.existsSync(CODES_DIR)) {
    console.log(`[CodesSystem] Creating codes directory: ${CODES_DIR}`);
    fs.mkdirSync(CODES_DIR, { recursive: true });
}
function cleanupOldCodes(pool) {
    console.log('[CodesSystem] Running cleanup for old codes...');
    const now = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

    fs.readdir(CODES_DIR, async (err, files) => {
        if (err) {
            console.error('[CodesSystem] Failed to read codes directory for cleanup:', err);
            return;
        }

        for (const file of files) {
            if (!file.endsWith('.json')) continue;

            const filePath = path.join(CODES_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

                // Guests (Website) = 5 days, Accounts (Launcher) = 7 days
                const expiry = data.owner_uuid ? SEVEN_DAYS_MS : FIVE_DAYS_MS;

                if (now - stats.mtimeMs > expiry) {
                    fs.unlinkSync(filePath);
                    if (pool) {
                        try {
                            await pool.query('DELETE FROM modpack_codes WHERE code = ?', [file.replace('.json', '')]);
                        } catch (dbErr) {
                            console.error(`[CodesSystem] DB cleanup error for ${file}:`, dbErr);
                        }
                    }
                    console.log(`[CodesSystem] Deleted expired code: ${file}`);
                }
            } catch (e) {
                console.error(`[CodesSystem] Cleanup error for ${file}:`, e);
            }
        }
    });
}

function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 8; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (fs.existsSync(path.join(CODES_DIR, `${code}.json`)));
    return code;
}

module.exports = function (app, ADMIN_PASSWORD, pool) {
    console.log('[CodesSystem] Initializing routes...');

    setInterval(() => cleanupOldCodes(pool), 60 * 60 * 1000);
    cleanupOldCodes(pool);

    async function handleSave(req, res) {
        try {
            const { name, mods, resourcePacks, shaders, instanceVersion, instanceLoader, keybinds, ownerUuid } = req.body;
            let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            if (ip) {
                // x-forwarded-for can contain multiple comma-separated IPs. We only want the first one (the original client).
                ip = ip.split(',')[0].trim();
            }

            // Check Rate Limiting
            if (pool) {
                if (ownerUuid) {
                    // Launcher: Max 10
                    const [rows] = await pool.query('SELECT COUNT(*) as count FROM modpack_codes WHERE owner_uuid = ?', [ownerUuid]);
                    if (rows[0].count >= 10) {
                        return res.status(429).json({ success: false, error: 'Maximum limit reached (10 codes per account). Delete old codes to create new ones.' });
                    }
                } else {
                    // Website Guest: Max 5
                    const [rows] = await pool.query('SELECT COUNT(*) as count FROM modpack_codes WHERE owner_ip = ?', [ip]);
                    if (rows[0].count >= 5) {
                        return res.status(429).json({ success: false, error: 'Maximum limit reached (5 codes per IP). Codes expire after 5 days.' });
                    }
                }
            }

            const code = generateCode();
            const expiryDays = ownerUuid ? 7 : 5;

            const data = {
                code,
                name: name || 'Exported Modpack',
                version: instanceVersion,
                loader: instanceLoader,
                mods: mods || [],
                resourcePacks: resourcePacks || [],
                shaders: shaders || [],
                keybinds: keybinds || null,
                created: Date.now(),
                expires: Date.now() + (expiryDays * 24 * 60 * 60 * 1000),
                uses: 0,
                owner_uuid: ownerUuid || null,
                owner_ip: ip
            };

            const filePath = path.join(CODES_DIR, `${code}.json`);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

            if (pool) {
                await pool.query('INSERT INTO modpack_codes (code, owner_uuid, owner_ip) VALUES (?, ?, ?)', [code, ownerUuid || null, ip]);
            }

            console.log(`[CodesSystem] Saved modpack ${code} (${name}) for ${ownerUuid || ip}`);
            res.json({ success: true, code });
        } catch (error) {
            console.error('[CodesSystem] Save error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    app.post('/api/codes/save', handleSave);
    app.post('/api/modpack/save', handleSave);

    app.get('/api/modpack/my-codes', async (req, res) => {
        try {
            const { uuid } = req.query;
            let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            if (ip) {
                ip = ip.split(',')[0].trim();
            }

            console.log(`[CodesSystem-Debug] ðŸ” my-codes called. Query UUID: '${uuid}', Extracted IP: '${ip}'`);

            let rows = [];
            if (uuid && uuid !== 'undefined' && uuid !== 'null') {
                console.log(`[CodesSystem-Debug] ðŸ” Searching database via UUID: ${uuid}`);
                [rows] = await pool.query('SELECT code FROM modpack_codes WHERE owner_uuid = ?', [uuid]);
            } else {
                console.log(`[CodesSystem-Debug] ðŸ” Searching database via IP: ${ip}`);
                [rows] = await pool.query('SELECT code FROM modpack_codes WHERE owner_ip = ?', [ip]);
            }

            console.log(`[CodesSystem-Debug] ðŸ” Database returned ${rows.length} rows:`, rows);

            const codes = [];

            for (const row of rows) {
                const filePath = path.join(CODES_DIR, `${row.code}.json`);
                const exists = fs.existsSync(filePath);
                console.log(`[CodesSystem-Debug] ðŸ” Checking file for code ${row.code} at ${filePath}. Exists on disk? ${exists}`);

                if (exists) {
                    try {
                        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        codes.push({
                            code: content.code,
                            name: content.name,
                            created: content.created,
                            expires: content.expires,
                            uses: content.uses || 0
                        });
                    } catch (e) {
                        console.error(`[CodesSystem-Debug] âŒ JSON Parse Error for code ${row.code}:`, e.message);
                    }
                }
            }

            console.log(`[CodesSystem-Debug] âœ… Returning ${codes.length} valid codes to frontend.`);
            res.json({ success: true, codes });
        } catch (error) {
            console.error('[CodesSystem] List user codes error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/modpack/delete/:code', async (req, res) => {
        try {
            const { code } = req.params;
            const { uuid } = req.query;

            const filePath = path.join(CODES_DIR, `${code}.json`);
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ success: false, error: 'Code not found' });
            }

            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            if (ip) {
                ip = ip.split(',')[0].trim();
            }

            // Deletion for account owners OR IP owners (website)
            const isOwner = (data.owner_uuid && data.owner_uuid === uuid) || (data.owner_ip && data.owner_ip === ip);
            const isAdmin = req.isAuthenticated() && req.user.role === 'admin';

            if (isOwner || isAdmin) {
                fs.unlinkSync(filePath);
                if (pool) {
                    await pool.query('DELETE FROM modpack_codes WHERE code = ?', [code]);
                }
                console.log(`[CodesSystem] Deleted code ${code} by ${isOwner ? 'owner' : 'admin'}`);
                return res.json({ success: true });
            }

            res.status(403).json({ success: false, error: 'Forbidden: You do not own this code' });
        } catch (error) {
            console.error('[CodesSystem] Delete error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/codes/list', (req, res) => {
        try {
            const clientPass = req.query.password;
            if (clientPass !== ADMIN_PASSWORD) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }
            if (!fs.existsSync(CODES_DIR)) {
                return res.json({ success: true, codes: [] });
            }
            const files = fs.readdirSync(CODES_DIR).filter(f => f.endsWith('.json'));
            const codes = files.map(file => {
                try {
                    const content = JSON.parse(fs.readFileSync(path.join(CODES_DIR, file), 'utf8'));
                    return {
                        code: content.code || file.replace('.json', ''),
                        name: content.name,
                        version: content.version,
                        loader: content.loader,
                        uses: content.uses || 0,
                        created: content.created,
                        expires: content.expires,
                        owner_uuid: content.owner_uuid,
                        owner_ip: content.owner_ip
                    };
                } catch (e) {
                    return null;
                }
            }).filter(Boolean);

            res.json({ success: true, codes });
        } catch (error) {
            console.error('[CodesSystem] List error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    function handleGetCode(req, res) {
        try {
            const { code } = req.params;
            const filePath = path.join(CODES_DIR, `${code}.json`);

            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                data.uses = (data.uses || 0) + 1;
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

                res.json({ success: true, data });
            } else {
                res.status(404).json({ success: false, error: 'Code not found' });
            }
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
    app.get('/api/codes/:code', handleGetCode);
    app.get('/api/modpack/:code', handleGetCode);

    app.delete('/api/codes/:code', (req, res) => {
        try {
            const clientPass = req.query.password;
            if (clientPass !== ADMIN_PASSWORD) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }
            const { code } = req.params;
            const filePath = path.join(CODES_DIR, `${code}.json`);

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                if (pool) {
                    pool.query('DELETE FROM modpack_codes WHERE code = ?', [code]).catch(e => console.error(e));
                }
                res.json({ success: true });
            } else {
                res.status(404).json({ success: false, error: 'Code not found' });
            }
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
};
