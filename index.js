require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const jubelioWebhookRoutes = require('./routes/jubelioWebhook');

const app = express();

connectDB();

app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/webhook/jubelio', jubelioWebhookRoutes);

app.get('/', (req, res) => {
    res.send('Jubelio to QBO Integration is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;