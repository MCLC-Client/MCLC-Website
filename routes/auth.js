const express = require('express');
const passport = require('passport');
const router = express.Router();

// Auth with Google
router.get('/google', passport.authenticate('google', {
    scope: ['profile', 'email']
}));

// Callback route for Google to redirect to
router.get('/google/callback', passport.authenticate('google'), (req, res) => {
    // Redirect to profile page after login
    res.redirect('/profile.html');
});

// Logout
router.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/');
    });
});

// Get Current User
router.get('/current_user', (req, res) => {
    res.json(req.user || {});
});

module.exports = router;
