require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const token = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const TURN_DURATION_MS = 30000; 

// --- RATING & ECONOMY ---
const RANKS = [
    { name: "Салага", min: 0 },
    { name: "Юнга", min: 500 },
    { name: "Матрос", min: 1500 },
    { name: "Старший матрос", min: 5000 },
    { name: "Боцман", min: 10000 },
    { name: "Первый помощник", min: 25000, penalty: 30 },
    { name: "Капитан", min: 50000, penalty: 60 },
    { name: "Легенда морей", min: 75000, reqStreak: 100, penalty: 100 }
];

const userDB = new Map();

function getUserData(userId) {
    if (!userDB.has(userId)) {
        // Добавили coins, inventory, equipped
        userDB.set(userId, { 
            xp: 0, matches: 0, wins: 0, streak: 0, coins: 100,
            name: 'Unknown', username: null,
            inventory: ['skin_white', 'bg_wood'], 
            equipped: { skin: 'skin_white', bg: 'bg_wood' }
        });
    }
    return userDB.get(userId);
}

function syncUserData(tgUser, savedData) {
    const userId = tgUser.id;
    const user = getUserData(userId);
    
    user.name = tgUser.first_name;
    user.username = tgUser.username ? tgUser.username.toLowerCase() : null;

    if (savedData) {
        if (typeof savedData.xp === 'number' && savedData.xp > user.xp) {
            user.xp = savedData.xp;
            user.streak = savedData.streak || 0;
        }
        if (savedData.coins) user.coins = savedData.coins;
        if (savedData.inventory) user.inventory = savedData.inventory;
        if (savedData.equipped) user.equipped = savedData.equipped;
    }
    userDB.set(userId, user);
    return user;
}

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

function updateUserXP(userId, type) {
    const user = getUserData(userId);
    const rankInfo = getRankInfo(user.xp, user.streak);
    const currentRank = rankInfo.current;

    if (type === 'win_game') {
        user.matches++; user.wins++; user.streak++;
        user.xp += 65;
        user.coins += 50; // За победу
    } 
    else if (type === 'lose_game') {
        user.matches++; user.streak = 0;
        if (currentRank.penalty) user.xp -= currentRank.penalty;
        user.coins += 10; // Утешительный приз
    }
    else if (type === 'kill_captain') {
        user.xp += 150;
        user.coins += 100; // Награда за голову
    }

    if (user.xp < 0) user.xp = 0;
    userDB.set(userId, user);
    return user;
}

// --- Bot ---
const bot = token ? new TelegramBot(token, { polling: true }) : null;
if (bot) {
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = (msg.text || '').trim();
        if (text.toLowerCase().includes('/start')) {
            const WEB_APP_URL = 'https://liarsdicezmss.onrender.com'; 
            const opts = { reply_markup: { inline_keyboard: [[{ text: "🎲 ИГРАТЬ", web_app: { url: WEB_APP_URL } }]] } };
            bot.sendMessage(chatId, "☠️ Костяшки: Теперь с Джокерами и Магазином!", opts).catch(e=>{});
        }
        // Админка (оставил упрощенную)
        if (msg.from.id === ADMIN_ID && text.startsWith('/addcoins')) {
            const parts = text.split(' ');
            // Логика начисления монет (аналогично setxp)
        }
    });
}

app.use(express.static(path.join(__dirname, 'public')));

// --- Game Logic ---
const rooms = new Map(); 
function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function rollDice(count) { return Array.from({length: count}, () => Math.floor(Math.random() * 6) + 1).sort((a,b)=>a-b); }
function getRoomBySocketId(id) { for (const [k,v] of rooms) if (v.players.find(p=>p.id===id)) return v; return null; }

function resetTurnTimer(room) {
    if (room.timerId) clearTimeout(room.timerId);
    const duration = room.config.time * 1000;
    room.turnDeadline = Date.now() + duration;
    room.timerId = setTimeout(() => handleTimeout(room), duration);
}

function handleTimeout(room) {
    if (room.status !== 'PLAYING') return;
    const loser = room.players[room.currentTurn];
    io.to(room.id).emit('gameEvent', { text: `⏳ ${loser.name} уснул и выбывает!`, type: 'error' });
    loser.diceCount = 0; 
    checkEliminationAndContinue(room, loser, null);
}

io.on('connection', (socket) => {
    // LOGIN
    socket.on('login', ({ tgUser, savedData }) => {
        if (!tgUser) return;
        const data = syncUserData(tgUser, savedData);
        const rank = getRankInfo(data.xp, data.streak);
        socket.tgUserId = tgUser.id;
        socket.emit('profileUpdate', { 
            ...data, 
            rankName: rank.current.name, 
            nextRankXP: rank.next?.min || 'MAX'
        });
    });

    // SHOP EVENTS
    socket.on('shopBuy', (itemId) => {
        if (!socket.tgUserId) return;
        const user = getUserData(socket.tgUserId);
        // Цены (хардкод для простоты)
        const PRICES = { 'skin_red': 200, 'skin_gold': 1000, 'bg_blue': 300 };
        const price = PRICES[itemId];
        
        if (price && user.coins >= price && !user.inventory.includes(itemId)) {
            user.coins -= price;
            user.inventory.push(itemId);
            userDB.set(socket.tgUserId, user);
            
            const rank = getRankInfo(user.xp, user.streak);
            socket.emit('profileUpdate', { ...user, rankName: rank.current.name, nextRankXP: rank.next?.min || 'MAX' });
            socket.emit('gameEvent', { text: 'Покупка успешна!', type: 'info' });
        }
    });

    socket.on('shopEquip', (itemId) => {
        if (!socket.tgUserId) return;
        const user = getUserData(socket.tgUserId);
        if (user.inventory.includes(itemId)) {
            if (itemId.startsWith('skin_')) user.equipped.skin = itemId;
            if (itemId.startsWith('bg_')) user.equipped.bg = itemId;
            userDB.set(socket.tgUserId, user);
            
            const rank = getRankInfo(user.xp, user.streak);
            socket.emit('profileUpdate', { ...user, rankName: rank.current.name, nextRankXP: rank.next?.min || 'MAX' });
        }
    });

    // EMOTES
    socket.on('sendEmote', (emoji) => {
        const room = getRoomBySocketId(socket.id);
        if (room) {
            io.to(room.id).emit('emoteReceived', { id: socket.id, emoji: emoji });
        }
    });

    // ROOMS
    socket.on('joinOrCreateRoom', ({ roomId, tgUser, options }) => {
        const old = getRoomBySocketId(socket.id);
        if (old) leaveRoom(socket, old);

        if (!tgUser) return;
        const userId = tgUser.id;
        const uData = getUserData(userId);
        const rInfo = getRankInfo(uData.xp, uData.streak);
        let room; let isCreator = false;

        if (roomId) {
            room = rooms.get(roomId);
            if (!room || room.status !== 'LOBBY' || room.players.length >= room.config.players) {
                socket.emit('errorMsg', 'Ошибка входа'); return;
            }
        } else {
            const newId = generateRoomId();
            // Настройки по умолчанию + Новые правила
            const st = options || { dice: 5, players: 10, time: 30, jokers: false, spot: false };
            room = {
                id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null,
                history: [], timerId: null, turnDeadline: 0, 
                config: { // Сохраняем конфиг
                    dice: st.dice, players: st.players, time: st.time,
                    jokers: st.jokers, spot: st.spot
                }
            };
            rooms.set(newId, room);
            roomId = newId;
            isCreator = true;
        }
        room.players.push({
            id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name,
            dice: [], diceCount: room.config.dice, ready: false, isCreator: isCreator,
            equipped: uData.equipped // Передаем скин игрока в комнату
        });
        socket.join(roomId);
        broadcastRoomUpdate(room);
    });

    socket.on('setReady', (isReady) => {
        const r = getRoomBySocketId(socket.id);
        if (r?.status === 'LOBBY') {
            const p = r.players.find(x => x.id === socket.id);
            if (p) { p.ready = isReady; broadcastRoomUpdate(r); }
        }
    });

    socket.on('startGame', () => {
        const r = getRoomBySocketId(socket.id);
        if (r) {
            const p = r.players.find(x => x.id === socket.id);
            if (p?.isCreator && r.players.length >= 2 && r.players.every(x => x.ready)) startNewRound(r, true);
        }
    });

    socket.on('makeBid', ({ quantity, faceValue }) => {
        const r = getRoomBySocketId(socket.id);
        if (!r || r.status !== 'PLAYING' || r.players[r.currentTurn].id !== socket.id) return;
        
        quantity = parseInt(quantity); faceValue = parseInt(faceValue);
        let valid = !r.currentBid ? (quantity>0 && faceValue>=1 && faceValue<=6) : 
            (quantity > r.currentBid.quantity || (quantity === r.currentBid.quantity && faceValue > r.currentBid.faceValue));

        // Правило джокера: нельзя ставить на единицы, если это не первая ставка (или если до этого не было единиц)
        // Упрощение: просто проверяем повышение.
        
        if (!valid) { socket.emit('errorMsg', 'Повысь ставку!'); return; }
        r.currentBid = { quantity, faceValue, playerId: socket.id };
        io.to(r.id).emit('gameEvent', { text: `${r.players[r.currentTurn].name} ставит: ${quantity}x[${faceValue}]`, type: 'info' });
        nextTurn(r);
    });

    // "НЕ ВЕРЮ"
    socket.on('callBluff', () => {
        handleCall(socket, 'bluff');
    });

    // "В ТОЧКУ" (Spot On)
    socket.on('callSpot', () => {
        handleCall(socket, 'spot');
    });

    function handleCall(socket, type) {
        const r = getRoomBySocketId(socket.id);
        if (!r || r.status !== 'PLAYING' || !r.currentBid || r.players[r.currentTurn].id !== socket.id) return;
        if (r.timerId) clearTimeout(r.timerId);

        const challenger = r.players[r.currentTurn];
        const bidder = r.players.find(x => x.id === r.currentBid.playerId);
        
        let total = 0; 
        const allDice = {};
        const targetFace = r.currentBid.faceValue;

        r.players.forEach(p => {
            if (p.diceCount > 0) {
                p.dice.forEach(d => { 
                    // ЛОГИКА ДЖОКЕРА
                    if (d === targetFace) total++;
                    else if (r.config.jokers && d === 1 && targetFace !== 1) total++; // Единицы считаются, если ставка не на 1
                });
                allDice[p.name] = p.dice;
            }
        });
        io.to(r.id).emit('revealDice', allDice);

        let loser, winnerOfRound, msg;

        if (type === 'bluff') {
            // Классика: если меньше, чем заявлено - лжец проиграл
            if (total < r.currentBid.quantity) {
                msg = `На столе ${total} (с Джокерами). Блеф! ${bidder.name} теряет куб.`; 
                loser = bidder; winnerOfRound = challenger;
            } else {
                msg = `На столе ${total} (с Джокерами). Ставка есть! ${challenger.name} теряет куб.`; 
                loser = challenger; winnerOfRound = bidder;
            }
        } else if (type === 'spot') {
            // В ТОЧКУ: должно быть ровно
            if (total === r.currentBid.quantity) {
                msg = `В ТОЧКУ! ${total} кубов! ${bidder.name} теряет куб за точность соперника.`; // Наказываем того, кто ставил, т.к. челленджер угадал
                loser = bidder; winnerOfRound = challenger;
            } else {
                msg = `Мимо! На столе ${total}. ${challenger.name} ошибся и теряет куб.`;
                loser = challenger; winnerOfRound = bidder;
            }
        }

        io.to(r.id).emit('roundResult', { message: msg });
        loser.diceCount--;
        
        setTimeout(() => checkEliminationAndContinue(r, loser, winnerOfRound), 4000);
    }

    socket.on('requestRestart', () => {
        const r = getRoomBySocketId(socket.id);
        if (r?.status === 'FINISHED') {
            r.status = 'LOBBY';
            r.players.forEach(p => { p.diceCount = r.config.dice; p.ready = false; p.dice = []; });
            r.currentBid = null;
            broadcastRoomUpdate(r);
        }
    });

    socket.on('disconnect', () => {
        const r = getRoomBySocketId(socket.id);
        if (r) leaveRoom(socket, r);
    });
});

// ... Helpers (checkElimination, leaveRoom, broadcastRoomUpdate и т.д. - БЕЗ ИЗМЕНЕНИЙ, только broadcastGame обновляет state) ...
// Я сокращу их для экономии места, но логика та же, просто добавляем config в broadcastRoomUpdate

function checkEliminationAndContinue(room, loser, killer) {
    if (loser.diceCount === 0) {
        io.to(room.id).emit('gameEvent', { text: `💀 ${loser.name} выбывает!`, type: 'error' });
        const d = updateUserXP(loser.tgId, 'lose_game');
        const rInfo = getRankInfo(d.xp, d.streak);
        io.to(loser.id).emit('profileUpdate', { ...d, rankName: rInfo.current.name, nextRankXP: rInfo.next?.min });

        if (killer && loser.rank === 'Капитан') {
            const kData = updateUserXP(killer.tgId, 'kill_captain');
            const kRank = getRankInfo(kData.xp, kData.streak);
            io.to(killer.id).emit('profileUpdate', { ...kData, rankName: kRank.current.name, nextRankXP: kRank.next?.min });
        }
    }

    const active = room.players.filter(p => p.diceCount > 0);
    if (active.length === 1) {
        const winner = active[0];
        room.status = 'FINISHED';
        if (room.timerId) clearTimeout(room.timerId);
        
        const d = updateUserXP(winner.tgId, 'win_game');
        const rInfo = getRankInfo(d.xp, d.streak);
        io.to(winner.id).emit('profileUpdate', { ...d, rankName: rInfo.current.name, nextRankXP: rInfo.next?.min });
        io.to(room.id).emit('gameOver', { winner: winner.name });
    } else {
        let idx = room.players.indexOf(loser);
        if (loser.diceCount === 0) do { idx = (idx + 1) % room.players.length; } while (room.players[idx].diceCount === 0);
        startNewRound(room, false, idx);
    }
}

function leaveRoom(socket, room) {
    const i = room.players.findIndex(p => p.id === socket.id);
    if (i !== -1) {
        const cr = room.players[i].isCreator;
        room.players.splice(i, 1);
        if (room.players.length === 0) { if(room.timerId) clearTimeout(room.timerId); rooms.delete(room.id); }
        else {
            if (cr) room.players[0].isCreator = true;
            if (room.status === 'PLAYING' && i === room.currentTurn) nextTurn(room);
            broadcastRoomUpdate(room);
        }
    }
}

function broadcastRoomUpdate(room) {
    io.to(room.id).emit('roomUpdate', {
        roomId: room.id,
        players: room.players.map(p => ({ 
            name: p.name, rank: p.rank, ready: p.ready, isCreator: p.isCreator, 
            diceCount: room.config.dice, id: p.id // id нужен для эмодзи
        })),
        status: room.status, 
        config: room.config
    });
}

function startNewRound(room, isFirst = false, startIdx = null) {
    room.status = 'PLAYING'; room.currentBid = null;
    room.players.forEach(p => {
        if (isFirst && p.diceCount === 0) p.diceCount = room.config.dice;
        p.dice = p.diceCount > 0 ? rollDice(p.diceCount) : [];
    });
    if (startIdx !== null) room.currentTurn = startIdx;
    else if (isFirst) room.currentTurn = 0;
    else nextTurn(room);
    while (room.players[room.currentTurn].diceCount === 0) room.currentTurn = (room.currentTurn + 1) % room.players.length;
    room.players.forEach(p => { if (p.diceCount > 0) io.to(p.id).emit('yourDice', p.dice); });
    io.to(room.id).emit('gameEvent', { text: `🎲 РАУНД!`, type: 'info' });
    broadcastGameState(room);
}

function nextTurn(room) {
    let l = 0; do { room.currentTurn = (room.currentTurn + 1) % room.players.length; l++; if(l>20)return; } while (room.players[room.currentTurn].diceCount === 0);
    resetTurnTimer(room); broadcastGameState(room);
}

function broadcastGameState(room) {
    io.to(room.id).emit('gameState', {
        players: room.players.map((p, i) => ({ name: p.name, rank: p.rank, diceCount: p.diceCount, isTurn: i === room.currentTurn, isEliminated: p.diceCount === 0, id: p.id })),
        currentBid: room.currentBid, 
        turnDeadline: room.turnDeadline,
        activeRules: { jokers: room.config.jokers, spot: room.config.spot }
    });
}

const PING_INTERVAL = 10 * 60 * 1000;
const MY_URL = 'https://liarsdicezmss.onrender.com';
setInterval(() => { https.get(MY_URL, (res) => {}).on('error', (err) => {}); }, PING_INTERVAL);

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
