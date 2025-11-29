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

// --- RATING SYSTEM ---
const RANKS = [
    { name: "Пороховая обезьяна", min: 0 },
    { name: "Юнга", min: 500 },
    { name: "Матрос", min: 1500 },
    { name: "Старший матрос", min: 5000 },
    { name: "Боцман", min: 10000 },
    { name: "Первый помощник", min: 25000, penalty: 30 }, // Штрафы начинаются отсюда
    { name: "Капитан", min: 50000, reqStreak: 100, penalty: 60 }
];

const userDB = new Map();

function getUserData(username) {
    if (!userDB.has(username)) {
        userDB.set(username, { xp: 0, matches: 0, wins: 0, streak: 0 });
    }
    return userDB.get(username);
}

function syncUserData(username, savedData) {
    const user = getUserData(username);
    if (savedData && typeof savedData.xp === 'number') {
        if (savedData.xp > user.xp) {
            user.xp = savedData.xp;
            user.streak = savedData.streak || 0;
        }
    }
    return user;
}

function getRankInfo(xp, streak) {
    let current = RANKS[0];
    let next = null;
    
    for (let i = 0; i < RANKS.length; i++) {
        const r = RANKS[i];
        let match = false;
        if (r.name === "Капитан") {
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

// Обновление XP после игры/раунда
function updateUserXP(username, type, extraData = {}) {
    const user = getUserData(username);
    const rankInfo = getRankInfo(user.xp, user.streak);
    const currentRank = rankInfo.current;

    if (type === 'win_game') {
        user.matches++;
        user.wins++;
        user.streak++;
        user.xp += 15; // Стандартная награда
    } 
    else if (type === 'lose_game') {
        user.matches++;
        user.streak = 0;
        // Штраф только если ранг подразумевает penalty
        if (currentRank.penalty) {
            user.xp -= currentRank.penalty;
        }
    }
    else if (type === 'kill_captain') {
        // Бонус за убийство капитана
        user.xp += 100;
    }

    if (user.xp < 0) user.xp = 0;
    userDB.set(username, user);
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
            bot.sendMessage(chatId, "☠️ Кости Лжеца: Обновление!", opts).catch(e=>console.log(e.message));
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
    // Используем настройку времени комнаты (или 30 сек по умолчанию)
    const duration = room.turnDuration || 30000;
    room.turnDeadline = Date.now() + duration;
    room.timerId = setTimeout(() => handleTimeout(room), duration);
}

function handleTimeout(room) {
    if (room.status !== 'PLAYING') return;
    const loser = room.players[room.currentTurn];
    io.to(room.id).emit('gameEvent', { text: `⏳ ${loser.name} проспал ход!`, type: 'error' });
    
    // Тайм-аут считается поражением в раунде, но убийцы нет (сам виноват)
    loser.diceCount--;
    checkEliminationAndContinue(room, loser, null);
}

io.on('connection', (socket) => {
    socket.on('login', ({ username, savedData }) => {
        const data = syncUserData(username, savedData);
        const rank = getRankInfo(data.xp, data.streak);
        socket.emit('profileUpdate', { ...data, rankName: rank.current.name, nextRankXP: rank.next?.min || 'MAX' });
    });

    socket.on('joinOrCreateRoom', ({ roomId, username, options }) => {
        const old = getRoomBySocketId(socket.id);
        if (old) leaveRoom(socket, old);

        const uData = getUserData(username);
        const rInfo = getRankInfo(uData.xp, uData.streak);
        let room; let isCreator = false;

        if (roomId) {
            room = rooms.get(roomId);
            if (!room || room.status !== 'LOBBY' || room.players.length >= room.maxPlayers) {
                socket.emit('errorMsg', 'Ошибка входа'); return;
            }
        } else {
            const newId = generateRoomId();
            // Настройки по умолчанию
            const st = options || { dice: 5, players: 10, time: 30 };
            room = {
                id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null,
                history: [], timerId: null, turnDeadline: 0, 
                maxPlayers: st.players, 
                initialDice: st.dice,
                turnDuration: (st.time || 30) * 1000 // Переводим сек в мс
            };
            rooms.set(newId, room);
            roomId = newId;
            isCreator = true;
        }
        room.players.push({
            id: socket.id, name: username, rank: rInfo.current.name,
            dice: [], diceCount: room.initialDice, ready: false, isCreator: isCreator
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

        if (!valid) { socket.emit('errorMsg', 'Повысь ставку!'); return; }
        r.currentBid = { quantity, faceValue, playerId: socket.id };
        io.to(r.id).emit('gameEvent', { text: `${r.players[r.currentTurn].name} ставит: ${quantity}x[${faceValue}]`, type: 'info' });
        nextTurn(r);
    });

    socket.on('callBluff', () => {
        const r = getRoomBySocketId(socket.id);
        if (!r || r.status !== 'PLAYING' || !r.currentBid || r.players[r.currentTurn].id !== socket.id) return;
        if (r.timerId) clearTimeout(r.timerId);

        const challenger = r.players[r.currentTurn]; // Тот кто не поверил
        const bidder = r.players.find(x => x.id === r.currentBid.playerId); // Тот кто ставил
        
        let total = 0; const allDice = {};
        r.players.forEach(p => {
            if (p.diceCount > 0) {
                p.dice.forEach(d => { if (d === r.currentBid.faceValue) total++; });
                allDice[p.name] = p.dice;
            }
        });
        io.to(r.id).emit('revealDice', allDice);

        let loser, winnerOfRound, msg;
        
        if (total < r.currentBid.quantity) {
            // Блеф раскрыт. Проиграл тот, кто ставил (bidder). Победил challenger.
            msg = `На столе ${total}x[${r.currentBid.faceValue}]. Блеф! ${bidder.name} -1 куб.`; 
            loser = bidder;
            winnerOfRound = challenger;
        } else {
            // Ставка сыграла. Проиграл тот, кто не поверил (challenger). Победил bidder.
            msg = `На столе ${total}x[${r.currentBid.faceValue}]. Правда! ${challenger.name} -1 куб.`; 
            loser = challenger;
            winnerOfRound = bidder;
        }

        io.to(r.id).emit('roundResult', { message: msg });
        loser.diceCount--;
        
        // Передаем "убийцу" для проверки бонуса за капитана
        setTimeout(() => checkEliminationAndContinue(r, loser, winnerOfRound), 4000);
    });

    socket.on('requestRestart', () => {
        const r = getRoomBySocketId(socket.id);
        if (r?.status === 'FINISHED') {
            r.status = 'LOBBY';
            r.players.forEach(p => { p.diceCount = r.initialDice; p.ready = false; p.dice = []; });
            r.currentBid = null;
            broadcastRoomUpdate(r);
        }
    });

    socket.on('disconnect', () => {
        const r = getRoomBySocketId(socket.id);
        if (r) leaveRoom(socket, r);
    });
});

function checkEliminationAndContinue(room, loser, killer) {
    // Если игрок выбыл
    if (loser.diceCount === 0) {
        io.to(room.id).emit('gameEvent', { text: `💀 ${loser.name} выбывает!`, type: 'error' });
        
        // 1. Снимаем рейтинг с проигравшего (если он высокого ранга)
        const d = updateUserXP(loser.name, 'lose_game');
        const rInfo = getRankInfo(d.xp, d.streak);
        io.to(loser.id).emit('profileUpdate', { ...d, rankName: rInfo.current.name, nextRankXP: rInfo.next?.min });

        // 2. Если выбывший был КАПИТАНОМ и есть конкретный убийца - даем бонус
        if (loser.rank === 'Капитан' && killer) {
            io.to(room.id).emit('gameEvent', { text: `💰 ${killer.name} получает +100 XP за голову Капитана!`, type: 'info' });
            const kData = updateUserXP(killer.name, 'kill_captain');
            const kRank = getRankInfo(kData.xp, kData.streak);
            io.to(killer.id).emit('profileUpdate', { ...kData, rankName: kRank.current.name, nextRankXP: kRank.next?.min });
        }
    }

    const active = room.players.filter(p => p.diceCount > 0);
    if (active.length === 1) {
        const winner = active[0];
        room.status = 'FINISHED';
        if (room.timerId) clearTimeout(room.timerId);
        
        // Награда за победу в матче
        const d = updateUserXP(winner.name, 'win_game');
        const rInfo = getRankInfo(d.xp, d.streak);
        io.to(winner.id).emit('profileUpdate', { ...d, rankName: rInfo.current.name, nextRankXP: rInfo.next?.min });
        
        io.to(room.id).emit('gameOver', { winner: winner.name });
    } else {
        // Следующий раунд
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
        players: room.players.map(p => ({ name: p.name, rank: p.rank, ready: p.ready, isCreator: p.isCreator, diceCount: room.initialDice })),
        status: room.status, 
        config: { 
            dice: room.initialDice, 
            players: room.maxPlayers,
            time: room.turnDuration / 1000 
        }
    });
}

function startNewRound(room, isFirst = false, startIdx = null) {
    room.status = 'PLAYING'; room.currentBid = null;
    room.players.forEach(p => {
        if (isFirst && p.diceCount === 0) p.diceCount = room.initialDice;
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
        players: room.players.map((p, i) => ({ name: p.name, rank: p.rank, diceCount: p.diceCount, isTurn: i === room.currentTurn, isEliminated: p.diceCount === 0 })),
        currentBid: room.currentBid, turnDeadline: room.turnDeadline
    });
}

// Anti-Sleep
const PING_INTERVAL = 10 * 60 * 1000;
const MY_URL = 'https://liarsdicezmss.onrender.com';
setInterval(() => { https.get(MY_URL, (res) => {}).on('error', (err) => {}); }, PING_INTERVAL);

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
