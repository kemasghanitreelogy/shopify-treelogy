const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema({
    realmId: { type: String, required: true, unique: true },
    token_type: String,
    access_token: String,
    refresh_token: String,
    expires_in: Number,
    x_refresh_token_expires_in: Number,
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Token', TokenSchema);