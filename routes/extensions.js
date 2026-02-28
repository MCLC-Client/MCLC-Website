// routes/extensions.js - Ergänzung

// POST /api/extensions/:identifier/download - Increment download count
router.post('/api/extensions/:identifier/download', async (req, res) => {
    const { identifier } = req.params;
    
    try {
        const db = req.app.locals.db;
        
        // Increment downloads in extensions table
        await db.run(
            'UPDATE extensions SET downloads = downloads + 1 WHERE identifier = ?',
            [identifier]
        );
        
        // Also increment for latest version if versions table exists
        try {
            await db.run(
                `UPDATE extension_versions 
                 SET downloads = downloads + 1 
                 WHERE extension_id = (SELECT id FROM extensions WHERE identifier = ?)
                 ORDER BY created_at DESC LIMIT 1`,
                [identifier]
            );
        } catch (e) {
            // Versions table might not exist
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Failed to increment download count:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});