require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(DATA_DIR, 'uploads');

const DATA_DIR_EXISTED = fs.existsSync(DATA_DIR);

if (!DATA_DIR_EXISTED) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Everything that survives a restart lives here: uploaded avatars and extension
// files, analytics, news and the cloud blob store. Without a mounted volume this
// is a directory inside the container image and every redeploy starts empty --
// which looks exactly like "the server deleted my data".
console.log(`[Storage] DATA_DIR   = ${DATA_DIR}${process.env.DATA_DIR ? '' : '  (default, DATA_DIR not set)'}`);
console.log(`[Storage] UPLOAD_DIR = ${UPLOAD_DIR}`);
if (!DATA_DIR_EXISTED) {
    console.warn('[Storage] WARNING: the data directory did not exist and was created empty.');
    console.warn('[Storage] If this appears after every deployment, DATA_DIR is not on a persistent volume');
    console.warn('[Storage] and uploads, avatars and analytics are lost on each redeploy.');
}

// Pointing DATA_DIR at a path is not the same as making that path persistent --
// without a volume mounted there it is just a folder inside the container image.
// The marker below is rewritten on every boot, so if it comes back on the next
// start the storage really did survive, and the log can say so instead of
// leaving it to guesswork.
const STORAGE_MARKER = path.join(DATA_DIR, '.storage-marker.json');
let storageMarker = null;
try {
    storageMarker = JSON.parse(fs.readFileSync(STORAGE_MARKER, 'utf8'));
} catch (e) { /* first boot ever, or the directory is not persistent */ }

let uploadCount = 0;
try { uploadCount = fs.readdirSync(UPLOAD_DIR).length; } catch (e) { /* unreadable, reported below */ }

if (storageMarker && storageMarker.firstBootAt) {
    console.log(`[Storage] Persistence OK - volume first seen ${storageMarker.firstBootAt}, this is boot #${(storageMarker.bootCount || 0) + 1}`);
} else {
    console.warn('[Storage] WARNING: no marker from an earlier boot was found in DATA_DIR.');
    console.warn('[Storage] This is either the very first start, or DATA_DIR is NOT on a persistent volume.');
    console.warn(`[Storage] If this repeats after every deployment, mount a volume at ${DATA_DIR}`);
    console.warn('[Storage] (Coolify: Storages -> Add -> Destination Path). Setting DATA_DIR alone does nothing.');
}
console.log(`[Storage] ${uploadCount} file(s) currently in UPLOAD_DIR`);

try {
    fs.writeFileSync(STORAGE_MARKER, JSON.stringify({
        firstBootAt: (storageMarker && storageMarker.firstBootAt) || new Date().toISOString(),
        lastBootAt: new Date().toISOString(),
        bootCount: ((storageMarker && storageMarker.bootCount) || 0) + 1,
        uploadDir: UPLOAD_DIR
    }, null, 2));
} catch (err) {
    console.error(`[Storage] ERROR: cannot write to ${DATA_DIR} (${err.message}).`);
    console.error('[Storage] Avatar and extension uploads will fail until this path is writable.');
}

// --- LOGGING TO latest.log ---
const logFile = path.join(DATA_DIR, 'latest.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const originalLog = console.log;
const originalError = console.error;

function getTimestamp() {
    return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
}

console.log = function (...args) {
    const message = `[${getTimestamp()}] [INFO] ${args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ')}\n`;
    logStream.write(message);
    originalLog.apply(console, args);
};

console.error = function (...args) {
    const message = `[${getTimestamp()}] [ERROR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ')}\n`;
    logStream.write(message);
    originalError.apply(console, args);
};

console.log('--- Server Starting / Restarting ---');
// -----------------------------
const multer = require('multer');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const passport = require('passport');
// dotenv already required at top

const pool = require('./database');
const emailService = require('./email');
const http = require('http');
const { Server } = require("socket.io");
const codesSystem = require('./codes_system');
require('./passport-setup'); // Ensure passport is configured

console.log('[Main] ========== GOOGLE OAUTH CONFIG ==========');
console.log('[Main] ID:', process.env.GOOGLE_CLIENT_ID ? 'Set' : 'MISSING');
console.log('[Main] Secret:', process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'MISSING');
console.log('[Main] Callback:', process.env.CALLBACK_URL);
console.log('[Main] NODE_ENV:', process.env.NODE_ENV);
console.log('[Main] =========================================');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:5173', 'http://localhost:3001', 'http://localhost:3000'];

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const createAdminAuth = require('./middleware/adminAuth');

if (!ADMIN_PASSWORD) {
    console.error('[CRITICAL] ADMIN_PASSWORD environment variable is NOT SET. Server will not start for security reasons.');
    process.exit(1);
}

const adminAuth = createAdminAuth(ADMIN_PASSWORD);

const NEWS_FILE = path.join(DATA_DIR, 'news.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const downloadCooldowns = new Map();

// Fixed marketplace taxonomies — single source of truth shared by upload/update validation,
// the extensions list filter, and GET /api/meta/filters (which the frontend dropdowns read).
const EXTENSION_CATEGORIES = ['utility', 'cosmetic', 'performance', 'ui', 'integration', 'other'];
const EXTENSION_VISIBILITIES = ['public', 'unlisted'];
const MC_VERSIONS = ['1.21.4', '1.21.1', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5'];

app.use(cors());
// 8mb covers a modpack export's mod list plus an embedded icon (base64-inflated, pre-validation);
// the icon itself is re-encoded and capped far smaller server-side before being persisted.
app.use(bodyParser.json({ limit: '8mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '8mb' }));

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && process.env.NODE_ENV === 'production') {
    console.error('[CRITICAL] SESSION_SECRET environment variable is NOT SET in production. Server will not start.');
    process.exit(1);
}

const sessionStore = new PgSession({
    pool: pool.raw,
    tableName: 'user_sessions',
    createTableIfMissing: true
});

const sessionMiddleware = session({
    secret: SESSION_SECRET || 'mclc-super-secret-session-key-2026',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Share Express session with Socket.IO so socket.request.user is populated
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

const activeSessions = new Map();

let isMaintenanceMode = false;

// --- MAINTENANCE MIDDLEWARE ---
app.use((req, res, next) => {
    // The unlock endpoints have to stay reachable while maintenance is on,
    // otherwise there is no way in to switch it back off. All three are rate
    // limited and reveal nothing beyond success or failure.
    const isMaintenancePath = req.path === '/maintenance'
        || req.path === '/api/admin/maintenance/auth'
        || req.path === '/api/admin/maintenance/toggle'
        || req.path === '/api/admin/maintenance/status'
        || req.path === '/api/login'
        || req.path === '/api/admin/session'
        || req.path === '/api/admin/lock';
    const isAdminPagePath = req.path === '/admin';
    const isAdminApiPath = req.path.startsWith('/api/admin/') || req.path === '/api/user';
    const isAdminBypassRoute = (isAdminPagePath || isAdminApiPath) && !!req.session?.adminBypass;
    const isResource = req.path.startsWith('/resources/')
        || req.path.startsWith('/uploads/')
        || req.path.startsWith('/assets/')
        || req.path === '/install.sh'
        || req.path === '/install.ps1';
    const isLocalExempt = req.path.startsWith('/socket.io');

    if (isMaintenanceMode && !isAdminBypassRoute && !isMaintenancePath && !isResource && !isLocalExempt) {
        if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'System under maintenance' });
        return res.redirect('/maintenance');
    }

    if (!isMaintenanceMode && req.path === '/maintenance') {
        return res.redirect('/');
    }
    next();
});

app.post('/api/admin/maintenance/auth', adminAuth.adminAuthLimiter, (req, res) => {
    if (adminAuth.submitsPassword(req)) {
        adminAuth.unlock(req);
        return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/admin/maintenance/toggle', adminAuth.adminAuthLimiter, (req, res) => {
    const hasAdminBypass = adminAuth.isUnlocked(req);
    const isSessionAdmin = adminAuth.isSessionAdmin(req);
    const hasAdminPassword = !hasAdminBypass && !isSessionAdmin && adminAuth.submitsPassword(req);

    if (hasAdminPassword || hasAdminBypass || isSessionAdmin) {
        if (hasAdminPassword || isSessionAdmin) {
            adminAuth.unlock(req);
        }
        isMaintenanceMode = !isMaintenanceMode;
        console.log(`[Maintenance] Mode is now ${isMaintenanceMode ? 'ON' : 'OFF'}`);
        return res.json({ success: true, isMaintenanceMode });
    }
    return res.status(401).json({ error: 'Unauthorized' });
});

app.get('/api/admin/maintenance/status', (req, res) => {
    res.json({ isMaintenanceMode });
});

let stats = {
    downloads: {
        mod: {},
        resourcepack: {},
        shader: {},
        modpack: {}
    },
    launchesPerDay: {}, // { "2023-10-27": 150 }
    clientVersions: {}, // { "1.0.0": 10 }
    uniqueMachineCount: 0,
    uniqueMachines: {},
    software: {
        client: {}, // { "Fabric": 10, "Vanilla": 5 }
        server: {}
    },
    gameVersions: {
        client: {}, // { "1.21": 8 }
        server: {}
    }
};

if (fs.existsSync(ANALYTICS_FILE)) {
    try {
        const loaded = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
        if (loaded.totalDownloads && !loaded.downloads) {
            stats.downloads.mod = loaded.totalDownloads;
            stats.launchesPerDay = loaded.launchesPerDay || {};
            stats.clientVersions = loaded.clientVersions || {};
        } else {
            stats = { ...stats, ...loaded };
            if (!stats.software) stats.software = { client: {}, server: {} };
            if (!stats.gameVersions) stats.gameVersions = { client: {}, server: {} };
        }
        if (!stats.uniqueMachines || typeof stats.uniqueMachines !== 'object') stats.uniqueMachines = {};
        stats.uniqueMachineCount = Number.isFinite(Number(stats.uniqueMachineCount))
            ? Number(stats.uniqueMachineCount)
            : Object.keys(stats.uniqueMachines).length;
    } catch (e) {
        console.error("Failed to load analytics:", e);
    }
} else {
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(stats, null, 2));
}

const saveAnalytics = () => {
    fs.writeFile(ANALYTICS_FILE, JSON.stringify(stats, null, 2), (err) => {
        if (err) console.error("Error saving analytics:", err);
    });
};

setInterval(saveAnalytics, 30 * 1000);

// Every value below comes straight from unauthenticated Socket.IO clients and is used as an
// object key to accumulate stats. Without this guard, a client sending e.g. type: '__proto__'
// can walk onto Object.prototype and pollute it for the whole process via a later `[key] = n`
// write — confirmed exploitable. Reject the dangerous key names outright before any indexing.
function isUnsafeStatsKey(key) {
    return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

io.on('connection', (socket) => {
    activeSessions.set(socket.id, {
        version: 'unknown',
        os: 'unknown',
        isPlaying: false,
        instance: null,
        startTime: Date.now()
    });

    emitLiveStats();

    socket.on('register', (data) => {
        const machineId = String(data?.machineId || '').trim();

        if (machineId) {
            for (const [existingSocketId, existingSession] of activeSessions.entries()) {
                if (existingSocketId === socket.id) continue;
                if (String(existingSession?.machineId || '').trim() === machineId) {
                    activeSessions.delete(existingSocketId);
                }
            }
        }

        const session = activeSessions.get(socket.id);
        if (session) {
            session.version = data.version || 'unknown';
            session.os = data.os || 'unknown';
            session.username = data.username || 'Anonymous';
            session.uuid = data.uuid || null;
            session.machineId = machineId || null;
            activeSessions.set(socket.id, session);
        }

        if (machineId && !isUnsafeStatsKey(machineId) && !stats.uniqueMachines[machineId]) {
            stats.uniqueMachines[machineId] = {
                firstSeenAt: Date.now(),
                version: data?.version || 'unknown',
                os: data?.os || 'unknown'
            };
            stats.uniqueMachineCount = Object.keys(stats.uniqueMachines).length;
            saveAnalytics();
        }

        if (data.version && !isUnsafeStatsKey(data.version)) {
            stats.clientVersions[data.version] = (stats.clientVersions[data.version] || 0) + 1;
        }

        emitLiveStats();
    });

    socket.on('update-status', (data) => {
        const session = activeSessions.get(socket.id);
        if (session) {
            if (data.isPlaying && !session.isPlaying) {
                const today = new Date().toISOString().split('T')[0];
                stats.launchesPerDay[today] = (stats.launchesPerDay[today] || 0) + 1;

                const mode = data.mode === 'server' ? 'server' : 'client';
                if (data.software && !isUnsafeStatsKey(data.software)) {
                    stats.software[mode][data.software] = (stats.software[mode][data.software] || 0) + 1;
                }
                if (data.gameVersion && !isUnsafeStatsKey(data.gameVersion)) {
                    stats.gameVersions[mode][data.gameVersion] = (stats.gameVersions[mode][data.gameVersion] || 0) + 1;
                }
                saveAnalytics();
            }

            session.isPlaying = data.isPlaying;
            session.instance = data.instance || null;
            activeSessions.set(socket.id, session);
        }
        emitLiveStats();
        io.to('admin').emit('live-update', {
            live: getLiveStats(),
            persistent: stats
        });
    });

    socket.on('track-creation', (data) => {
        const mode = data.mode === 'server' ? 'server' : 'client';
        console.log(`[Analytics] Track Creation (${mode}):`, data.software, data.version);
        if (data.software && !isUnsafeStatsKey(data.software)) {
            stats.software[mode][data.software] = (stats.software[mode][data.software] || 0) + 1;
        }
        if (data.version && !isUnsafeStatsKey(data.version)) {
            stats.gameVersions[mode][data.version] = (stats.gameVersions[mode][data.version] || 0) + 1;
        }
        saveAnalytics();

        io.to('admin').emit('live-update', {
            live: getLiveStats(),
            persistent: stats
        });
    });

    socket.on('track-download', (data) => {
        const type = data.type || 'mod';
        const key = data.name || data.id || 'unknown';
        if (isUnsafeStatsKey(type) || isUnsafeStatsKey(key)) return;

        const session = activeSessions.get(socket.id);
        const username = data.username || (session ? session.username : 'Anonymous');

        // Object.create(null) so this dictionary has no prototype at all — even if a bad
        // key ever slipped past the check above, there'd be no Object.prototype reachable
        // through it to pollute.
        if (!stats.downloads[type]) stats.downloads[type] = Object.create(null);

        if (key) {
            stats.downloads[type][key] = (stats.downloads[type][key] || 0) + 1;

            saveAnalytics();

            io.to('admin').emit('new-download', { ...data, username });
            io.to('admin').emit('live-update', {
                live: getLiveStats(),
                persistent: stats
            });
        }
    });

    // The unlock happens over HTTP and is remembered in the session, so the
    // password itself never has to be pushed through the socket.
    socket.on('admin-subscribe', () => {
        const socketUser = socket.request.user;
        const isSocketAdmin = socketUser && socketUser.role === 'admin';
        if (socket.request.session?.adminBypass || isSocketAdmin) {
            socket.join('admin');
            socket.emit('init-stats', {
                live: getLiveStats(),
                persistent: stats
            });
        } else {
            socket.emit('error', 'Invalid password');
        }
    });

    socket.on('disconnect', () => {
        activeSessions.delete(socket.id);
        emitLiveStats();
    });
});

function getLiveStats() {
    let activeUsers = 0;
    let playingUsers = 0;
    const versions = {};
    const playingInstances = {};
    const activeMachineKeys = new Set();
    const playingMachineKeys = new Set();

    activeSessions.forEach((session, socketId) => {
        const machineKey = String(session?.machineId || '').trim() || `socket:${socketId}`;

        if (session.version && session.version !== 'unknown') {
            if (!activeMachineKeys.has(machineKey)) {
                activeMachineKeys.add(machineKey);
                activeUsers++;
            }

            if (session.isPlaying) {
                if (!playingMachineKeys.has(machineKey)) {
                    playingMachineKeys.add(machineKey);
                    playingUsers++;
                }
                if (session.instance) {
                    playingInstances[session.instance] = (playingInstances[session.instance] || 0) + 1;
                }
            }
        }
        if (session.version && session.version !== 'unknown') {
            versions[session.version] = (versions[session.version] || 0) + 1;
        }
    });

    return {
        activeUsers,
        playingUsers,
        versions,
        playingInstances
    };
}

function emitLiveStats() {
    io.to('admin').emit('live-update', {
        live: getLiveStats(),
        persistent: stats
    });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = UPLOAD_DIR;
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// `returnTo` is attacker-controlled (it's a query param anyone can set on a link) and must
// never be allowed to point off-site — otherwise the real Google OAuth flow (or a bare
// /auth/logout hit) can be turned into convincing bait for a look-alike phishing/malware page,
// since the browser bar shows our real domain right up until the final redirect. Only accept
// same-site relative paths; reject protocol-relative ("//evil.com") and backslash variants
// ("/\evil.com"), which browsers also treat as absolute URLs.
function isSafeReturnPath(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (!value.startsWith('/')) return false;
    if (value.startsWith('//') || value.startsWith('/\\')) return false;
    return true;
}

app.get('/auth/google', (req, res, next) => {
    if (req.query.returnTo && isSafeReturnPath(req.query.returnTo)) {
        req.session.returnTo = req.query.returnTo;
        console.log(`[Auth] Set session returnTo: ${req.session.returnTo}`);
    } else {
        if (req.query.returnTo) console.warn(`[Auth] Rejected unsafe returnTo: ${req.query.returnTo}`);
        console.log(`[Auth] No returnTo provided, session state: ${req.session.returnTo || 'none'}`);
    }

    // Add debug info for cookies
    console.log(`[Auth] Protocol: ${req.protocol}, Secure Cookie: ${process.env.NODE_ENV === 'production'}, ENV: ${process.env.NODE_ENV}`);

    // Explicitly save session before redirecting to Google
    req.session.save((err) => {
        if (err) console.error('[Auth] Session save error:', err);
        next();
    });
}, passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', (req, res, next) => {
    passport.authenticate('google', (err, user, info) => {
        if (err) {
            console.error('[Google OAuth] Callback Error Handler:', err);
            return res.status(500).send(`Authentication failed: ${err.message}`);
        }
        if (!user) {
            console.warn('[Google OAuth] No user returned:', info);
            return res.redirect('/login?error=no_user');
        }
        // Read the destination BEFORE logging in. Passport regenerates the session in
        // req.logIn() to stop session fixation, and that wipes everything we put there
        // ourselves - reading req.session.returnTo afterwards always came back empty.
        // That is why a first-time sign-in from the client landed on the homepage and the
        // user had to run the whole device authorization a second time.
        const returnTo = isSafeReturnPath(req.session.returnTo) ? req.session.returnTo : '/';

        req.logIn(user, (loginErr) => {
            if (loginErr) {
                console.error('[Google OAuth] Login Error:', loginErr);
                return res.status(500).send(`Login failed: ${loginErr.message}`);
            }
            delete req.session.returnTo;
            console.log(`[Google OAuth] Login successful for: ${user.username}, redirecting to: ${returnTo}`);

            // The regenerated session must reach the store before the browser follows the
            // redirect, otherwise /authorize-device sees an anonymous request and bounces
            // the user back into the login flow.
            req.session.save((saveErr) => {
                if (saveErr) console.error('[Auth] Session save error after login:', saveErr);
                res.redirect(returnTo);
            });
        });
    })(req, res, next);
});

app.get('/auth/logout', (req, res, next) => {
    const returnTo = isSafeReturnPath(req.query.returnTo) ? req.query.returnTo : '/';
    req.logout((err) => {
        if (err) return next(err);
        res.redirect(returnTo);
    });
});

app.get('/api/user', (req, res) => {
    try {
        if (req.isAuthenticated()) {
            return res.json({ loggedIn: true, user: req.user });
        }
        res.json({ loggedIn: false });
    } catch (err) {
        console.error('[API Error] /api/user failed:', err);
        res.status(500).json({ error: 'Auth check failed', details: err.message });
    }
});

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

function ensureAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.role === 'admin') {
        return next();
    }
    res.status(403).json({ error: 'Forbidden' });
}

// Every route that calls this is already behind ensureAdmin, so req.user is always a real
// admin account here (never the standalone master-password bypass, which doesn't touch
// moderation endpoints) — safe to read req.user directly for who/what/when.
async function logAdminAction(req, action, targetType, targetId, details = null) {
    try {
        await pool.query(
            'INSERT INTO admin_audit_log (admin_user_id, admin_label, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.id, req.user.username, action, targetType, String(targetId), details]
        );
    } catch (err) {
        console.error('[AuditLog] Failed to record admin action:', err);
    }
}

app.get('/api/extensions', async (req, res) => {
    const { search, category, mcVersion, sort } = req.query;
    try {
        let query = `
            SELECT extensions.*, users.username as developer
            FROM extensions
            LEFT JOIN users ON extensions.user_id = users.id
            WHERE extensions.status = "approved"
              AND (extensions.visibility IS NULL OR extensions.visibility = 'public')
        `;
        const params = [];

        if (search) {
            query += ' AND (extensions.name LIKE ? OR extensions.description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }
        if (category && EXTENSION_CATEGORIES.includes(category)) {
            query += ' AND extensions.category = ?';
            params.push(category);
        }
        if (mcVersion && MC_VERSIONS.includes(mcVersion)) {
            query += ' AND extensions.mc_version = ?';
            params.push(mcVersion);
        }

        query += sort === 'newest' ? ' ORDER BY extensions.created_at DESC' : ' ORDER BY extensions.downloads DESC';

        const [extensions] = await pool.query(query, params);
        res.json(extensions);
    } catch (err) {
        console.error('[API Error] Fetch Extensions failed:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

app.get('/api/meta/filters', (req, res) => {
    res.json({ categories: EXTENSION_CATEGORIES, mcVersions: MC_VERSIONS });
});

app.post('/api/extensions/upload', ensureAuthenticated, upload.fields([
    { name: 'extensionFile', maxCount: 1 },
    { name: 'bannerImage', maxCount: 1 }
]), async (req, res) => {
    const files = req.files;
    if (!files || !files.extensionFile) return res.status(400).json({ error: 'No extension file uploaded' });

    const { name, description, identifier, summary, type, visibility, version, category, mcVersion } = req.body;
    const bannerFilename = files.bannerImage ? files.bannerImage[0].filename : null;
    const extensionFilename = files.extensionFile[0].filename;
    const safeCategory = EXTENSION_CATEGORIES.includes(category) ? category : null;
    const safeMcVersion = MC_VERSIONS.includes(mcVersion) ? mcVersion : null;
    const safeVisibility = EXTENSION_VISIBILITIES.includes(visibility) ? visibility : 'public';

    try {
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            const [extResult] = await connection.query(
                'INSERT INTO extensions (user_id, name, identifier, summary, description, type, visibility, banner_path, file_path, category, mc_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [req.user.id, name, identifier, summary, description, type || 'extension', safeVisibility, bannerFilename, extensionFilename, safeCategory, safeMcVersion]
            );
            const extensionId = extResult.insertId;

            console.log(`[Upload] Created extension record: ${extensionId} for ${identifier}. File: ${extensionFilename}`);

            await connection.query(
                'INSERT INTO extension_versions (extension_id, version, changelog, file_path, downloads, status) VALUES (?, ?, ?, ?, ?, ?)',
                [extensionId, version || '1.0.0', 'Initial upload', extensionFilename, 0, 'pending']
            );

            await connection.commit();
            res.json({ success: true, extensionId });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (err) {
        console.error('Upload Error:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Identifier already exists' });
        }
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

app.post('/api/extensions/update/:id', ensureAuthenticated, upload.fields([
    { name: 'bannerImage', maxCount: 1 }
]), async (req, res) => {
    const { id } = req.params;
    const { name, description, summary, type, visibility, category, mcVersion } = req.body;
    const files = req.files;

    try {
        const [rows] = await pool.query('SELECT user_id FROM extensions WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Extension not found' });
        if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const bannerPath = files && files.bannerImage ? files.bannerImage[0].filename : null;

        let updateFields = [];
        let queryParams = [];
        if (name) { updateFields.push('name = ?'); queryParams.push(name); }
        if (description) { updateFields.push('description = ?'); queryParams.push(description); }
        if (summary) { updateFields.push('summary = ?'); queryParams.push(summary); }
        if (bannerPath) { updateFields.push('banner_path = ?'); queryParams.push(bannerPath); }
        if (type) { updateFields.push('type = ?'); queryParams.push(type); }
        if (visibility) {
            if (!EXTENSION_VISIBILITIES.includes(visibility)) {
                return res.status(400).json({ error: 'Invalid visibility' });
            }
            updateFields.push('visibility = ?');
            queryParams.push(visibility);
        }
        if (category !== undefined) { updateFields.push('category = ?'); queryParams.push(EXTENSION_CATEGORIES.includes(category) ? category : null); }
        if (mcVersion !== undefined) { updateFields.push('mc_version = ?'); queryParams.push(MC_VERSIONS.includes(mcVersion) ? mcVersion : null); }

        if (updateFields.length > 0) {
            queryParams.push(id);
            await pool.query(`UPDATE extensions SET ${updateFields.join(', ')} WHERE id = ?`, queryParams);
        }

        await pool.query('UPDATE extensions SET status = "pending" WHERE id = ? AND status = "action_required"', [id]);

        res.json({ success: true, message: 'Extension updated successfully' });
    } catch (err) {
        console.error('Update (Draft) Error:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

app.post('/api/extensions/:id/version', ensureAuthenticated, upload.single('extensionFile'), async (req, res) => {
    const { id } = req.params;
    const { version, changelog } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const [rows] = await pool.query('SELECT user_id FROM extensions WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Extension not found' });
        if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await pool.query(
            'INSERT INTO extension_versions (extension_id, version, changelog, file_path, status) VALUES (?, ?, ?, ?, ?)',
            [id, version, changelog, req.file.filename, 'pending']
        );
        await pool.query('UPDATE extensions SET status = "pending" WHERE id = ? AND status = "action_required"', [id]);

        res.json({ success: true });
    } catch (err) {
        console.error('Version Upload Error:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

app.get('/api/extensions/i/:identifier', async (req, res) => {
    const { identifier } = req.params;
    try {
        const [rows] = await pool.query(`
            SELECT extensions.*, users.username as developer, users.avatar as developer_avatar,
                COALESCE(AVG(extension_ratings.rating), 0) as avg_rating,
                COUNT(extension_ratings.id) as rating_count
            FROM extensions
            LEFT JOIN users ON extensions.user_id = users.id
            LEFT JOIN extension_ratings ON extension_ratings.extension_id = extensions.id
            WHERE extensions.identifier = ?
            GROUP BY extensions.id, users.username, users.avatar
        `, [identifier]);

        if (rows.length === 0) return res.status(404).json({ error: 'Extension not found' });
        const extension = rows[0];

        const [versions] = await pool.query(
            'SELECT * FROM extension_versions WHERE extension_id = ? AND status = "approved" ORDER BY created_at DESC',
            [extension.id]
        );

        res.json({ ...extension, versions });
    } catch (err) {
        console.error('[API Error] Fetch Extension Detail failed:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- RATINGS ---

app.get('/api/extensions/:id/ratings', async (req, res) => {
    try {
        const [[agg]] = await pool.query(
            'SELECT COALESCE(AVG(rating), 0) as average, COUNT(*) as count FROM extension_ratings WHERE extension_id = ?',
            [req.params.id]
        );
        let yourRating = null;
        if (req.isAuthenticated()) {
            const [mine] = await pool.query(
                'SELECT rating FROM extension_ratings WHERE extension_id = ? AND user_id = ?',
                [req.params.id, req.user.id]
            );
            if (mine.length > 0) yourRating = mine[0].rating;
        }
        res.json({ average: Number(agg.average), count: Number(agg.count), yourRating });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/extensions/:id/ratings', ensureAuthenticated, async (req, res) => {
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
    }
    try {
        const [ext] = await pool.query('SELECT id FROM extensions WHERE id = ?', [req.params.id]);
        if (ext.length === 0) return res.status(404).json({ error: 'Extension not found' });

        await pool.query(
            `INSERT INTO extension_ratings (extension_id, user_id, rating) VALUES (?, ?, ?)
             ON CONFLICT (extension_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()`,
            [req.params.id, req.user.id, rating]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[API Error] Submit rating failed:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- COMMENTS ---

app.get('/api/extensions/:id/comments', async (req, res) => {
    try {
        const [comments] = await pool.query(`
            SELECT extension_comments.id, extension_comments.content, extension_comments.created_at, extension_comments.user_id,
                users.username, users.avatar
            FROM extension_comments
            JOIN users ON extension_comments.user_id = users.id
            WHERE extension_comments.extension_id = ? AND extension_comments.status = 'visible'
            ORDER BY extension_comments.created_at DESC
        `, [req.params.id]);
        res.json(comments);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

const COMMENT_COOLDOWN_MS = 30 * 1000;

app.post('/api/extensions/:id/comments', ensureAuthenticated, async (req, res) => {
    const content = String(req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });
    if (content.length > 1000) return res.status(400).json({ error: 'Comment is too long (max 1000 characters)' });

    try {
        const [ext] = await pool.query('SELECT id FROM extensions WHERE id = ?', [req.params.id]);
        if (ext.length === 0) return res.status(404).json({ error: 'Extension not found' });

        const [recent] = await pool.query(
            'SELECT created_at FROM extension_comments WHERE extension_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
            [req.params.id, req.user.id]
        );
        if (recent.length > 0) {
            const elapsedMs = Date.now() - new Date(recent[0].created_at).getTime();
            if (elapsedMs < COMMENT_COOLDOWN_MS) {
                const waitSec = Math.ceil((COMMENT_COOLDOWN_MS - elapsedMs) / 1000);
                return res.status(429).json({ error: `Please wait ${waitSec}s before commenting again.` });
            }
        }

        const [result] = await pool.query(
            'INSERT INTO extension_comments (extension_id, user_id, content) VALUES (?, ?, ?)',
            [req.params.id, req.user.id, content]
        );
        res.json({
            success: true,
            comment: {
                id: result.insertId,
                content,
                created_at: new Date().toISOString(),
                user_id: req.user.id,
                username: req.user.username,
                avatar: req.user.avatar
            }
        });
    } catch (err) {
        console.error('[API Error] Post comment failed:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/extensions/comments/:commentId', ensureAuthenticated, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT extension_comments.user_id as author_id, extensions.user_id as owner_id
            FROM extension_comments
            JOIN extensions ON extension_comments.extension_id = extensions.id
            WHERE extension_comments.id = ?
        `, [req.params.commentId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Comment not found' });

        const { author_id, owner_id } = rows[0];
        const isAuthor = author_id === req.user.id;
        const isExtensionOwner = owner_id === req.user.id;
        const isAdmin = req.user.role === 'admin';
        if (!isAuthor && !isExtensionOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

        await pool.query('DELETE FROM extension_comments WHERE id = ?', [req.params.commentId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// --- CONTENT REPORTS ---

app.post('/api/reports', ensureAuthenticated, async (req, res) => {
    const targetType = req.body.targetType;
    const targetId = Number(req.body.targetId);
    const reason = String(req.body.reason || '').trim();

    if (!['extension', 'comment'].includes(targetType)) return res.status(400).json({ error: 'Invalid target type' });
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: 'Invalid target' });
    if (!reason) return res.status(400).json({ error: 'Please describe why you are reporting this' });
    if (reason.length > 500) return res.status(400).json({ error: 'Reason is too long (max 500 characters)' });

    try {
        const table = targetType === 'extension' ? 'extensions' : 'extension_comments';
        const [target] = await pool.query(`SELECT id FROM ${table} WHERE id = ?`, [targetId]);
        if (target.length === 0) return res.status(404).json({ error: 'Reported content not found' });

        const [result] = await pool.query(
            `INSERT INTO content_reports (reporter_user_id, target_type, target_id, reason) VALUES (?, ?, ?, ?)
             ON CONFLICT (reporter_user_id, target_type, target_id) DO NOTHING`,
            [req.user.id, targetType, targetId, reason]
        );
        if (!result.affectedRows) {
            return res.status(409).json({ error: 'You already reported this.' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[API Error] Submit report failed:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/extensions/:id/versions', ensureAuthenticated, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM extension_versions WHERE extension_id = ? ORDER BY created_at DESC',
            [req.params.id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/extensions/versions/:vid', ensureAuthenticated, async (req, res) => {
    const vid = req.params.vid;
    try {
        const [ext] = await pool.query(`
            SELECT extensions.user_id FROM extensions
            JOIN extension_versions ON extensions.id = extension_versions.extension_id
            WHERE extension_versions.id = ?
        `, [vid]);

        if (ext.length === 0) return res.status(404).json({ error: 'Version not found' });
        if (ext[0].user_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await pool.query('DELETE FROM extension_versions WHERE id = ?', [vid]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/extensions/:id', ensureAuthenticated, async (req, res) => {
    const { id } = req.params;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [ext] = await connection.query('SELECT user_id FROM extensions WHERE id = ?', [id]);
        if (ext.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Extension not found' });
        }

        if (ext[0].user_id !== req.user.id && req.user.role !== 'admin') {
            await connection.rollback();
            return res.status(403).json({ error: 'Unauthorized: You do not own this extension' });
        }

        await connection.query('DELETE FROM extension_versions WHERE extension_id = ?', [id]);
        await connection.query('DELETE FROM extension_metadata_drafts WHERE extension_id = ?', [id]);
        await connection.query('DELETE FROM extensions WHERE id = ?', [id]);

        await connection.commit();
        res.json({ success: true, message: 'Extension deleted successfully' });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('[Lux] Error deleting extension:', err);
        res.status(500).json({ error: 'Database error while deleting' });
    } finally {
        if (connection) connection.release();
    }
});

app.get('/api/user/extensions', ensureAuthenticated, async (req, res) => {
    try {
        const query = 'SELECT * FROM extensions WHERE user_id = ? ORDER BY created_at DESC';
        const [rows] = await pool.query(query, [req.user.id]);
        res.json(rows);
    } catch (err) {
        console.error('[API Error] /api/user/extensions failed:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

app.post('/api/extensions/:id/download', async (req, res) => {
    const { id } = req.params;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const cooldownKey = `${ip}-${id}`;
    const now = Date.now();

    // 10 minute cooldown per IP per extension
    if (downloadCooldowns.has(cooldownKey)) {
        const lastDownload = downloadCooldowns.get(cooldownKey);
        if (now - lastDownload < 10 * 60 * 1000) {
            return res.json({ success: true, message: 'Cooldown active' });
        }
    }

    try {
        const [ext] = await pool.query('SELECT name, type FROM extensions WHERE id = ?', [id]);
        if (ext.length === 0) return res.status(404).json({ error: 'Extension not found' });

        downloadCooldowns.set(cooldownKey, now);

        await pool.query('UPDATE extensions SET downloads = downloads + 1 WHERE id = ?', [id]);
        await pool.query(`
            WITH latest AS (
                SELECT id
                FROM extension_versions
                WHERE extension_id = ? AND status = "approved"
                ORDER BY created_at DESC
                LIMIT 1
            )
            UPDATE extension_versions
            SET downloads = downloads + 1
            WHERE id IN (SELECT id FROM latest)
        `, [id]);

        const type = ext[0].type || 'mod';
        const name = ext[0].name || 'unknown';

        if (!stats.downloads[type]) stats.downloads[type] = {};
        stats.downloads[type][name] = (stats.downloads[type][name] || 0) + 1;

        saveAnalytics();

        io.to('admin').emit('new-download', { type, name, username: 'Web Guest' });
        io.to('admin').emit('live-update', {
            live: getLiveStats(),
            persistent: stats
        });

        res.json({ success: true });
    } catch (err) {
        console.error('[API Error] Track download failed:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/user/notifications', ensureAuthenticated, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
            [req.user.id]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/notifications/read/:id', ensureAuthenticated, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/notifications/read-all', ensureAuthenticated, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = ?', [req.user.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/user/update', ensureAuthenticated, upload.single('avatarFile'), async (req, res) => {
    const { username, bio, avatar, is_private } = req.body;
    let finalAvatar = avatar;
    const isPrivateBool = is_private === 'true';

    if (req.file) {
        finalAvatar = req.file.filename;
    }

    try {
        // Check if username is already taken by someone else
        if (username) {
            const [existing] = await pool.query('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.user.id]);
            if (existing.length > 0) {
                return res.status(409).json({ error: 'Username already taken' });
            }
        }

        await pool.query(
            'UPDATE users SET username = ?, bio = ?, avatar = ?, is_private = ? WHERE id = ?',
            [username, bio, finalAvatar, isPrivateBool, req.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[API Error] /api/user/update failed:', err);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

app.delete('/api/user/delete', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.user.id;
        console.log(`[Lux] Account deletion requested by user ID: ${userId} (${req.user.username})`);

        // Delete uploaded files for this user's extensions
        const [extensions] = await pool.query('SELECT id, banner_path FROM extensions WHERE user_id = ?', [userId]);
        const [versions] = await pool.query(
            'SELECT ev.file_path FROM extension_versions ev JOIN extensions e ON ev.extension_id = e.id WHERE e.user_id = ?',
            [userId]
        );

        const fs = require('fs');
        const path = require('path');
        const uploadsDir = path.join(__dirname, 'uploads');

        // Clean up version files
        for (const v of versions) {
            if (v.file_path) {
                const filePath = path.join(uploadsDir, v.file_path);
                try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            }
        }

        // Clean up banner files
        for (const ext of extensions) {
            if (ext.banner_path) {
                const bannerPath = path.join(uploadsDir, ext.banner_path);
                try { if (fs.existsSync(bannerPath)) fs.unlinkSync(bannerPath); } catch (e) { /* ignore */ }
            }
        }

        // Cloud data has to go first. DELETE FROM users cascades into cloud_instances and
        // blob_refs, and a cascade does not decrement blobs.refcount -- the blobs would stay
        // referenced forever and never be collected.
        try {
            const { purgeEverything } = require('./cloudAccount');
            const purged = await purgeEverything(userId);
            console.log(`[Lux] Cloud data purged before account deletion for user ${userId}:`, purged);
        } catch (cloudErr) {
            console.error('[Lux] Cloud purge failed, aborting account deletion:', cloudErr);
            return res.status(500).json({
                error: 'Could not delete the cloud data, so the account was kept',
                details: cloudErr.message
            });
        }

        // Delete user (CASCADE handles extensions, versions, notifications, drafts)
        await pool.query('DELETE FROM users WHERE id = ?', [userId]);

        // Destroy session
        req.logout((err) => {
            req.session.destroy(() => {
                res.json({ success: true });
            });
        });

        console.log(`[Lux] Account deleted successfully: user ID ${userId}`);
    } catch (err) {
        console.error('[API Error] /api/user/delete failed:', err);
        res.status(500).json({ error: 'Failed to delete account', details: err.message });
    }
});

app.get('/api/users/p/:username', async (req, res) => {
    try {
        const [userRows] = await pool.query('SELECT id, username, avatar, bio, role, created_at, is_private FROM users WHERE username = ?', [req.params.username]);
        if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });

        const user = userRows[0];
        const [extensions] = await pool.query(
            `SELECT name, identifier, summary, banner_path, type, status FROM extensions WHERE user_id = ? AND status = "approved" AND (visibility IS NULL OR visibility = 'public')`,
            [user.id]
        );

        if (user.is_private || extensions.length === 0) {
            return res.status(404).json({ error: 'User not found or profile is private' });
        }

        delete user.is_private; // Sanitize response
        res.json({ user, extensions });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/admin/users', ensureAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, username, email, avatar, ip_address, role, last_login, banned, warn_count, created_at FROM users ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/admin/users/:id/:action', ensureAdmin, async (req, res) => {
    const { id, action } = req.params;
    const { reason, duration } = req.body;

    try {
        let targetUser = null;
        if (action === 'warn' || action === 'ban') {
            const [targetRows] = await pool.query('SELECT username, email FROM users WHERE id = ?', [id]);
            targetUser = targetRows[0] || null;
        }

        if (action === 'warn') {
            await pool.query('UPDATE users SET warn_count = warn_count + 1 WHERE id = ?', [id]);
            await pool.query('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)', [id, `You have received a warning. Reason: ${reason || 'No reason specified'}`, 'warning']);
            if (targetUser) emailService.notifyUserWarned(targetUser, reason || 'No reason specified').catch(() => {});
        } else if (action === 'ban') {
            let expires = null;
            if (duration) {
                expires = new Date();
                expires.setHours(expires.getHours() + parseInt(duration));
            }
            await pool.query('UPDATE users SET banned = TRUE, ban_reason = ?, ban_expires = ? WHERE id = ?', [reason, expires, id]);
            await pool.query('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)', [id, `You have been banned. Reason: ${reason}`, 'error']);
            if (targetUser) emailService.notifyUserBanned(targetUser, reason).catch(() => {});
        } else if (action === 'unban') {
            await pool.query('UPDATE users SET banned = FALSE, ban_reason = NULL, ban_expires = NULL WHERE id = ?', [id]);
            await pool.query('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)', [id, 'Your ban has been lifted.', 'success']);
        } else if (action === 'promote') {
            await pool.query('UPDATE users SET role = ? WHERE id = ?', ['admin', id]);
            await pool.query('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)', [id, 'You have been granted administrator access.', 'success']);
        } else if (action === 'demote') {
            if (Number(id) === Number(req.user.id)) {
                return res.status(400).json({ error: 'You cannot remove your own admin role.' });
            }
            await pool.query('UPDATE users SET role = ? WHERE id = ?', ['user', id]);
            await pool.query('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)', [id, 'Your administrator access has been removed.', 'info']);
        } else {
            return res.status(400).json({ error: 'Invalid action' });
        }
        await logAdminAction(req, `user.${action}`, 'user', id, reason || null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/admin/reset-stats', adminAuth.adminAuthLimiter, adminAuth.adminOrPassword, (req, res) => {
    stats = {
        downloads: { mod: {}, resourcepack: {}, shader: {}, modpack: {} },
        launchesPerDay: {},
        clientVersions: {},
        uniqueMachineCount: 0,
        uniqueMachines: {},
        software: { client: {}, server: {} },
        gameVersions: { client: {}, server: {} }
    };
    saveAnalytics();
    io.to('admin').emit('init-stats', {
        live: getLiveStats(),
        persistent: stats
    });
    res.json({ success: true });
});

app.get('/api/admin/extensions/all', ensureAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT extensions.*, users.username as developer 
            FROM extensions 
            LEFT JOIN users ON extensions.user_id = users.id 
            ORDER BY created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/admin/extensions/pending', ensureAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT extensions.*, users.username as developer 
            FROM extensions 
            LEFT JOIN users ON extensions.user_id = users.id 
            WHERE extensions.status = "pending"
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// File inspection for moderation: size, sha256 hash, and a VirusTotal lookup link.
// No API key required — admins paste the hash into VirusTotal manually via the link.
app.get('/api/admin/file-info', ensureAdmin, async (req, res) => {
    const { file } = req.query;
    if (!file || typeof file !== 'string' || file.includes('..') || file.includes('/') || file.includes('\\')) {
        return res.status(400).json({ error: 'Invalid file parameter' });
    }
    let filePath = path.join(UPLOAD_DIR, file);
    if (!fs.existsSync(filePath)) filePath = path.join(__dirname, 'public/uploads', file);
    try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) return res.status(404).json({ error: 'File not found' });

        const hash = crypto.createHash('sha256');
        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(filePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', resolve);
            stream.on('error', reject);
        });
        const sha256 = hash.digest('hex');

        res.json({
            filename: file,
            size: stat.size,
            sha256,
            downloadUrl: `/uploads/${file}`,
            virusTotalUrl: `https://www.virustotal.com/gui/file/${sha256}`,
        });
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
        console.error('[Lux] File info error:', err);
        res.status(500).json({ error: 'Failed to inspect file' });
    }
});

app.get('/api/admin/reports', ensureAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT content_reports.*, reporter.username as reporter_username,
                ext_direct.name as extension_name, ext_direct.identifier as extension_identifier,
                comment_target.content as comment_content,
                comment_ext.name as comment_extension_name, comment_ext.identifier as comment_extension_identifier
            FROM content_reports
            JOIN users reporter ON content_reports.reporter_user_id = reporter.id
            LEFT JOIN extensions ext_direct ON content_reports.target_type = 'extension' AND content_reports.target_id = ext_direct.id
            LEFT JOIN extension_comments comment_target ON content_reports.target_type = 'comment' AND content_reports.target_id = comment_target.id
            LEFT JOIN extensions comment_ext ON comment_target.extension_id = comment_ext.id
            WHERE content_reports.status = 'pending'
            ORDER BY content_reports.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        console.error('[API Error] Fetch reports failed:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/admin/reports/:id/:action', ensureAdmin, async (req, res) => {
    const { id, action } = req.params;
    if (!['resolve', 'dismiss'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const status = action === 'resolve' ? 'resolved' : 'dismissed';
    try {
        await pool.query('UPDATE content_reports SET status = ? WHERE id = ?', [status, id]);
        await logAdminAction(req, `report.${status}`, 'report', id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/admin/audit-log', ensureAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 200');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/admin/drafts/pending', ensureAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT extension_metadata_drafts.*, extensions.name as original_name, users.username as developer
            FROM extension_metadata_drafts
            JOIN extensions ON extension_metadata_drafts.extension_id = extensions.id
            JOIN users ON extensions.user_id = users.id
            WHERE extension_metadata_drafts.status = "pending"
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/admin/drafts/:did/:action', ensureAdmin, async (req, res) => {
    const { did, action } = req.params;
    const { reason } = req.body;
    try {
        if (action === 'approve') {
            const [drafts] = await pool.query('SELECT * FROM extension_metadata_drafts WHERE id = ?', [did]);
            if (drafts.length === 0) return res.status(404).json({ error: 'Draft not found' });
            const draft = drafts[0];

            let updates = [];
            let params = [];
            if (draft.name) { updates.push('name = ?'); params.push(draft.name); }
            if (draft.summary) { updates.push('summary = ?'); params.push(draft.summary); }
            if (draft.description) { updates.push('description = ?'); params.push(draft.description); }
            if (draft.banner_path) { updates.push('banner_path = ?'); params.push(draft.banner_path); }

            if (updates.length > 0) {
                params.push(draft.extension_id);
                await pool.query(`UPDATE extensions SET ${updates.join(', ')} WHERE id = ?`, params);
            }

            await pool.query('UPDATE extension_metadata_drafts SET status = "approved" WHERE id = ?', [did]);
        } else {
            await pool.query('UPDATE extension_metadata_drafts SET status = "rejected" WHERE id = ?', [did]);
        }
        await logAdminAction(req, `draft.${action}`, 'draft', did, reason || null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/admin/versions/pending', ensureAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT extension_versions.*, extensions.name as extension_name, users.username as developer
            FROM extension_versions
            JOIN extensions ON extension_versions.extension_id = extensions.id
            JOIN users ON extensions.user_id = users.id
            WHERE extension_versions.status = "pending" AND extensions.status = "approved"
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/admin/versions/:vid/:action', ensureAdmin, async (req, res) => {
    const { vid, action } = req.params;
    const status = action === 'approve' ? 'approved' : 'rejected';
    try {
        await pool.query('UPDATE extension_versions SET status = ? WHERE id = ?', [status, vid]);
        await logAdminAction(req, `version.${status}`, 'version', vid);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/admin/extensions/:id', ensureAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM extensions WHERE id = ?', [req.params.id]);
        await logAdminAction(req, 'extension.delete', 'extension', req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/admin/extensions/:id/:action', ensureAdmin, async (req, res) => {
    const { id, action } = req.params;
    const { reason } = req.body;
    let status = 'pending';
    if (action === 'approve') status = 'approved';
    else if (action === 'reject') status = 'rejected';
    else if (action === 'action_required') status = 'action_required';

    try {
        await pool.query('UPDATE extensions SET status = ? WHERE id = ?', [status, id]);

        const [ext] = await pool.query(`
            SELECT extensions.user_id, extensions.name, extensions.identifier, users.username, users.email
            FROM extensions JOIN users ON extensions.user_id = users.id
            WHERE extensions.id = ?
        `, [id]);
        if (ext.length > 0) {
            const owner = ext[0];
            const name = owner.name;
            let msg = '';
            let type = 'info';

            if (status === 'approved') {
                msg = `Your extension "${name}" has been approved!`;
                type = 'success';
                await pool.query('UPDATE extension_versions SET status = "approved" WHERE extension_id = ? AND status = "pending"', [id]);
                emailService.notifyExtensionApproved(owner, name, owner.identifier).catch(() => {});
            } else if (status === 'rejected') {
                msg = `Your extension "${name}" was rejected. Reason: ${reason || 'No reason specified'}`;
                type = 'error';
                emailService.notifyExtensionRejected(owner, name, reason).catch(() => {});
            } else if (status === 'action_required') {
                msg = `Action required for your extension "${name}". Please check the feedback: ${reason || 'No reason specified'}`;
                type = 'warning';
                emailService.notifyActionRequired(owner, name, reason).catch(() => {});
            }

            await pool.query('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)', [owner.user_id, msg, type]);
        }

        await logAdminAction(req, `extension.${status}`, 'extension', id, reason || null);
        res.json({ success: true });
    } catch (err) {
        console.error('[Lux] Admin extension status update error:', err);
        res.status(500).json({ error: 'Database error', details: err.message });
    }
});

app.post('/api/upload', adminAuth.adminAuthLimiter, (req, res) => {
    upload.single('image')(req, res, (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        // Checked after multer so a multipart body is parsed, but the file is
        // removed again below when the caller turns out not to be an admin.
        if (!adminAuth.isSessionAdmin(req) && !adminAuth.isUnlocked(req) && !adminAuth.submitsPassword(req)) {
            if (req.file) {
                const fs = require('fs');
                try { fs.unlinkSync(req.file.path); } catch (e) { }
            }
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

        const protocol = req.protocol;
        const host = req.get('host');
        const fullUrl = `${protocol}://${host}/uploads/${req.file.filename}`;

        res.json({ success: true, url: fullUrl });
    });
});

app.get('/news.json', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.json(getNews());
});

// Unlocking stores a flag on the server session. The browser gets no copy of
// the password to keep, so an XSS anywhere on the site cannot lift it out of
// localStorage the way it could before.
app.post('/api/login', adminAuth.adminAuthLimiter, (req, res) => {
    if (adminAuth.submitsPassword(req)) {
        adminAuth.unlock(req);
        return res.json({ success: true });
    }
    return res.status(401).json({ success: false, error: 'Invalid password' });
});

app.get('/api/admin/session', (req, res) => {
    res.json({
        unlocked: adminAuth.isUnlocked(req),
        role: req.user?.role || null,
    });
});

app.post('/api/admin/lock', (req, res) => {
    if (req.session) req.session.adminBypass = false;
    res.json({ success: true });
});

app.get('/api/news', (req, res) => {
    res.json(getNews());
});

app.post('/api/news', adminAuth.adminAuthLimiter, adminAuth.adminOrPassword, (req, res) => {
    const { news } = req.body;
    console.log(`[News] POST /api/news received. Items: ${news ? news.length : 'null'}`);

    try {
        saveNews(news);
        console.log(`[News] Saved ${news.length} items to ${NEWS_FILE}`);
        const verify = getNews();
        console.log(`[News] Verify: file now contains ${verify.length} items`);
        res.json({ success: true });
    } catch (err) {
        console.error(`[News] Write error:`, err);
        res.status(500).json({ success: false, error: 'Failed to write news: ' + err.message });
    }
});

// --- RELEASES / CHANGELOG PROXY ---
// GitHub's unauthenticated REST API is capped at 60 requests/hour per calling IP - since we're
// the caller here (not each visitor), an in-memory cache keeps every real site visitor from
// eating into that same shared budget.
let releasesCache = { data: null, fetchedAt: 0 };
const RELEASES_CACHE_TTL_MS = 10 * 60 * 1000;

app.get('/api/releases', async (req, res) => {
    try {
        if (releasesCache.data && (Date.now() - releasesCache.fetchedAt) < RELEASES_CACHE_TTL_MS) {
            return res.json(releasesCache.data);
        }

        const response = await fetch('https://api.github.com/repos/Lux-Client/Lux-Client/releases?per_page=15', {
            headers: {
                'User-Agent': 'Lux-Website/1.0',
                'Accept': 'application/vnd.github+json'
            }
        });
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        const raw = await response.json();

        const releases = (Array.isArray(raw) ? raw : [])
            .filter(r => !r.draft)
            .map(r => ({
                id: r.id,
                name: r.name || r.tag_name,
                tag: r.tag_name,
                body: r.body || '',
                url: r.html_url,
                prerelease: !!r.prerelease,
                publishedAt: r.published_at
            }));

        releasesCache = { data: releases, fetchedAt: Date.now() };
        res.json(releases);
    } catch (err) {
        console.error('[Releases Proxy] Error fetching releases:', err);
        if (releasesCache.data) return res.json(releasesCache.data);
        res.status(502).json({ error: 'Failed to fetch releases' });
    }
});

// --- MODRINTH PROXY ROUTES ---
app.get('/api/modrinth/versions', async (req, res) => {
    try {
        const response = await fetch('https://api.modrinth.com/v2/tag/game_version', {
            headers: {
                'User-Agent': 'MCLC/1.0.0 (mclc@pluginhub.de)'
            }
        });
        if (!response.ok) throw new Error(`Modrinth returned ${response.status}`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('[Modrinth Proxy] Error fetching versions:', err);
        res.status(500).json({ error: 'Failed to fetch versions' });
    }
});

app.get('/api/modrinth/search', async (req, res) => {
    try {
        const params = new URLSearchParams(req.query);
        const response = await fetch(`https://api.modrinth.com/v2/search?${params.toString()}`, {
            headers: {
                'User-Agent': 'MCLC/1.0.0 (mclc@pluginhub.de)'
            }
        });
        if (!response.ok) throw new Error(`Modrinth returned ${response.status}`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error('[Modrinth Proxy] Error fetching search:', err);
        res.status(500).json({ error: 'Failed to fetch search' });
    }
});

// Lux Cloud can be switched off entirely. A missing or weak signing secret disables it
// as well -- it must never take the rest of the site down with it, because the
// marketplace, the news and the admin panel do not depend on any of this.
const LUXCLOUD_JWT_SECRET = process.env.LUXCLOUD_JWT_SECRET;
const LUXCLOUD_SWITCHED_OFF = String(process.env.LUXCLOUD_ENABLED || 'true').toLowerCase() === 'false';
const LUXCLOUD_SECRET_OK = Boolean(LUXCLOUD_JWT_SECRET) && LUXCLOUD_JWT_SECRET.length >= 32;
const LUXCLOUD_ACTIVE = !LUXCLOUD_SWITCHED_OFF && (LUXCLOUD_SECRET_OK || process.env.NODE_ENV !== 'production');

if (LUXCLOUD_SWITCHED_OFF) {
    console.log('[LuxCloud] Disabled via LUXCLOUD_ENABLED=false. Cloud routes are not mounted.');
} else if (!LUXCLOUD_SECRET_OK && process.env.NODE_ENV === 'production') {
    console.error('[LuxCloud] CRITICAL: LUXCLOUD_JWT_SECRET is missing or shorter than 32 characters.');
    console.error('[LuxCloud] Cloud sync stays OFF. The rest of the site runs normally.');
    console.error('[LuxCloud] Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
} else if (!LUXCLOUD_SECRET_OK) {
    console.warn('[LuxCloud] No LUXCLOUD_JWT_SECRET set - using a development fallback. Never do this in production.');
}

app.get('/api/cloud/status', (req, res) => {
    res.json({ enabled: LUXCLOUD_ACTIVE, reason: LUXCLOUD_ACTIVE ? null : (LUXCLOUD_SWITCHED_OFF ? 'disabled' : 'not_configured') });
});

if (LUXCLOUD_ACTIVE) {
    app.use('/', require('./routes/deviceAuth'));
    app.use('/', require('./routes/devicePairing'));
    app.use('/api/cloud', require('./routes/cloud'));
    app.use('/api/cloud', require('./routes/cloudBlobs'));
    app.use('/api/cloud', require('./routes/cloudSync'));
    app.use('/api/admin/cloud', require('./routes/adminCloud'));
} else {
    app.use(['/api/cloud', '/auth/device', '/api/auth/device'], (req, res) => {
        res.status(503).json({
            error: 'cloud_disabled',
            message: 'Lux Cloud is not available on this server'
        });
    });
}

app.use((err, req, res, next) => {
    console.error(`[Server Error] ${req.method} ${req.url}:`, err);
    res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : err.message
    });
});

// --- STATIC SERVING ---

const websitePath = fs.existsSync(path.join(__dirname, 'website'))
    ? path.join(__dirname, 'website')
    : __dirname;

const adminPublicPath = fs.existsSync(path.join(__dirname, 'public'))
    ? path.join(__dirname, 'public')
    : path.join(__dirname, 'news-admin/public');

const uploadPath = UPLOAD_DIR;
const legacyUploadPath = path.resolve(__dirname, 'public/uploads');

console.log(`[Static] Serving website from: ${path.resolve(websitePath)}`);
console.log(`[Static] Serving admin from: ${path.resolve(adminPublicPath)}`);
console.log(`[Static] Serving uploads from: ${uploadPath}`);
if (legacyUploadPath !== uploadPath) {
    console.log(`[Static] Legacy uploads fallback from: ${legacyUploadPath}`);
}

const staticOptions = {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
        if (filePath.endsWith('.luxextension')) {
            res.setHeader('Content-Type', 'application/octet-stream');
        }
    }
};

app.use('/uploads', express.static(uploadPath, {
    maxAge: '1d',
    ...staticOptions,
    setHeaders: (res, filePath) => {
        staticOptions.setHeaders(res, filePath);
        if (filePath.endsWith('.png') || filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        }
    }
}));

if (legacyUploadPath !== uploadPath) {
    app.use('/uploads', express.static(legacyUploadPath, {
        maxAge: '1d',
        ...staticOptions,
        setHeaders: (res, filePath) => {
            staticOptions.setHeaders(res, filePath);
            if (filePath.endsWith('.png') || filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
                res.setHeader('Cache-Control', 'public, max-age=86400');
            }
        }
    }));
}

const clientDistPath = path.resolve(__dirname, 'client', 'dist');
app.use(express.static(clientDistPath, staticOptions));
console.log(`[Static] Serving React app from: ${clientDistPath}`);

app.get('/', (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
});

app.use(express.static(websitePath, staticOptions));
app.use(express.static(adminPublicPath, staticOptions));

codesSystem(app, ADMIN_PASSWORD, pool);

if (!fs.existsSync(NEWS_FILE)) {
    fs.writeFileSync(NEWS_FILE, JSON.stringify([], null, 2));
}

const getNews = () => JSON.parse(fs.readFileSync(NEWS_FILE, 'utf8'));
const saveNews = (data) => fs.writeFileSync(NEWS_FILE, JSON.stringify(data, null, 2));

app.post('/api/analytics', adminAuth.adminAuthLimiter, adminAuth.adminOrPassword, (req, res) => {
    res.json({
        live: getLiveStats(),
        persistent: stats
    });
});

const { createTables } = require('./db_init');

// --- TEMPORARY MIGRATION SCRIPT ---
pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE;')
    .then(() => console.log('[Lux] Database migration: added is_private column.'))
    .catch(err => {
        console.error('[Lux] Database migration failed:', err);
    });

// --- DYNAMIC OG/TWITTER META TAGS FOR EXTENSION PAGES ---
// The SPA is client-rendered, so link-preview crawlers (Discord, Slack, Twitter, etc.) never
// run the JS that would show the real title/image - they only see whatever's in the initial
// HTML. This serves the same index.html but with per-extension <title>/<meta> tags swapped in
// before the SPA takes over normally on the client.
let indexHtmlTemplate = null;
function getIndexHtmlTemplate() {
    if (indexHtmlTemplate === null) {
        try {
            indexHtmlTemplate = fs.readFileSync(path.join(clientDistPath, 'index.html'), 'utf8');
        } catch (e) {
            indexHtmlTemplate = '';
        }
    }
    return indexHtmlTemplate;
}
function escapeHtmlAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.get('/extensions/:identifier', async (req, res, next) => {
    try {
        const template = getIndexHtmlTemplate();
        if (!template) return next();

        const { identifier } = req.params;
        const isNumeric = /^\d+$/.test(identifier);
        const query = isNumeric
            ? 'SELECT name, summary, description, banner_path, visibility FROM extensions WHERE (identifier = ? OR id = ?) AND status = "approved"'
            : 'SELECT name, summary, description, banner_path, visibility FROM extensions WHERE identifier = ? AND status = "approved"';
        const [rows] = await pool.query(query, isNumeric ? [identifier, identifier] : [identifier]);
        if (rows.length === 0) return next();

        const ext = rows[0];
        const title = `${ext.name} — Lux Client Marketplace`;
        const description = (ext.summary || ext.description || 'Discover this project on the Lux Client marketplace.').slice(0, 200);
        const image = ext.banner_path
            ? `https://lux.pluginhub.de/uploads/${String(ext.banner_path).replace(/^\/?uploads\//, '')}`
            : 'https://lux.pluginhub.de/resources/lux_icon.png';
        const url = `https://lux.pluginhub.de/extensions/${identifier}`;

        // Unlisted projects stay reachable via direct link, but must not be indexed
        const robotsMeta = ext.visibility === 'unlisted'
            ? '  <meta name="robots" content="noindex, nofollow" />\n'
            : '';

        const html = template
            .replace(/<title>.*?<\/title>/, `<title>${escapeHtmlAttr(title)}</title>`)
            .replace(/<meta name="description" content=".*?"\s*\/>/, `<meta name="description" content="${escapeHtmlAttr(description)}" />`)
            .replace(/<meta property="og:title" content=".*?"\s*\/>/, `<meta property="og:title" content="${escapeHtmlAttr(title)}" />`)
            .replace(/<meta property="og:description" content=".*?"\s*\/>/, `<meta property="og:description" content="${escapeHtmlAttr(description)}" />`)
            .replace(/<meta property="og:url" content=".*?"\s*\/>/, `<meta property="og:url" content="${escapeHtmlAttr(url)}" />`)
            .replace('</head>', `  <meta property="og:image" content="${escapeHtmlAttr(image)}" />\n  <meta name="twitter:card" content="summary_large_image" />\n${robotsMeta}</head>`);

        res.send(html);
    } catch (err) {
        console.error('[OG Meta] Failed to render extension meta tags:', err);
        next();
    }
});

// SPA catch-all: serve React app for all non-API GET routes
app.get('*', (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
});

server.listen(PORT, async () => {
    console.log(`News Admin Server (with Socket.IO, Auth, Extensions) running on port ${PORT}`);

    try {
        await createTables();
    } catch (err) {
        console.error('[Database] Critical error during auto-init:', err.message);
    }

    const { prunePairingCodes } = require('./routes/devicePairing');
    prunePairingCodes();
    setInterval(prunePairingCodes, 60 * 60 * 1000).unref();

    const { pruneDeviceAuthCodes } = require('./db_init_cloud');
    pruneDeviceAuthCodes();
    setInterval(pruneDeviceAuthCodes, 60 * 60 * 1000).unref();

    try {
        if (LUXCLOUD_ACTIVE) {
            require('./jobs/cloudGc').startCloudJobs();
            require('./jobs/cloudRetention').startRetentionJob();
            require('./jobs/cloudExpiry').startExpiryJob();
        } else {
            console.log('[LuxCloud] Cloud jobs not started because Lux Cloud is off.');
        }
    } catch (err) {
        console.error('[LuxCloud] Could not start the cloud jobs:', err.message);
    }
});

