const pool = require('./database');
async function migrate() {
    try {
        await pool.query('ALTER TABLE users ADD COLUMN is_private BOOLEAN DEFAULT FALSE;');
        console.log('Migration successful');
    } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
            console.log('Column already exists.');
        } else {
            console.error('Migration failed', err);
            process.exit(1);
        }
    }
    process.exit(0);
}
migrate();
