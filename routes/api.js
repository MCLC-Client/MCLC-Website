const express = require('express');
const router = express.Router();
const pool = require('../database');
const upload = require('../middleware/upload');

// Middleware to check if user is logged in
const ensureAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) {
        return next();
    }
    res.status(401).json({ error: 'Not authenticated' });
};

// Middleware to check if user is admin
const ensureAdmin = (req, res, next) => {
    if (req.isAuthenticated() && req.user.role === 'admin') {
        return next();
    }
    res.status(403).json({ error: 'Access denied' });
};

// --- USER ROUTES ---

// Update Profile
router.post('/user/update', ensureAuthenticated, async (req, res) => {
    const { username, bio, avatar } = req.body;
    try {
        await pool.query('UPDATE users SET username = ?, bio = ?, avatar = ? WHERE id = ?', [username, bio, avatar, req.user.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get User's Extensions
router.get('/user/extensions', ensureAuthenticated, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM extensions WHERE user_id = ?', [req.user.id]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- EXTENSION ROUTES ---

// Upload Extension
router.post('/extensions/upload', ensureAuthenticated, upload.fields([
    { name: 'extensionFile', maxCount: 1 },
    { name: 'bannerFile', maxCount: 1 }
]), async (req, res) => {
    const { name, identifier, summary, description, type, visibility } = req.body;

    const extensionFile = req.files['extensionFile'] ? req.files['extensionFile'][0] : null;
    const bannerFile = req.files['bannerFile'] ? req.files['bannerFile'][0] : null;

    if (!extensionFile) return res.status(400).json({ error: 'Extension file is required' });

    try {
        await pool.query(
            'INSERT INTO extensions (user_id, name, identifier, summary, description, type, visibility, file_path, banner_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                req.user.id,
                name,
                identifier || null,
                summary || null,
                description,
                type || 'extension',
                visibility || 'public',
                extensionFile.filename,
                bannerFile ? bannerFile.filename : null,
                'pending'
            ]
        );
        res.json({ success: true, message: 'Extension uploaded and pending approval' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List Approved Extensions (Public)
router.get('/extensions', async (req, res) => {
    const search = req.query.search;
    try {
        let query = `
            SELECT e.*, u.username as developer 
            FROM extensions e 
            JOIN users u ON e.user_id = u.id 
            WHERE e.status = 'approved'
        `;
        const params = [];

        if (search) {
            query += ` AND (e.name LIKE ? OR e.description LIKE ? OR u.username LIKE ?)`;
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ADMIN ROUTES ---

// List Pending Extensions
router.get('/admin/extensions/pending', ensureAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT e.*, u.username as developer 
            FROM extensions e 
            JOIN users u ON e.user_id = u.id 
            WHERE e.status = 'pending'
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Approve Extension
router.post('/admin/extensions/:id/approve', ensureAdmin, async (req, res) => {
    try {
        await pool.query('UPDATE extensions SET status = ? WHERE id = ?', ['approved', req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reject Extension
router.post('/admin/extensions/:id/reject', ensureAdmin, async (req, res) => {
    try {
        await pool.query('UPDATE extensions SET status = ? WHERE id = ?', ['rejected', req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
