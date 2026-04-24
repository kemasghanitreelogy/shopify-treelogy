require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const jubelioWebhookRoutes = require('./routes/jubelioWebhook');
const codeRoutes = require('./routes/generateCode');

const app = express();

app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// Ensure MongoDB is connected on EVERY request (Vercel serverless cold starts).
// Without this, handlers can fire before mongoose is ready → 10s buffer timeout → 500.
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (err) {
        console.error('❌ DB connect error:', err.message);
        res.status(503).send('Database unavailable');
    }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/webhook/jubelio', jubelioWebhookRoutes);
app.use('/api/codes', codeRoutes);

app.get('/', (req, res) => {
    res.send('Jubelio to QBO Integration is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;