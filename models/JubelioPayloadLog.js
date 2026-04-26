// Audit log of raw Jubelio webhook payloads. One document per incoming webhook.
// Used for debugging date/channel/field discrepancies that aren't caught by
// JubelioOrderMap's summary fields.
//
// Retention: 30 days (TTL index). Adjust via `expireAfterSeconds` if needed.

const mongoose = require('mongoose');

const JubelioPayloadLogSchema = new mongoose.Schema({
    endpoint: { type: String, index: true },       // 'pesanan' | 'faktur'
    salesorder_id: { type: Number, index: true },
    salesorder_no: { type: String, index: true },
    invoice_no: String,
    action: String,
    status: String,
    is_canceled: Boolean,
    source_name: String,                            // channel (SHOPIFY, TOKOPEDIA, etc.)
    transaction_date_raw: String,                   // quick field for date-bug triage
    created_date_raw: String,
    invoice_created_date_raw: String,
    received_at: { type: Date, default: Date.now },
    payload: mongoose.Schema.Types.Mixed,           // full raw body
});

// TTL: auto-expire after 30 days so this collection doesn't grow unbounded.
// Single source of truth for the received_at index — `index: true` on the
// field would create a duplicate plain index that Mongoose warns about.
JubelioPayloadLogSchema.index(
    { received_at: 1 },
    { expireAfterSeconds: 30 * 86400 }
);

module.exports = mongoose.model('JubelioPayloadLog', JubelioPayloadLogSchema);
