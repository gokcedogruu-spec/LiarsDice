const User = require('../models/User');
const { getRankInfo } = require('../utils/helpers');

// Хранилище данных в оперативной памяти (кеш)
const userCache = new Map();

// Хранилище связей: Telegram ID -> ID сокета
const userSockets = new Map();

// 1. Привязать сокет к пользователю
function addUserSocket(userId, socketId) {
    let set = userSockets.get(userId);
    if (!set) {
        set = new Set();
        userSockets.set(userId, set);
    }
    set.add(socketId);
}

// 2. Отвязать сокет (при выходе)
function removeUserSocket(userId, socketId) {
    const set = userSockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) userSockets.delete(userId);
}

// 3. Найти сокет по ID пользователя
function findSocketIdByUserId(uid) {
    const set = userSockets.get(uid);
    if (!set || set.size === 0) return null;
    return set.values().next().value;
}

// 4. Загрузить пользователя из базы в кеш
async function loadUser(tgUser) {
    let user = await User.findOne({ id: tgUser.id });
    if (!user) {
        user = new User({ 
            id: tgUser.id, 
            name: tgUser.first_name, 
            username: tgUser.username ? tgUser.username.toLowerCase() : null 
        });
        await user.save();
    } else {
        if (user.name !== tgUser.first_name || user.username !== (tgUser.username ? tgUser.username.toLowerCase() : null)) {
            user.name = tgUser.first_name;
            user.username = tgUser.username ? tgUser.username.toLowerCase() : null;
            await user.save();
        }
    }
    const uObj = user.toObject();
    userCache.set(tgUser.id, uObj);
    return uObj;
}

// 5. Сохранить данные пользователя из кеша в базу
async function saveUser(userId) {
    const data = userCache.get(userId);
    if (data) {
        const { _id, ...updateData } = data;
        await User.updateOne({ id: userId }, updateData);
    }
}

module.exports = {
    userCache,
    userSockets,
    addUserSocket,
    removeUserSocket,
    findSocketIdByUserId,
    loadUser,
    saveUser
};
