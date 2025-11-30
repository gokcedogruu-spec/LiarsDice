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

// --- RATING SYSTEM ---
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
        userDB.set(userId, { 
            xp: 0, matches: 0, wins: 0, streak: 0, coins: 100,
            name: 'Unknown', username: null,
            inventory: ['skin_white', 'bg_wood', 'frame_default'], 
            equipped: { skin: 'skin_white', bg: 'bg_wood', frame: 'frame_default' }
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
        if (match) { current = r; next = RANKS[i+1] || null; }
    }
    return { current, next };
}

function updateUserXP(userId, type, difficulty = null) {
    if (typeof userId === 'string' && userId.startsWith('bot')) return null;
    const user = getUserData(userId);
    const rankInfo = getRankInfo(user.xp, user.streak);
    const currentRank = rankInfo.current;

    if (type === 'win_game') {
        user.matches++; user.wins++; user.streak++;
        user.xp += 65; user.coins += 50;
    } 
    else if (type === 'lose_game') {
        user.matches++; user.streak = 0;
        if (currentRank.penalty) user.xp -= currentRank.penalty;
        user.coins += 10;
    }
    else if (type === 'kill_captain') {
        user.xp += 150; user.coins += 100;
    }
    else if (type === 'win_pve') {
        user.matches++;
        if (difficulty === 'medium') { user.xp += 10; user.coins += 10; }
        else if (difficulty === 'pirate') { user.xp += 40; user.coins += 40; }
    }

    if (user.xp < 0) user.xp = 0;
    userDB.set(userId, user);
    return user;
}

// --- HELPER: Find User ---
function findUserIdByUsername(input) {
    const target = input.toLowerCase().replace('@', '');
    if (/^\d+$/.test(target)) {
        const idNum = parseInt(target);
        if (userDB.has(idNum)) return idNum;
    }
    for (const [uid, uData] of userDB.entries()) {
        if (uData.username === target) return uid;
    }
    return null;
}

function findSocketIdByUserId(uid) {
    for (const [roomId, room] of rooms) {
        const p = room.players.find(pl => pl.tgId === uid);
        if (p) return p.id;
    }
    return null;
}

function pushProfileUpdate(userId) {
    const socketId = findSocketIdByUserId(userId);
    if (socketId) {
        const user = userDB.get(userId);
        const rInfo = getRankInfo(user.xp, user.streak);
        io.to(socketId).emit('profileUpdate', { 
            ...user, 
            rankName: rInfo.current.name, 
            nextRankXP: rInfo.next?.min 
        });
    }
}

// --- BOT COMMANDS ---
const bot = token ? new TelegramBot(token, { polling: true }) : null;
if (bot) {
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = (msg.text || '').trim();
        const fromId = msg.from.id;

        if (text.toLowerCase().startsWith('/start') && !text.startsWith('/s') && !text.startsWith('/r') && !text.startsWith('/k') && !text.startsWith('/w')) {
            const WEB_APP_URL = 'https://liarsdicezmss.onrender.com'; 
            const opts = { reply_markup: { inline_keyboard: [[{ text: "🎲 ИГРАТЬ", web_app: { url: WEB_APP_URL } }]] } };
            bot.sendMessage(chatId, "☠️ Костяшки: Врывайся в игру!", opts).catch(()=>{});
            return;
        }

        if (fromId !== ADMIN_ID) return;

        const args = text.split(' ');
        const cmd = args[0].toLowerCase();

        if (cmd === '/setxp') {
            if (args.length < 3) return bot.sendMessage(chatId, "⚠️ /setxp @user 5000");
            const uid = findUserIdByUsername(args[1]);
            if (!uid) return bot.sendMessage(chatId, "❌ Игрок не найден.");
            const user = userDB.get(uid);
            user.xp = parseInt(args[2]);
            if (user.xp >= 75000) user.streak = 100;
            userDB.set(uid, user);
            pushProfileUpdate(uid);
            bot.sendMessage(chatId, `✅ XP игрока ${user.name}: ${user.xp}`);
        }
        else if (cmd === '/setcoins') {
            if (args.length < 3) return bot.sendMessage(chatId, "⚠️ /setcoins @user 1000");
            const uid = findUserIdByUsername(args[1]);
            if (!uid) return bot.sendMessage(chatId, "❌ Игрок не найден.");
            const user = userDB.get(uid);
            user.coins = parseInt(args[2]);
            userDB.set(uid, user);
            pushProfileUpdate(uid);
            bot.sendMessage(chatId, `✅ Монеты игрока ${user.name}: ${user.coins}`);
        }
        else if (cmd === '/reset') {
            if (args.length < 2) return bot.sendMessage(chatId, "⚠️ /reset @user");
            const uid = findUserIdByUsername(args[1]);
            if (!uid) return bot.sendMessage(chatId, "❌ Игрок не найден.");
            const user = userDB.get(uid);
            user.xp = 0; user.coins = 0; user.wins = 0; user.matches = 0; user.streak = 0;
            user.inventory = ['skin_white', 'bg_wood', 'frame_default'];
            user.equipped = { skin: 'skin_white', bg: 'bg_wood', frame: 'frame_default' };
            userDB.set(uid, user);
            pushProfileUpdate(uid);
            bot.sendMessage(chatId, `♻️ Игрок ${user.name} обнулен.`);
        }
        else if (cmd === '/kick') {
            if (args.length < 2) return bot.sendMessage(chatId, "⚠️ /kick @user");
            const uid = findUserIdByUsername(args[1]);
            if (!uid) return bot.sendMessage(chatId, "❌ Игрок не найден.");
            const socketId = findSocketIdByUserId(uid);
            if (socketId) {
                const room = getRoomBySocketId(socketId);
                if (room) {
                    leaveRoom({ id: socketId }, room);
                    io.to(socketId).emit('errorMsg', 'Админ выкинул вас со стола!');
                    pushProfileUpdate(uid);
                    bot.sendMessage(chatId, `👢 Игрок ${userDB.get(uid).name} кикнут.`);
                } else bot.sendMessage(chatId, "⚠️ Игрок не в комнате.");
            } else bot.sendMessage(chatId, "⚠️ Игрок оффлайн.");
        }
        else if (cmd === '/win') {
            const socketId = findSocketIdByUserId(ADMIN_ID);
            if (!socketId) return bot.sendMessage(chatId, "❌ Ты не в игре.");
            const room = getRoomBySocketId(socketId);
            if (!room || room.status !== 'PLAYING') return bot.sendMessage(chatId, "❌ Игра не идет.");
            
            room.players.forEach(p => { if (p.id !== socketId) p.diceCount = 0; });
            checkEliminationAndContinue(room, { diceCount: 0, isBot: true }, null); 
            bot.sendMessage(chatId, "🏆 Победа присуждена!");
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
    
    // Получаем длительность хода из конфига (или 30 сек по умолчанию)
    const duration = (room.config && room.config.time) ? room.config.time * 1000 : 30000;
    room.turnDuration = duration; // Сохраняем для отправки
    room.turnDeadline = Date.now() + duration;
    
    const currentPlayer = room.players[room.currentTurn];
    if (currentPlayer.isBot) {
        const thinkTime = Math.random() * 2000 + 2000;
        room.timerId = setTimeout(() => handleBotMove(room), thinkTime);
    } else {
        room.timerId = setTimeout(() => handleTimeout(room), duration);
    }
}

function handleTimeout(room) {
    if (room.status !== 'PLAYING') return;
    const loser = room.players[room.currentTurn];
    io.to(room.id).emit('gameEvent', { text: `⏳ ${loser.name} уснул и выбывает!`, type: 'error' });
    loser.diceCount = 0; 
    checkEliminationAndContinue(room, loser, null);
}

function handleBotMove(room) {
    if (room.status !== 'PLAYING') return;
    const bot = room.players[room.currentTurn];
    const lastBid = room.currentBid;
    let totalDiceInGame = 0; room.players.forEach(p => totalDiceInGame += p.diceCount);
    const myHand = {}; bot.dice.forEach(d => myHand[d] = (myHand[d] || 0) + 1);
    
    const diff = room.config.difficulty;
    if (!lastBid) {
        const face = bot.dice[0] || Math.floor(Math.random()*6)+1;
        makeBidInternal(room, bot, 1, face);
        return;
    }
    const needed = lastBid.quantity; const face = lastBid.faceValue;
    const inHand = myHand[face] || 0;
    const inHandJokers = room.config.jokers ? (myHand[1] || 0) : 0;
    const mySupport = (face === 1 && room.config.jokers) ? inHand : (inHand + (face !== 1 ? inHandJokers : 0));
    const unknownDice = totalDiceInGame - bot.diceCount;
    const probPerDie = room.config.jokers ? (face===1 ? 1/6 : 2/6) : 1/6;
    const expectedTotal = mySupport + (unknownDice * probPerDie);

    let threshold = 0;
    if (diff === 'easy') threshold = 2.0; 
    if (diff === 'medium') threshold = 0.5; 
    if (diff === 'pirate') threshold = -0.5; 

    if (needed > expectedTotal + threshold) {
        if (diff === 'pirate' && Math.abs(expectedTotal - needed) < 0.5 && room.config.spot && Math.random() > 0.7) handleCall(null, 'spot', room, bot);
        else handleCall(null, 'bluff', room, bot);
    } else {
        let nextQty = lastBid.quantity; let nextFace = lastBid.faceValue + 1;
        if (nextFace > 6) { nextFace = 2; nextQty++; }
        if (diff === 'pirate' && Math.random() > 0.8) nextQty++; 
        makeBidInternal(room, bot, nextQty, nextFace);
    }
}

function makeBidInternal(room, player, quantity, faceValue) {
    if (room.currentBid) {
        if (quantity < room.currentBid.quantity) quantity = room.currentBid.quantity + 1;
        else if (
