/**
 * Local Development Server — no PostgreSQL, no Google OAuth needed.
 *
 * Features:
 *  - In-memory sessions (resets on restart)
 *  - JSON-file persistence in ./dev-data/
 *  - Dev login UI at http://localhost:3001/auth/dev-login
 *  - Admin panel fully functional (password: "admin")
 *  - Extensions marketplace with file uploads
 *  - Full Socket.IO analytics
 *
 * Start with: npm run dev:full
 */

const express   = require('express');
const session   = require('express-session');
const bodyParser = require('body-parser');
const multer    = require('multer');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const http      = require('http');
const { Server } = require('socket.io');

// ─── Config ────────────────────────────────────────────────────────────────

const PORT            = process.env.DEV_PORT || 3001;
const DEV_PASSWORD    = process.env.DEV_ADMIN_PASSWORD || 'admin';
const DATA_DIR        = path.join(__dirname, 'dev-data');
const UPLOAD_DIR      = path.join(DATA_DIR, 'uploads');

// Ensure data directories exist
[DATA_DIR, UPLOAD_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const ts = () => new Date().toISOString().replace('T',' ').replace(/\..+/,'');
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ─── App setup ─────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: ['http://localhost:5173','http://localhost:3001'], methods: ['GET','POST'] },
    transports: ['websocket','polling'],
});

app.use(cors({ origin: ['http://localhost:5173','http://localhost:3001'], credentials: true }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'lux-dev-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ─── JSON file helpers ──────────────────────────────────────────────────────

function readJson(file, fallback = []) {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return fallback;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// Seed news if empty
if (!fs.existsSync(path.join(DATA_DIR, 'news.json'))) {
    writeJson('news.json', [
        { id: 1, title: 'Lux Client 1.3.3 released', description: 'Bug fixes and performance improvements.', link: 'https://github.com/Lux-Client/Lux-Client/releases', image: '', date: new Date().toLocaleDateString() },
    ]);
}
// Seed dev users
if (!fs.existsSync(path.join(DATA_DIR, 'users.json'))) {
    writeJson('users.json', [
        { id: 1, username: 'DevAdmin', email: 'admin@localhost', role: 'admin', avatar: null, banned: false, created_at: new Date().toISOString() },
        { id: 2, username: 'TestUser', email: 'user@localhost',  role: 'user',  avatar: null, banned: false, created_at: new Date().toISOString() },
    ]);
}
// Seed extensions
if (!fs.existsSync(path.join(DATA_DIR, 'extensions.json'))) {
    writeJson('extensions.json', [
        { id: 1, name: 'Example Extension', identifier: 'example.extension', summary: 'A sample extension', description: 'This is a dev placeholder.', type: 'extension', status: 'approved', developer: 'DevAdmin', downloads: 42, banner_path: null, file_path: null, created_at: new Date().toISOString() },
        { id: 2, name: 'Dark Theme Pro', identifier: 'theme.dark-pro', summary: 'Premium dark theme', description: 'Dark theme for Lux Client.', type: 'theme', status: 'pending', developer: 'TestUser', downloads: 0, banner_path: null, file_path: null, created_at: new Date().toISOString() },
    ]);
}

// ─── Maintenance state ──────────────────────────────────────────────────────

let isMaintenanceMode = false;

// ─── Analytics state ────────────────────────────────────────────────────────

const activeSessions = new Map();
let stats = readJson('analytics.json', {
    downloads: { mod: {}, resourcepack: {}, shader: {}, modpack: {} },
    launchesPerDay: {},
    clientVersions: { '1.3.3': 12, '1.3.2': 5 },
    uniqueMachineCount: 17,
    uniqueMachines: {},
    software: { client: { Fabric: 8, Forge: 4, Vanilla: 3 }, server: { Paper: 2 } },
    gameVersions: { client: { '1.21.1': 7, '1.20.4': 4, '1.19.4': 2 }, server: {} },
});

function getLiveStats() {
    let activeUsers = 0, playingUsers = 0;
    const versions = {}, playingInstances = {};
    const activeMachineKeys = new Set(), playingMachineKeys = new Set();

    activeSessions.forEach((s, socketId) => {
        const key = String(s?.machineId || '').trim() || `socket:${socketId}`;
        if (s.version && s.version !== 'unknown') {
            if (!activeMachineKeys.has(key)) { activeMachineKeys.add(key); activeUsers++; }
            if (s.isPlaying) {
                if (!playingMachineKeys.has(key)) { playingMachineKeys.add(key); playingUsers++; }
                if (s.instance) playingInstances[s.instance] = (playingInstances[s.instance] || 0) + 1;
            }
            versions[s.version] = (versions[s.version] || 0) + 1;
        }
    });
    return { activeUsers, playingUsers, versions, playingInstances };
}
function emitLiveStats() {
    io.to('admin').emit('live-update', { live: getLiveStats(), persistent: stats });
}
function saveAnalytics() {
    writeJson('analytics.json', stats);
}
setInterval(saveAnalytics, 30_000);

// ─── Static / upload serving ────────────────────────────────────────────────

app.use('/resources', express.static(path.join(__dirname, 'resources')));
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename:    (_, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ─── Dev Auth ───────────────────────────────────────────────────────────────

// Show a simple login-chooser page (replaces Google OAuth)
app.get('/auth/google', (req, res) => {
    const returnTo = req.query.returnTo || '/';
    res.send(`<!doctype html>
<html>
<head>
  <title>Dev Login — Lux Client</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #080808; color: #e8e8e8; font-family: system-ui, sans-serif;
           display: flex; min-height: 100vh; align-items: center; justify-content: center; }
    .card { background: #111; border: 1px solid rgba(255,255,255,.08); border-radius: 20px;
            padding: 40px; width: 360px; text-align: center; }
    .logo { width: 52px; height: 52px; margin: 0 auto 20px; }
    h1  { font-size: 22px; font-weight: 800; margin-bottom: 6px; }
    p   { color: #666; font-size: 13px; margin-bottom: 32px; }
    .badge { display: inline-block; background: rgba(226,118,2,.12); color: #e27602;
             border: 1px solid rgba(226,118,2,.25); border-radius: 99px; padding: 4px 12px;
             font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 24px; }
    a   { display: block; padding: 14px; border-radius: 12px; font-size: 14px; font-weight: 700;
          text-decoration: none; margin-bottom: 10px; transition: opacity .15s; }
    a:hover { opacity: .85; }
    .admin { background: #e27602; color: #000; }
    .user  { background: rgba(255,255,255,.06); color: #e8e8e8; border: 1px solid rgba(255,255,255,.1); }
    small  { color: #444; font-size: 11px; margin-top: 20px; display: block; }
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="/resources/lux_icon.png?v=3" alt="Lux Client" />
    <div class="badge">🛠 Dev Mode</div>
    <h1>Choose Dev Account</h1>
    <p>Google OAuth is not active in dev mode.<br>Pick a role to log in instantly.</p>
    <a class="admin" href="/auth/dev-login?role=admin&returnTo=${encodeURIComponent(returnTo)}">Login as Admin</a>
    <a class="user"  href="/auth/dev-login?role=user&returnTo=${encodeURIComponent(returnTo)}">Login as Regular User</a>
    <small>Passwords, sessions and data are stored only locally in dev-data/</small>
  </div>
</body>
</html>`);
});

app.get('/auth/dev-login', (req, res) => {
    const { role = 'user', returnTo = '/' } = req.query;
    const users = readJson('users.json', []);
    const user  = role === 'admin'
        ? users.find(u => u.role === 'admin') || users[0]
        : users.find(u => u.role !== 'admin') || users[0];
    req.session.user = user;
    log(`[Auth] Dev login as ${user?.username} (${user?.role})`);
    res.redirect(decodeURIComponent(returnTo));
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {});
    const returnTo = req.query.returnTo || '/';
    res.redirect(decodeURIComponent(returnTo));
});

// ─── User API ───────────────────────────────────────────────────────────────

app.get('/api/user', (req, res) => {
    if (req.session.user) return res.json({ loggedIn: true, user: req.session.user });
    res.json({ loggedIn: false });
});

// ─── User dashboard APIs ──────────────────────────────────────────────────────

app.get('/api/user/extensions', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const all = readJson('extensions.json', []);
    res.json(all.filter(e => e.user_id === req.session.user.id));
});

app.get('/api/user/notifications', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const all = readJson('notifications.json', []);
    res.json(all.filter(n => n.user_id === req.session.user.id));
});

app.post('/api/notifications/read/:id', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const all = readJson('notifications.json', []);
    const idx = all.findIndex(n => String(n.id) === req.params.id && n.user_id === req.session.user.id);
    if (idx >= 0) { all[idx].is_read = true; writeJson('notifications.json', all); }
    res.json({ success: true });
});

app.post('/api/notifications/read-all', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const all = readJson('notifications.json', []);
    const updated = all.map(n => n.user_id === req.session.user.id ? { ...n, is_read: true } : n);
    writeJson('notifications.json', updated);
    res.json({ success: true });
});

// Seed a sample notification for the dev admin user
(function seedNotifications() {
    const p = require('path').join(DATA_DIR, 'notifications.json');
    if (!require('fs').existsSync(p)) {
        writeJson('notifications.json', [
            { id: 1, user_id: 1, type: 'approval', message: 'Your extension "Example Extension" has been approved and is now live in the marketplace.', is_read: false, created_at: new Date().toISOString() },
            { id: 2, user_id: 1, type: 'info',     message: 'Welcome to Lux Client marketplace! Upload your first extension via the Profile page.', is_read: true, created_at: new Date().toISOString() },
        ]);
    }
})();

// ─── Admin password login (for AdminPanel passwordVerified flow) ─────────────

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === DEV_PASSWORD) {
        req.session.adminVerified = true;
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, error: `Wrong password. Dev password is: "${DEV_PASSWORD}"` });
});

// ─── News API ────────────────────────────────────────────────────────────────

app.get('/api/news', (_, res) => res.json(readJson('news.json', [])));
app.post('/api/news', (req, res) => {
    const { news } = req.body;
    writeJson('news.json', news || []);
    res.json({ success: true });
});

// ─── Maintenance ─────────────────────────────────────────────────────────────

app.get('/api/admin/maintenance/status', (_, res) => res.json({ isMaintenanceMode }));

app.post('/api/admin/maintenance/toggle', (req, res) => {
    const { password } = req.body;
    const isAdmin = req.session?.user?.role === 'admin' || req.session?.adminVerified || password === DEV_PASSWORD;
    if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
    isMaintenanceMode = !isMaintenanceMode;
    log(`[Maintenance] Mode is now ${isMaintenanceMode ? 'ON' : 'OFF'}`);
    res.json({ success: true, isMaintenanceMode });
});

app.post('/api/admin/maintenance/auth', (req, res) => {
    if (req.body.password === DEV_PASSWORD) {
        req.session.adminBypass = true;
        return res.json({ success: true });
    }
    res.status(401).json({ error: 'Invalid password' });
});

// ─── Codes API ───────────────────────────────────────────────────────────────

app.get('/api/codes/list', (req, res) => {
    const codes = readJson('codes.json', []);
    res.json({ success: true, codes });
});

app.post('/api/codes/generate', (req, res) => {
    const codes = readJson('codes.json', []);
    const newCode = {
        id: Date.now(),
        code: Math.random().toString(36).slice(2, 10).toUpperCase(),
        type: req.body.type || 'beta',
        used: false,
        created_at: new Date().toISOString(),
    };
    codes.push(newCode);
    writeJson('codes.json', codes);
    res.json({ success: true, code: newCode });
});

// ─── Extensions API ──────────────────────────────────────────────────────────

app.get('/api/extensions', (req, res) => {
    const { search } = req.query;
    let exts = readJson('extensions.json', [])
        .filter(e => e.status === 'approved' && (!e.visibility || e.visibility === 'public'));
    if (search) {
        const q = search.toLowerCase();
        exts = exts.filter(e => e.name.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q));
    }
    res.json(exts);
});

app.get('/api/extensions/:id', (req, res) => {
    const exts = readJson('extensions.json', []);
    const ext = exts.find(e => String(e.id) === req.params.id);
    if (!ext) return res.status(404).json({ error: 'Not found' });
    res.json(ext);
});

app.post('/api/extensions/upload', upload.fields([
    { name: 'extensionFile', maxCount: 1 },
    { name: 'bannerImage', maxCount: 1 },
]), (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const exts = readJson('extensions.json', []);
    const newId = Math.max(0, ...exts.map(e => e.id)) + 1;
    const ext = {
        id: newId,
        user_id: req.session.user.id,
        developer: req.session.user.username,
        name: req.body.name || 'Unnamed',
        identifier: req.body.identifier || `ext.${newId}`,
        summary: req.body.summary || '',
        description: req.body.description || '',
        type: req.body.type || 'extension',
        visibility: req.body.visibility || 'public',
        status: 'pending',
        downloads: 0,
        banner_path: req.files?.bannerImage?.[0]?.filename || null,
        file_path:   req.files?.extensionFile?.[0]?.filename || null,
        created_at: new Date().toISOString(),
    };
    exts.push(ext);
    writeJson('extensions.json', exts);
    log(`[Extensions] Uploaded: ${ext.name} (${ext.identifier})`);
    res.json({ success: true, extensionId: newId });
});

app.post('/api/extensions/:id/download', (req, res) => {
    const exts = readJson('extensions.json', []);
    const idx  = exts.findIndex(e => String(e.id) === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    exts[idx].downloads = (exts[idx].downloads || 0) + 1;
    writeJson('extensions.json', exts);
    res.json({ success: true });
});

// ─── Admin moderation ─────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
    if (req.session?.user?.role === 'admin') return next();
    res.status(403).json({ error: 'Forbidden — log in as admin' });
}

app.get('/api/admin/users', requireAdmin, (req, res) => {
    res.json(readJson('users.json', []));
});

app.get('/api/admin/extensions/pending', requireAdmin, (req, res) => {
    res.json(readJson('extensions.json', []).filter(e => e.status === 'pending'));
});

app.get('/api/admin/versions/pending', requireAdmin, (_, res) => res.json([]));
app.get('/api/admin/drafts/pending',   requireAdmin, (_, res) => res.json([]));

app.post('/api/admin/extensions/:id/approve', requireAdmin, (req, res) => {
    const exts = readJson('extensions.json', []);
    const ext  = exts.find(e => String(e.id) === req.params.id);
    if (!ext) return res.status(404).json({ error: 'Not found' });
    ext.status = 'approved';
    writeJson('extensions.json', exts);
    res.json({ success: true });
});

app.post('/api/admin/extensions/:id/reject', requireAdmin, (req, res) => {
    const exts = readJson('extensions.json', []);
    const ext  = exts.find(e => String(e.id) === req.params.id);
    if (!ext) return res.status(404).json({ error: 'Not found' });
    ext.status = 'rejected';
    ext.reject_reason = req.body.reason || '';
    writeJson('extensions.json', exts);
    res.json({ success: true });
});

app.post('/api/admin/users/:id/ban', requireAdmin, (req, res) => {
    const users = readJson('users.json', []);
    const user  = users.find(u => String(u.id) === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.banned = true;
    user.ban_reason = req.body.reason || 'No reason given';
    writeJson('users.json', users);
    res.json({ success: true });
});

app.post('/api/admin/users/:id/unban', requireAdmin, (req, res) => {
    const users = readJson('users.json', []);
    const user  = users.find(u => String(u.id) === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.banned = false;
    user.ban_reason = null;
    writeJson('users.json', users);
    res.json({ success: true });
});

// News image upload
app.post('/api/admin/news/upload-image', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ success: true, url: `/uploads/${req.file.filename}` });
});

// ─── User profile API ─────────────────────────────────────────────────────────

app.get('/api/profile', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const users = readJson('users.json', []);
    const user  = users.find(u => u.id === req.session.user.id);
    const exts  = readJson('extensions.json', []).filter(e => e.user_id === req.session.user.id);
    res.json({ user: user || req.session.user, extensions: exts });
});

app.post('/api/profile/update', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const users = readJson('users.json', []);
    const idx   = users.findIndex(u => u.id === req.session.user.id);
    if (idx < 0) return res.status(404).json({ error: 'User not found' });
    const allowed = ['username', 'bio', 'is_private'];
    allowed.forEach(k => { if (req.body[k] !== undefined) users[idx][k] = req.body[k]; });
    writeJson('users.json', users);
    req.session.user = users[idx];
    res.json({ success: true, user: users[idx] });
});

// ─── Analytics endpoint (dev) ─────────────────────────────────────────────────

app.post('/api/analytics', (_, res) => {
    res.json({ live: getLiveStats(), persistent: stats });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    activeSessions.set(socket.id, { version: 'unknown', os: 'unknown', isPlaying: false, instance: null, startTime: Date.now() });
    emitLiveStats();

    socket.on('register', (data) => {
        const machineId = String(data?.machineId || '').trim();
        if (machineId) {
            for (const [sid, s] of activeSessions.entries()) {
                if (sid !== socket.id && String(s?.machineId || '').trim() === machineId) activeSessions.delete(sid);
            }
        }
        const s = activeSessions.get(socket.id);
        if (s) {
            Object.assign(s, { version: data.version || 'unknown', os: data.os || 'unknown', username: data.username || 'Anonymous', uuid: data.uuid || null, machineId: machineId || null });
        }
        if (machineId && !stats.uniqueMachines[machineId]) {
            stats.uniqueMachines[machineId] = { firstSeenAt: Date.now(), version: data?.version || 'unknown', os: data?.os || 'unknown' };
            stats.uniqueMachineCount = Object.keys(stats.uniqueMachines).length;
        }
        if (data.version) stats.clientVersions[data.version] = (stats.clientVersions[data.version] || 0) + 1;
        emitLiveStats();
    });

    socket.on('update-status', (data) => {
        const s = activeSessions.get(socket.id);
        if (s) {
            if (data.isPlaying && !s.isPlaying) {
                const today = new Date().toISOString().split('T')[0];
                stats.launchesPerDay[today] = (stats.launchesPerDay[today] || 0) + 1;
                const mode = data.mode === 'server' ? 'server' : 'client';
                if (data.software) stats.software[mode][data.software] = (stats.software[mode][data.software] || 0) + 1;
                if (data.gameVersion) stats.gameVersions[mode][data.gameVersion] = (stats.gameVersions[mode][data.gameVersion] || 0) + 1;
            }
            s.isPlaying = data.isPlaying;
            s.instance  = data.instance || null;
        }
        emitLiveStats();
    });

    socket.on('track-download', (data) => {
        const type = data.type || 'mod';
        const key  = data.name || data.id || 'unknown';
        if (!stats.downloads[type]) stats.downloads[type] = {};
        if (key) {
            stats.downloads[type][key] = (stats.downloads[type][key] || 0) + 1;
            io.to('admin').emit('new-download', { ...data, username: activeSessions.get(socket.id)?.username });
        }
        emitLiveStats();
    });

    socket.on('track-creation', (data) => {
        const mode = data.mode === 'server' ? 'server' : 'client';
        if (data.software) stats.software[mode][data.software] = (stats.software[mode][data.software] || 0) + 1;
        if (data.version)  stats.gameVersions[mode][data.version] = (stats.gameVersions[mode][data.version] || 0) + 1;
        emitLiveStats();
    });

    // Admin subscribe — password OR admin session
    socket.on('admin-subscribe', (password) => {
        const sessionUser = socket.request?.session?.user;
        const isAdmin = sessionUser?.role === 'admin' || password === DEV_PASSWORD;
        if (isAdmin) {
            socket.join('admin');
            socket.emit('init-stats', { live: getLiveStats(), persistent: stats });
            log('[Admin] Admin socket connected');
        } else {
            socket.emit('error', `Invalid password. Dev password is "${DEV_PASSWORD}"`);
        }
    });

    socket.on('disconnect', () => { activeSessions.delete(socket.id); emitLiveStats(); });
});

// Share session with Socket.IO so admin-subscribe can check req.session
io.engine.use(session({
    secret: 'lux-dev-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
}));

// ─── Serve React build ─────────────────────────────────────────────────────────

const clientDist = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/socket.io')) return next();
        res.sendFile(path.join(clientDist, 'index.html'));
    });
} else {
    app.get('/', (_, res) => res.send(`
        <h2 style="font-family:system-ui;color:#e27602">Lux Dev Server running!</h2>
        <p>Run <code>npm run client:build</code> first, or open <a href="http://localhost:5173">http://localhost:5173</a> (Vite dev server).</p>
        <p><strong>API base:</strong> http://localhost:3001/api/...</p>
        <p><strong>Dev login:</strong> <a href="/auth/dev-login?role=admin&returnTo=/">Login as Admin</a></p>
    `));
}

// ─── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    log('─────────────────────────────────────────');
    log(`🚀 Lux Dev Server  →  http://localhost:${PORT}`);
    log(`🔑 Admin password  →  "${DEV_PASSWORD}"`);
    log(`🗂  Data dir        →  ${DATA_DIR}`);
    log(`👤 Dev login        →  http://localhost:${PORT}/auth/dev-login?role=admin&returnTo=/`);
    log('─────────────────────────────────────────');
    if (!fs.existsSync(clientDist)) {
        log('ℹ  No client/dist found. Open http://localhost:5173 (Vite) for the UI.');
    }
});
