const mongoose = require('mongoose');

// Описание того, как выглядит игрок в базе данных
const userSchema = new mongoose.Schema({
    id: { type: Number, required: true, unique: true },
    name: String,
    username: String,
    xp: { type: Number, default: 0 },
    coins: { type: Number, default: 100 },
    matches: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    streak: { type: Number, default: 0 },
    lossStreak: { type: Number, default: 0 },
    matchHistory: { type: Array, default: [] },
    friends: { type: [Number], default: [] },
    requests: { type: [Number], default: [] },
    pendingInvites: { type: Array, default: [] },
    inventory: { type: [String], default: ['skin_white', 'bg_default', 'frame_default'] },
    equipped: {
        skin: { type: String, default: 'skin_white' },
        bg: { type: String, default: 'bg_default' },
        frame: { type: String, default: 'frame_default' },
        hat: { type: String, default: null }
    }
});

// Создаем модель и разрешаем её использовать
module.exports = mongoose.model('User', userSchema);
