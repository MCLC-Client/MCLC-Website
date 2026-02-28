const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'mclc_website',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});
(async () => {
    try {
        const connection = await pool.getConnection();
        console.log('[Database] Connected to MariaDB successfully!');
        connection.release();
    } catch (err) {
        console.error('[Database] CRITICAL: Error connecting to MariaDB!');
        console.error('[Database] Check your .env file and ensure MariaDB is running.');
        console.error('[Database] Error Details:', err.message);
    }
})();

module.exports = pool;