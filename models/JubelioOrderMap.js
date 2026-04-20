const mongoose = require('mongoose');

const JubelioOrderMapSchema = new mongoose.Schema({
    salesorder_id: { type: Number, required: true, unique: true, index: true },
    salesorder_no: { type: String, index: true },
    qbo_realm_id: { type: String, required: true },
    qbo_invoice_id: { type: String, required: true },
    qbo_doc_number: String,
    last_status: String,
    last_grand_total: Number,
    last_synced_at: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('JubelioOrderMap', JubelioOrderMapSchema);
