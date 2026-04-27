const mongoose = require('mongoose');

const JubelioOrderMapSchema = new mongoose.Schema({
    salesorder_id: { type: Number, required: true, index: true },
    salesorder_no: { type: String, index: true },
    qbo_realm_id: { type: String, required: true, index: true },
    qbo_invoice_id: { type: String, required: true },
    qbo_doc_number: String,
    last_status: String,
    last_grand_total: Number,
    last_synced_at: { type: Date, default: Date.now },
    // Audit fields for date-correctness reconciliation. Stored on every upsert
    // so we can later compare what Jubelio sent vs what landed on QBO.
    last_transaction_date_raw: String,   // raw value from Jubelio webhook
    last_payment_date_raw: String,        // raw payment_date — TxnDate source of truth
    last_txn_date: String,                // YYYY-MM-DD computed (UTC+8 Jubelio TZ)
}, { timestamps: true });

// Compound unique so sandbox & production mappings can coexist for the same SO.
JubelioOrderMapSchema.index({ salesorder_id: 1, qbo_realm_id: 1 }, { unique: true });

module.exports = mongoose.model('JubelioOrderMap', JubelioOrderMapSchema);
