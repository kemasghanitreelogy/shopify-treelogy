// Per-event failure counter so we only fire a Telegram alert AFTER Jubelio's
// retries are exhausted — not on the first failure.
//
// Jubelio retries a failed webhook (we return 500) by re-delivering the SAME
// payload as a fresh HTTP request. Our handler is stateless per request, so we
// cannot see an attempt number; instead we count failures here, keyed by the
// logical event (salesorder_id + status + action). A transient error that
// self-heals on retry never reaches the alert threshold; a genuinely stuck
// order fails every retry, hits the threshold, and alerts once.
//
// TTL: the doc auto-expires 30 min after the LAST failure (last_at is bumped on
// every increment). Retries all land within a few minutes, so 30 min is a safe
// margin; an unrelated failure hours later starts a fresh count.

const mongoose = require('mongoose');

const WebhookFailureSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, index: true },
    count: { type: Number, default: 0 },
    // True once we've fired the alert for this event, so repeated failures
    // past the threshold (or Jubelio retrying beyond 3x) don't re-alert.
    alerted: { type: Boolean, default: false },
    endpoint: String,
    last_error: String,
    first_at: { type: Date, default: Date.now },
    last_at: { type: Date, default: Date.now },
});

// Auto-clean 30 min after the last failure for this key.
WebhookFailureSchema.index({ last_at: 1 }, { expireAfterSeconds: 1800 });

module.exports = mongoose.model('WebhookFailure', WebhookFailureSchema);
