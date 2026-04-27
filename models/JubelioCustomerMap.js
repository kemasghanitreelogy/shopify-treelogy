// Stable mapping between Jubelio's marketplace buyer_id and the QBO Customer
// record. Lets the integration recognize a customer across name changes —
// finance can rename "A*** y***nto" (redacted Tokopedia name) to
// "TP - Adha Yuwanto" in QBO without breaking future syncs, because lookup
// happens by (source, buyer_id) which Jubelio always sends and never
// changes per buyer per channel.
//
// Example:
//   { source: "TOKOPEDIA", buyer_id: "7495927190329330618", qbo_customer_id: "14324" }

const mongoose = require('mongoose');

const JubelioCustomerMapSchema = new mongoose.Schema({
    source: { type: String, required: true, index: true },          // 'TOKOPEDIA' | 'SHOPEE' | 'TT' | etc
    buyer_id: { type: String, required: true, index: true },        // marketplace user id from Jubelio
    qbo_realm_id: { type: String, required: true, index: true },
    qbo_customer_id: { type: String, required: true },

    // Audit fields — useful when investigating why a customer mapping points
    // somewhere unexpected (e.g. finance re-merged customers in QBO).
    last_seen_at: { type: Date, default: Date.now },
    last_so_no: String,
    last_customer_name_jubelio: String,                              // raw redacted name from webhook
    last_customer_name_qbo: String,                                  // resolved/manual-renamed QBO DisplayName
}, { timestamps: true });

// One mapping per (source, buyer_id, realm). Sandbox & prod can coexist.
JubelioCustomerMapSchema.index(
    { source: 1, buyer_id: 1, qbo_realm_id: 1 },
    { unique: true }
);

module.exports = mongoose.model('JubelioCustomerMap', JubelioCustomerMapSchema);
