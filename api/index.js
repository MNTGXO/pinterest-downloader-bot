'use strict';

// Route the root URL ( / ) through the same handler as /api/webhook.
// Vercel maps this file to both "/" via vercel.json routes.
module.exports = require('./webhook');
