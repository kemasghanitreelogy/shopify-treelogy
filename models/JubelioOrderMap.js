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
    // True when the SO carried a #UNPAID marker in `note` and the webhook
    // skipped auto-payment creation. Finance records the QBO Payment manually
    // when the customer actually pays. Audit-only flag.
    manual_payment: { type: Boolean, default: false },
    // Payment bookkeeping. Set when the webhook creates (or confirms) the QBO
    // Payment for this invoice. Without it the idempotent "skipped" path can't
    // tell "payment already done" from "payment never happened" — the gap that
    // left SHF-10704-128887 unpaid through the 2026-09-02 Intuit outage:
    // invoice created, run died at the payment step, and every later re-fire
    // took the skip path and skipped the payment along with it.
    qbo_payment_id: String,
    // Stamped once the skip path has verified the payment side, so a mapping
    // is reconciled at most once instead of re-querying QBO on every re-fire.
    payment_reconciled_at: Date,
}, { timestamps: true });

// Compound unique so sandbox & production mappings can coexist for the same SO.
JubelioOrderMapSchema.index({ salesorder_id: 1, qbo_realm_id: 1 }, { unique: true });

module.exports = mongoose.model('JubelioOrderMap', JubelioOrderMapSchema);
