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

// --- RATING & ECONOMY ---
const RANKS = [
    { name: "Салага", min: 0, level: 0 },
    { name: "Юнга", min: 500, level: 1 },
    { name: "Матрос", min: 1500, level: 2 },
    { name: "Старший матрос", min: 5000, level: 3 },
    { name: "Боцман", min: 10000, level: 4 },
    { name: "Первый помощник", min: 25000, penalty: 30, level: 5 },
    { name: "Капитан", min: 50000, penalty: 60, level: 6 },
    { name: "Легенда морей", min: 75000, reqStreak: 100, penalty: 100, level: 7 }
];

const userDB = new Map();

function getUserData(userId) {
    if (!userDB.has(userId)) {
        userDB.set(userId, { 
            xp: 0, matches: 0, wins: 0, streak: 0, coins: 100,
            name: 'Unknown', username: null,
            inventory: ['skin_white', 'bg_default', 'frame_default'], 
            equipped: { skin: 'skin_white', bg: 'bg_default', frame: 'frame_default' }
        });
    }
    return userDB.get(userId);
}

// ВОССТАНОВЛЕНИЕ ДАННЫХ ИЗ ТЕЛЕГРАМА
function syncUserData(tgUser, savedData) {
    const userId = tgUser.id;
    
    // Если пользователя нет в памяти сервера, создаем
    let user = userDB.get(userId);
    if (!user) {
        user = { 
            xp: 0, matches: 0, wins: 0, streak: 0, coins: 100,
            name: tgUser.first_name, 
            username: tgUser.username ? tgUser.username.toLowerCase() : null,
            inventory: ['skin_white', 'bg_default', 'frame_default'], 
            equipped: { skin: 'skin_white', bg: 'bg_default', frame: 'frame_default' }
        };
    } else {
        // Обновляем имя, если поменялось
        user.name = tgUser.first_name;
        user.username = tgUser.username ? tgUser.username.toLowerCase() : null;
    }

    // Если клиент прислал сохранение (из Telegram Cloud), применяем его
    if (savedData) {
        // Применяем, если значения валидные (защита от совсем битых данных)
        if (typeof savedData.xp === 'number') user.xp = Math.max(user.xp, savedData.xp);
        if (typeof savedData.coins === 'number') user.coins = savedData.coins; // Монеты верим сохранению
        
        // Восстанавливаем статистику
        if (typeof savedData.matches === 'number') user.matches = Math.max(user.matches, savedData.matches);
        if (typeof savedData.wins === 'number') user.wins = Math.max(user.wins, savedData.wins);
        if (typeof savedData.streak === 'number') user.streak = savedData.streak;

        if (Array.isArray(savedData.inventory)) {
            // Объединяем инвентари (на всякий случай), убираем дубликаты
            const combined = new Set([...user.inventory, ...savedData.inventory]);
            user.inventory = Array.from(combined);
        }
        if (savedData.equipped) user.equipped = { ...user.equipped, ...savedData.equipped };
    }
    
    // Гарантируем наличие базы
    if (!user.inventory.includes('bg_default')) user.inventory.push('bg_default');
    
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

        console.log(`[BOT MSG] From: ${fromId} Text: ${text}`); // DEBUG

        if (text.toLowerCase().startsWith('/start') && !text.startsWith('/')) {
            const WEB_APP_URL = 'https://liarsdicezmss.onrender.com'; 
            const opts = { reply_markup: { inline_keyboard: [[{ text: "🎲 ИГРАТЬ", web_app: { url: WEB_APP_URL } }]] } };
            bot.sendMessage(chatId, "☠️ Костяшки: Врывайся в игру!", opts).catch(()=>{});
            return;
        }

        if (fromId !== ADMIN_ID) return;

        const args = text.split(' ');
        const cmd = args[0].toLowerCase();

        if (cmd === '/setxp') {
            if (args.length < 3) return bot.sendMessage(chatId, "Use: /setxp @user 1000");
            const uid = findUserIdByUsername(args[1]); if (!uid) return bot.sendMessage(chatId, "User not found");
            const user = userDB.get(uid); user.xp = parseInt(args[2]);
            if (user.xp >= 75000) user.streak = 100;
            userDB.set(uid, user); pushProfileUpdate(uid);
            bot.sendMessage(chatId, `XP Set: ${user.xp}`);
        }
        else if (cmd === '/setcoins') {
            if (args.length < 3) return;
            const uid = findUserIdByUsername(args[1]); if (!uid) return;
            const user = userDB.get(uid); user.coins = parseInt(args[2]);
            userDB.set(uid, user); pushProfileUpdate(uid);
            bot.sendMessage(chatId, `Coins Set: ${user.coins}`);
        }
        else if (cmd === '/rich') {
            if (args.length < 2) return;
            const uid = findUserIdByUsername(args[1]); if (!uid) return;
            const user = userDB.get(uid); user.coins = 1000000;
            userDB.set(uid, user); pushProfileUpdate(uid);
            bot.sendMessage(chatId, "Rich mode enabled");
        }
        else if (cmd === '/unlockall') {
            if (args.length < 2) return;
            const uid = findUserIdByUsername(args[1]); if (!uid) return;
            const user = userDB.get(uid);
            user.inventory = [
                'skin_white', 'skin_red', 'skin_gold', 'skin_black', 'skin_blue', 'skin_green', 'skin_purple', 'skin_cyber', 'skin_bone',
                'bg_default', 'bg_lvl1', 'bg_lvl2', 'bg_lvl3', 'bg_lvl4',
                'frame_default', 'frame_wood', 'frame_silver', 'frame_gold', 'frame_fire', 'frame_ice', 'frame_neon', 'frame_royal', 'frame_ghost', 'frame_kraken', 'frame_captain'
            ];
            userDB.set(uid, user); pushProfileUpdate(uid);
            bot.sendMessage(chatId, "Unlocked all items");
        }
        else if (cmd === '/reset') {
            if (args.length < 2) return;
            const uid = findUserIdByUsername(args[1]); if (!uid) return;
            const user = userDB.get(uid);
            user.xp = 0; user.coins = 0; user.wins = 0; user.matches = 0; user.streak = 0;
            user.inventory = ['skin_white', 'bg_default', 'frame_default'];
            user.equipped = { skin: 'skin_white', bg: 'bg_default', frame: 'frame_default' };
            userDB.set(uid, user);
            pushProfileUpdate(uid);
            bot.sendMessage(chatId, `Reset done`);
        }
    });
}

app.use(express.static(path.join(__dirname, 'public')));

// --- Game Logic ---
const rooms = new Map(); 
function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function rollDice(count) { return Array.from({length: count}, () => Math.floor(Math.random() * 6) + 1).sort((a,b)=>a-b); }
function getRoomBySocketId(id) { for (const [k,v] of rooms) if (v.players.find(p=>p.id===id)) return v; return null; }

function resolveBackground(room) {
    if (room.isPvE) return 'bg_default';

    const creator = room.players.find(p => p.isCreator);
    if (creator && creator.tgId) {
        const uData = getUserData(creator.tgId);
        if (uData.equipped.bg && uData.equipped.bg !== 'bg_default') {
            return uData.equipped.bg;
        }
    }

    const candidates = room.players
        .filter(p => !p.isBot && p.tgId)
        .map(p => {
            const uData = getUserData(p.tgId); 
            const rInfo = getRankInfo(uData.xp, uData.streak);
            return {
                bg: uData.equipped.bg || 'bg_default',
                rankLevel: rInfo.current.level,
                streak: uData.streak
            };
        })
        .filter(c => c.bg !== 'bg_default');

    if (candidates.length === 0) return 'bg_default';

    candidates.sort((a, b) => {
        if (b.rankLevel !== a.rankLevel) return b.rankLevel - a.rankLevel;
        return b.streak - a.streak;
    });

    return candidates[0].bg;
}

function resetTurnTimer(room) {
    if (room.timerId) clearTimeout(room.timerId);
    const duration = room.config.time * 1000;
    room.turnDuration = duration;
    room.turnDeadline = Date.now() + duration;
    broadcastGameState(room);

    const currentPlayer = room.players[room.currentTurn];
    if (currentPlayer.diceCount === 0) { nextTurn(room); return; }

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
    if (bot.diceCount === 0) { nextTurn(room); return; }

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
        if (room.config.strict) {
            nextQty = lastBid.quantity + 1; nextFace = Math.floor(Math.random() * 6) + 1; 
        } else {
            if (nextFace > 6) { nextFace = 2; nextQty++; }
        }
        makeBidInternal(room, bot, nextQty, nextFace);
    }
}

function makeBidInternal(room, player, quantity, faceValue) {
    if (room.currentBid) {
        if (room.config.strict) {
            if (quantity <= room.currentBid.quantity) {
                io.to(player.id).emit('errorMsg', 'В строгом режиме нужно повышать количество!'); return;
            }
        } else {
            if (quantity < room.currentBid.quantity) quantity = room.currentBid.quantity + 1;
            else if (quantity === room.currentBid.quantity && faceValue <= room.currentBid.faceValue) {
                faceValue = room.currentBid.faceValue + 1;
            }
        }
    }
    if (faceValue > 6) { 
        if(room.config.strict) faceValue = 6; 
        else { faceValue = 2; quantity++; }
    }
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

function handleSkill(socket, skillType) {
    const room = getRoomBySocketId(socket.id);
    if (!room || room.status !== 'PLAYING') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.tgId) return;
    if (player.skillsUsed && player.skillsUsed.includes(skillType)) {
        socket.emit('errorMsg', 'Навык уже использован!'); return;
    }
    const user = getUserData(player.tgId);
    const rankInfo = getRankInfo(user.xp, user.streak);
    const level = rankInfo.current.level;

    if (skillType === 'ears') {
        if (level < 4) return socket.emit('errorMsg', 'Нужен ранг Боцман');
        if (room.currentTurn !== room.players.indexOf(player)) return socket.emit('errorMsg', 'Только в свой ход');
        if (!room.currentBid) return socket.emit('errorMsg', 'Ставок нет');
        let chance = level === 4 ? 0.35 : level === 5 ? 0.50 : level === 6 ? 0.75 : 1.0;
        if (Math.random() < chance) {
            const bid = room.currentBid; let total = 0;
            room.players.forEach(p => { p.dice.forEach(d => { if (d === bid.faceValue || (room.config.jokers && d===1 && bid.faceValue!==1)) total++; }) });
            const isLying = total < bid.quantity;
            socket.emit('gameEvent', { text: isLying ? "👂 Слух: Он ВРЁТ!" : "👂 Слух: Похоже на правду...", type: 'info' });
        } else socket.emit('gameEvent', { text: "👂 Ничего не слышно...", type: 'error' });
        if(!player.skillsUsed) player.skillsUsed = []; player.skillsUsed.push('ears'); broadcastGameState(room);
    }
    else if (skillType === 'lucky') {
        if (level < 5) return socket.emit('errorMsg', 'Нужен ранг 1-й помощник');
        if (player.diceCount >= 5) return socket.emit('errorMsg', 'Максимум кубиков');
        let chance = level === 5 ? 0.50 : level === 6 ? 0.75 : 1.0;
        if (Math.random() < chance) {
            player.diceCount++; player.dice.push(Math.floor(Math.random()*6)+1);
            io.to(room.id).emit('gameEvent', { text: `🎲 ${player.name} достал кубик!`, type: 'info' });
            io.to(player.id).emit('yourDice', player.dice); broadcastGameState(room);
        } else socket.emit('errorMsg', 'Фокус не удался...');
        if(!player.skillsUsed) player.skillsUsed = []; player.skillsUsed.push('lucky'); broadcastGameState(room);
    }
    else if (skillType === 'kill') {
        if (level < 6) return socket.emit('errorMsg', 'Нужен ранг Капитан');
        const active = room.players.filter(p => p.diceCount > 0);
        if (active.length !== 2) return socket.emit('errorMsg', 'Нужно 1 на 1');
        const enemy = active.find(p => p.id !== player.id);
        if (player.diceCount !== 1 || enemy.diceCount !== 1) return socket.emit('errorMsg', 'У всех по 1 кубу');
        let chance = level >= 7 ? 0.75 : 0.50;
        if (Math.random() < chance) {
            io.to(room.id).emit('gameEvent', { text: `🔫 ${player.name} пристрелил ${enemy.name}!`, type: 'info' });
            enemy.diceCount = 0; checkEliminationAndContinue(room, enemy, player);
        } else {
            io.to(room.id).emit('gameEvent', { text: `🔫 ${player.name} промахнулся!`, type: 'error' });
            player.diceCount = 0; checkEliminationAndContinue(room, player, enemy);
        }
        if(!player.skillsUsed) player.skillsUsed = []; player.skillsUsed.push('kill'); broadcastGameState(room);
    }
}

io.on('connection', (socket) => {
    socket.on('login', ({ tgUser, savedData }) => {
        if (!tgUser) return;
        const data = syncUserData(tgUser, savedData); // ВОССТАНАВЛИВАЕМ
        const rank = getRankInfo(data.xp, data.streak);
        socket.tgUserId = tgUser.id;
        socket.emit('profileUpdate', { ...data, rankName: rank.current.name, nextRankXP: rank.next?.min || 'MAX' });
    });

    socket.on('shopBuy', (itemId) => {
        if (!socket.tgUserId) return;
        const user = getUserData(socket.tgUserId);
        const PRICES = { 
            'skin_red': 200, 'skin_gold': 1000, 'skin_black': 500, 'skin_blue': 300, 'skin_green': 400, 'skin_purple': 800, 'skin_cyber': 1500, 'skin_bone': 2500, 
            'bg_lvl1': 150000, 'bg_lvl2': 150000, 'bg_lvl3': 150000, 'bg_lvl4': 150000,
            'frame_wood': 100, 'frame_silver': 300, 'frame_gold': 500, 'frame_fire': 1500, 'frame_ice': 1200, 'frame_neon': 2000, 'frame_royal': 5000, 'frame_ghost': 3000, 'frame_kraken': 4000, 'frame_captain': 10000 
        };
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
            if (itemId.startsWith('bg_') || itemId === 'table_default') user.equipped.bg = itemId; 
            if (itemId.startsWith('frame_')) user.equipped.frame = itemId;
            userDB.set(socket.tgUserId, user);
            const rank = getRankInfo(user.xp, user.streak);
            socket.emit('profileUpdate', { ...user, rankName: rank.current.name, nextRankXP: rank.next?.min || 'MAX' });
            const room = getRoomBySocketId(socket.id);
            if (room) {
                const p = room.players.find(pl => pl.id === socket.id);
                if(p) { p.equipped = { ...user.equipped }; if(room.status === 'LOBBY') broadcastRoomUpdate(room); }
            }
        }
    });

    socket.on('sendEmote', (emoji) => {
        const room = getRoomBySocketId(socket.id);
        if (room) io.to(room.id).emit('emoteReceived', { id: socket.id, emoji: emoji });
    });

    socket.on('useSkill', (skillType) => handleSkill(socket, skillType));

    socket.on('getPlayerStats', (targetId) => {
        let userData = null;
        if (targetId === 'me') { if (socket.tgUserId) userData = getUserData(socket.tgUserId); }
        else if (targetId.startsWith('bot') || targetId.startsWith('CPU')) return; 
        else {
            const room = getRoomBySocketId(socket.id);
            if (room) { const targetPlayer = room.players.find(p => p.id === targetId); if (targetPlayer && targetPlayer.tgId) userData = getUserData(targetPlayer.tgId); }
        }
        if (userData) {
            const rank = getRankInfo(userData.xp, userData.streak);
            socket.emit('showPlayerStats', { name: userData.name, rankName: rank.current.name, matches: userData.matches, wins: userData.wins, inventory: userData.inventory, equipped: userData.equipped });
        }
    });

    socket.on('joinOrCreateRoom', ({ roomId, tgUser, options, mode }) => {
        const old = getRoomBySocketId(socket.id); if (old) handlePlayerDisconnect(socket.id, old);
        if (!tgUser) return;
        const userId = tgUser.id; const uData = getUserData(userId); const rInfo = getRankInfo(uData.xp, uData.streak);
        let room; let isCreator = false;
        if (mode === 'pve') {
            const newId = 'CPU_' + Math.random().toString(36).substring(2,6);
            room = {
                id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null, history: [], timerId: null, turnDeadline: 0, 
                config: { dice: options.dice, players: options.players, time: 30, jokers: options.jokers, spot: options.spot, strict: options.strict, difficulty: options.difficulty }, isPvE: true
            };
            rooms.set(newId, room); isCreator = true;
            room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: room.config.dice, ready: true, isCreator: true, equipped: uData.equipped });
            const botNames = ['Джек', 'Барбосса', 'Уилл', 'Дейви Джонс', 'Тич', 'Гиббс'];
            for(let i=0; i<options.players-1; i++) {
                room.players.push({ id: 'bot_' + Math.random(), name: `${botNames[i%botNames.length]} (Бот)`, rank: options.difficulty === 'pirate' ? 'Капитан' : 'Матрос', dice: [], diceCount: room.config.dice, ready: true, isCreator: false, isBot: true, equipped: { frame: 'frame_default' } });
            }
            socket.join(newId); startNewRound(room, true); return;
        }
        if (roomId) { room = rooms.get(roomId); if (!room || room.status !== 'LOBBY' || room.players.length >= room.config.players) { socket.emit('errorMsg', 'Ошибка входа'); return; } }
        else {
            const newId = generateRoomId(); const st = options || { dice: 5, players: 10, time: 30 };
            room = { id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null, history: [], timerId: null, turnDeadline: 0, config: st, isPvE: false };
            rooms.set(newId, room); roomId = newId; isCreator = true;
        }
        room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: room.config.dice, ready: false, isCreator: isCreator, equipped: uData.equipped });
        socket.join(roomId); broadcastRoomUpdate(room);
    });

    socket.on('setReady', (isReady) => { const r = getRoomBySocketId(socket.id); if (r?.status === 'LOBBY') { const p = r.players.find(x => x.id === socket.id); if (p) { p.ready = isReady; broadcastRoomUpdate(r); } } });
    socket.on('startGame', () => { const r = getRoomBySocketId(socket.id); if (r) { const p = r.players.find(x => x.id === socket.id); if (p?.isCreator && r.players.length >= 2 && r.players.every(x => x.ready)) startNewRound(r, true); } });
    socket.on('makeBid', ({ quantity, faceValue }) => { const r = getRoomBySocketId(socket.id); if (!r || r.status !== 'PLAYING' || r.players[r.currentTurn].id !== socket.id) return; makeBidInternal(r, r.players[r.currentTurn], parseInt(quantity), parseInt(faceValue)); });
    socket.on('callBluff', () => handleCall(socket, 'bluff'));
    socket.on('callSpot', () => handleCall(socket, 'spot'));
    socket.on('requestRestart', () => { const r = getRoomBySocketId(socket.id); if (r?.status === 'FINISHED') { r.players.forEach(p => { if (!p.isBot && p.tgId) pushProfileUpdate(p.tgId); }); if (r.isPvE) { r.status = 'PLAYING'; r.players.forEach(p => { p.diceCount = r.config.dice; p.dice = []; p.skillsUsed = []; }); r.currentBid = null; startNewRound(r, true); } else { r.status = 'LOBBY'; r.players.forEach(p => { p.diceCount = r.config.dice; p.ready = false; p.dice = []; p.skillsUsed = []; }); r.currentBid = null; broadcastRoomUpdate(r); } } });
    socket.on('disconnect', () => { const r = getRoomBySocketId(socket.id); if (r) handlePlayerDisconnect(socket.id, r); });
});

const PING_INTERVAL = 10 * 60 * 1000;
const MY_URL = 'https://liarsdicezmss.onrender.com';
setInterval(() => { https.get(MY_URL, (res) => {}).on('error', (err) => {}); }, PING_INTERVAL);

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
