const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema({
    realmId: { type: String, required: true, unique: true },
    token_type: String,
    access_token: String,
    refresh_token: String,
    expires_in: Number,
    x_refresh_token_expires_in: Number,
    tokenCreatedAt: { type: Number, default: Date.now },

    // Optimistic concurrency: bumped on every refresh write so a stale
    // writer's CAS update returns null instead of clobbering a newer token.
    version: { type: Number, default: 0 },

    // Distributed refresh lock (TTL-style; expiry checked at acquire time,
    // so a crashed holder is auto-recovered without a TTL index).
    refreshLockHolder: { type: String, default: null },
    refreshLockExpiresAt: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Token', TokenSchema);
