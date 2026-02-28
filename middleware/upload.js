const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../public/uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit (V15)
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.zip', '.mclcextension', '.png', '.jpg', '.jpeg', '.webp'];
        const ext = path.extname(file.originalname).toLowerCase();

        if (allowedExtensions.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed. Only .zip and .mclcextension (and common images) are permitted.'));
        }
    }
});

module.exports = upload;
