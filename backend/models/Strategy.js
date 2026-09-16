const mongoose = require('mongoose');

const strategySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, { timestamps: true });

strategySchema.index({ userId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Strategy', strategySchema);
