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
const ADMIN_ID = parseInt(process.env.ADMIN_ID); // Убедись, что в .env есть ADMIN_ID=твои_цифры

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

// --- HELPER: Найти ID по username ---
function findUserIdByUsername(input) {
    const target = input.toLowerCase().replace('@', '');
    // Если ввели ID
    if (/^\d+$/.test(target)) {
        const idNum = parseInt(target);
        if (userDB.has(idNum)) return idNum;
    }
    // Если ввели username
    for (const [uid, uData] of userDB.entries()) {
        if (uData.username === target) return uid;
    }
    return null;
}

function findSocketIdByUserId(uid) {
    // Ищем сокет в комнатах (если игрок в игре)
    for (const [roomId, room] of rooms) {
        const p = room.players.find(pl => pl.tgId === uid);
        if (p) return p.id;
    }
    // Или можно было бы хранить маппинг, но так тоже норм
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

        // Обычная команда
        if (text.toLowerCase().startsWith('/start') && !text.startsWith('/s')) {
            const WEB_APP_URL = 'https://liarsdicezmss.onrender.com'; 
            const opts = { reply_markup: { inline_keyboard: [[{ text: "🎲 ИГРАТЬ", web_app: { url: WEB_APP_URL } }]] } };
            bot.sendMessage(chatId, "☠️ Костяшки: Врывайся в игру!", opts).catch(()=>{});
            return;
        }

        // --- ADMIN ONLY ---
        if (fromId !== ADMIN_ID) return;

        const args = text.split(' ');
        const cmd = args[0].toLowerCase();

        // 1. /setxp @user 5000
        if (cmd === '/setxp') {
            if (args.length < 3) return bot.sendMessage(chatId, "⚠️ /setxp @user 5000");
            const uid = findUserIdByUsername(args[1]);
            if (!uid) return bot.sendMessage(chatId, "❌ Игрок не найден (пусть зайдет в игру).");
            
            const user = userDB.get(uid);
            user.xp = parseInt(args[2]);
            if (user.xp >= 75000) user.streak = 100; // Бонус для Легенды
            userDB.set(uid, user);
            pushProfileUpdate(uid);
            bot.sendMessage(chatId, `✅ XP игрока ${user.name}: ${user.xp}`);
        }

        // 2. /setcoins @user 1000
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

        // 3. /reset @user
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

        // 4. /kick @user
        else if (cmd === '/kick') {
            if (args.length < 2) return bot.sendMessage(chatId, "⚠️ /kick @user");
            const uid = findUserIdByUsername(args[1]);
            if (!uid) return bot.sendMessage(chatId, "❌ Игрок не найден.");
            
            const socketId = findSocketIdByUserId(uid);
            if (socketId) {
                // Ищем комнату
                const room = getRoomBySocketId(socketId);
                if (room) {
                    leaveRoom({ id: socketId }, room); // Эмулируем выход
                    // Отправляем клиенту сообщение, чтобы его выкинуло в меню
                    io.to(socketId).emit('errorMsg', 'Админ выкинул вас со стола!');
                    io.to(socketId).emit('profileUpdate', userDB.get(uid)); // Триггер перехода в меню (костыль, но сработает)
                    bot.sendMessage(chatId, `👢 Игрок ${userDB.get(uid).name} кикнут.`);
                } else {
                    bot.sendMessage(chatId, "⚠️ Игрок онлайн, но не в комнате.");
                }
            } else {
                bot.sendMessage(chatId, "⚠️ Игрок оффлайн.");
            }
        }

        // 5. /win (Моментальная победа для СЕБЯ)
        else if (cmd === '/win') {
            const socketId = findSocketIdByUserId(ADMIN_ID); // Ищем админа в игре
            if (!socketId) return bot.sendMessage(chatId, "❌ Ты не в игре.");
            
            const room = getRoomBySocketId(socketId);
            if (!room || room.status !== 'PLAYING') return bot.sendMessage(chatId, "❌ Игра не идет.");

            // Находим админа в комнате
            const adminPlayer = room.players.find(p => p.id === socketId);
            
            // Убиваем всех остальных (diceCount = 0)
            room.players.forEach(p => {
                if (p.id !== socketId) p.diceCount = 0;
            });

            // Вызываем проверку, которая увидит, что остался 1 живой (Админ) и присудит победу
            checkEliminationAndContinue(room, { diceCount: 0, isBot: true }, null); // Фейковый лузер, чтобы триггернуть
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
    const duration = room.config.time * 1000;
    room.turnDeadline = Date.now() + duration;
    
    const currentPlayer = room.players[room.currentTurn];
    if (currentPlayer.isBot) {
        const thinkTime = Math.random() * 3000 + 2000;
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

// ... (Bot AI: handleBotMove, makeBidInternal, handleCall - без изменений, скопируй из прошлого ответа или оставь) ...
// Чтобы код влез, я сократил AI часть, она такая же, как была.
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

    if (needed > expectedTotal + (diff==='easy'?2:0)) {
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
        if (quantity === room.currentBid.quantity && faceValue <= room.currentBid.faceValue) faceValue = room.currentBid.faceValue + 1;
    }
    if (faceValue > 6) { faceValue = 2; quantity++; }
    room.currentBid = { quantity, faceValue, playerId: player.id };
    io.to(room.id).emit('gameEvent', { text: `${player.name} ставит: ${quantity}x[${faceValue}]`, type: 'info' });
    nextTurn(room);
}

function handleCall(socket, type, roomOverride = null, playerOverride = null) {
    const r = roomOverride || getRoomBySocketId(socket.id);
    if (!r || r.status !== 'PLAYING' || !r.currentBid) return;
    
    const challenger = playerOverride || r.players[r.players.findIndex(p => p.id === socket.id)];
    if (r.players[r.currentTurn].id !== challenger.id) return;
    if (r.timerId) clearTimeout(r.timerId);

    const bidder = r.players.find(x => x.id === r.currentBid.playerId);
    let total = 0; const allDice = {}; const targetFace = r.currentBid.faceValue;

    r.players.forEach(p => {
        if (p.diceCount > 0) {
            p.dice.forEach(d => { 
                if (d === targetFace) total++;
                else if (r.config.jokers && d === 1 && targetFace !== 1) total++;
            });
            allDice[p.name] = p.dice;
        }
    });
    io.to(r.id).emit('revealDice', allDice);

    let loser, winnerOfRound, msg;
    if (type === 'bluff') {
        if (total < r.currentBid.quantity) {
            msg = `На столе ${total}. Блеф! ${bidder.name} теряет куб.`; loser = bidder; winnerOfRound = challenger;
        } else {
            msg = `На столе ${total}. Ставка есть! ${challenger.name} теряет куб.`; loser = challenger; winnerOfRound = bidder;
        }
    } else if (type === 'spot') {
        if (total === r.currentBid.quantity) {
            msg = `В ТОЧКУ! ${total} кубов! ${bidder.name} теряет куб.`; loser = bidder; winnerOfRound = challenger;
        } else {
            msg = `Мимо! На столе ${total}. ${challenger.name} теряет куб.`; loser = challenger; winnerOfRound = bidder;
        }
    }

    io.to(r.id).emit('roundResult', { message: msg });
    loser.diceCount--;
    setTimeout(() => checkEliminationAndContinue(r, loser, winnerOfRound), 4000);
}

io.on('connection', (socket) => {
    socket.on('login', ({ tgUser, savedData }) => {
        if (!tgUser) return;
        const data = syncUserData(tgUser, savedData);
        const rank = getRankInfo(data.xp, data.streak);
        socket.tgUserId = tgUser.id;
        socket.emit('profileUpdate', { ...data, rankName: rank.current.name, nextRankXP: rank.next?.min || 'MAX' });
    });

    socket.on('shopBuy', (itemId) => {
        if (!socket.tgUserId) return;
        const user = getUserData(socket.tgUserId);
        const PRICES = { 'skin_red': 200, 'skin_gold': 1000, 'bg_blue': 300, 'frame_gold': 500, 'frame_fire': 1500 };
        const price = PRICES[itemId];
        if (price && user.coins >= price && !user.inventory.includes(itemId)) {
            user.coins -= price; user.inventory.push(itemId); userDB.set(socket.tgUserId, user);
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
            if (itemId.startsWith('frame_')) user.equipped.frame = itemId;
            userDB.set(socket.tgUserId, user);
            const rank = getRankInfo(user.xp, user.streak);
            socket.emit('profileUpdate', { ...user, rankName: rank.current.name, nextRankXP: rank.next?.min || 'MAX' });
        }
    });

    socket.on('joinOrCreateRoom', ({ roomId, tgUser, options, mode }) => {
        const old = getRoomBySocketId(socket.id);
        if (old) leaveRoom(socket, old);

        if (!tgUser) return;
        const userId = tgUser.id;
        const uData = getUserData(userId);
        const rInfo = getRankInfo(uData.xp, uData.streak);
        let room; let isCreator = false;

        if (mode === 'pve') {
            const newId = 'CPU_' + Math.random().toString(36).substring(2,6);
            const diff = options.difficulty || 'easy';
            const botCount = options.players - 1;
            room = {
                id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null,
                history: [], timerId: null, turnDeadline: 0, 
                config: { dice: options.dice, players: options.players, time: 30, jokers: options.jokers, spot: options.spot, difficulty: diff },
                isPvE: true
            };
            rooms.set(newId, room);
            room.players.push({
                id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name,
                dice: [], diceCount: room.config.dice, ready: true, isCreator: true, equipped: uData.equipped
            });
            const botNames = ['Джек', 'Барбосса', 'Уилл', 'Дейви Джонс', 'Тич', 'Гиббс'];
            for(let i=0; i<botCount; i++) {
                room.players.push({
                    id: 'bot_' + Math.random(), name: `${botNames[i%botNames.length]} (Бот)`,
                    rank: diff === 'pirate' ? 'Капитан' : 'Матрос', dice: [], diceCount: room.config.dice, ready: true, isCreator: false, isBot: true, equipped: { frame: 'frame_default' }
                });
            }
            socket.join(newId); startNewRound(room, true); return;
        }

        if (roomId) {
            room = rooms.get(roomId);
            if (!room || room.status !== 'LOBBY' || room.players.length >= room.config.players) {
                socket.emit('errorMsg', 'Ошибка входа'); return;
            }
        } else {
            const newId = generateRoomId();
            const st = options || { dice: 5, players: 10, time: 30, jokers: false, spot: false };
            room = {
                id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null,
                history: [], timerId: null, turnDeadline: 0, 
                config: { dice: st.dice, players: st.players, time: st.time, jokers: st.jokers, spot: st.spot },
                isPvE: false
            };
            rooms.set(newId, room);
            roomId = newId;
            isCreator = true;
        }
        room.players.push({
            id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name,
            dice: [], diceCount: room.config.dice, ready: false, isCreator: isCreator, equipped: uData.equipped
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
        makeBidInternal(r, r.players[r.currentTurn], parseInt(quantity), parseInt(faceValue));
    });

    socket.on('callBluff', () => handleCall(socket, 'bluff'));
    socket.on('callSpot', () => handleCall(socket, 'spot'));

    socket.on('requestRestart', () => {
        const r = getRoomBySocketId(socket.id);
        if (r?.status === 'FINISHED') {
            if (r.isPvE) {
                r.status = 'PLAYING';
                r.players.forEach(p => { p.diceCount = r.config.dice; p.dice = []; });
                r.currentBid = null;
                startNewRound(r, true);
            } else {
                r.status = 'LOBBY';
                r.players.forEach(p => { p.diceCount = r.config.dice; p.ready = false; p.dice = []; });
                r.currentBid = null;
                broadcastRoomUpdate(r);
            }
        }
    });

    socket.on('disconnect', () => {
        const r = getRoomBySocketId(socket.id);
        if (r) leaveRoom(socket, r);
    });
});

function checkEliminationAndContinue(room, loser, killer) {
    if (loser.diceCount === 0) {
        if (!loser.isBot) {
            const d = updateUserXP(loser.tgId, room.isPvE ? 'lose_pve' : 'lose_game');
            if(d) {
                const rInfo = getRankInfo(d.xp, d.streak);
                io.to(loser.id).emit('profileUpdate', { ...d, rankName: rInfo.current.name, nextRankXP: rInfo.next?.min });
            }
        }
        io.to(room.id).emit('gameEvent', { text: `💀 ${loser.name} выбывает!`, type: 'error' });
    }

    const active = room.players.filter(p => p.diceCount > 0);
    if (active.length === 1) {
        const winner = active[0];
        room.status = 'FINISHED';
        if (room.timerId) clearTimeout(room.timerId);
        
        if (!winner.isBot) {
            const type = room.isPvE ? 'win_pve' : 'win_game';
            const diff = room.isPvE ? room.config.difficulty : null;
            const d = updateUserXP(winner.tgId, type, diff);
            if(d) {
                const rInfo = getRankInfo(d.xp, d.streak);
                io.to(winner.id).emit('profileUpdate', { ...d, rankName: rInfo.current.name, nextRankXP: rInfo.next?.min });
            }
        }
        
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
        if (room.players.filter(p => !p.isBot).length === 0) { 
            if(room.timerId) clearTimeout(room.timerId); rooms.delete(room.id); 
        } else {
            if (cr && room.players[0]) room.players[0].isCreator = true;
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
            diceCount: room.config.dice, id: p.id, equipped: p.equipped
        })),
        status: room.status, config: room.config, isPvE: room.isPvE
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
    room.players.forEach(p => { if (p.diceCount > 0 && !p.isBot) io.to(p.id).emit('yourDice', p.dice); });
    io.to(room.id).emit('gameEvent', { text: `🎲 РАУНД!`, type: 'info' });
    broadcastGameState(room);
}

function nextTurn(room) {
    let l = 0; do { room.currentTurn = (room.currentTurn + 1) % room.players.length; l++; if(l>20)return; } while (room.players[room.currentTurn].diceCount === 0);
    resetTurnTimer(room); broadcastGameState(room);
}

function broadcastGameState(room) {
    io.to(room.id).emit('gameState', {
        players: room.players.map((p, i) => ({ 
            name: p.name, rank: p.rank, diceCount: p.diceCount, 
            isTurn: i === room.currentTurn, isEliminated: p.diceCount === 0, 
            id: p.id, equipped: p.equipped 
        })),
        currentBid: room.currentBid, 
        turnDeadline: room.turnDeadline,
        activeRules: { jokers: room.config.jokers, spot: room.config.spot }
    });
}

const PING_INTERVAL = 10 * 60 * 1000;
const MY_URL = 'https://liarsdicezmss.onrender.com';
setInterval(() => { https.get(MY_URL, (res) => {}).on('error', (err) => {}); }, PING_INTERVAL);

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
