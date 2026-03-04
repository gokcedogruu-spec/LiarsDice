const User = require('../models/User');
const { RANKS } = require('../config/constants');

// 1. Генерация случайного ID комнаты (например, AX72B)
function generateRoomId() { 
    return Math.random().toString(36).substring(2, 8).toUpperCase(); 
}

// 2. Бросок кубиков (создает массив случайных чисел от 1 до 6)
function rollDice(count) { 
    return Array.from({length: count}, () => Math.floor(Math.random() * 6) + 1).sort((a,b)=>a-b); 
}

// 3. Расчет информации о ранге на основе опыта (XP) и серии побед
function getRankInfo(xp, streak) {
    let current = RANKS[0]; 
    let next = null;
    for (let i = 0; i < RANKS.length; i++) {
        const r = RANKS[i];
        let match = false;
        if (r.name === "Легенда морей") { 
            if (xp >= r.min && streak >= r.reqStreak) match = true; 
        } else { 
            if (xp >= r.min) match = true; 
        }
        if (match) { 
            current = r; 
            next = RANKS[i+1] || null; 
        }
    }
    return { current, next };
}

// 4. Поиск ID пользователя по его никнейму (username)
async function findUserIdByUsername(input) {
    if (!input) return null;
    const target = input.toLowerCase().replace('@', '').trim();
    if (/^\d+$/.test(target)) {
        const idNum = parseInt(target);
        const u = await User.findOne({ id: idNum });
        return u ? u.id : null;
    }
    const u = await User.findOne({ username: new RegExp(`^${target}$`, 'i') });
    return u ? u.id : null;
}

// Экспортируем функции, чтобы сервер мог их вызвать
module.exports = { 
    generateRoomId, 
    rollDice, 
    getRankInfo, 
    findUserIdByUsername 
};
