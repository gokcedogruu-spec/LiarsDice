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
        if (savedData.coins !== undefined) user.coins = savedData.coins;
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
                    handlePlayerDisconnect(socketId, room);
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

function getRoomBySocketId(socketId) {
    for (const [roomId, room] of rooms) {
        if (room.players.some(p => p.id === socketId)) return room;
    }
    return null;
}

function handleTimeout(room) {
    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer || currentPlayer.isBot) return; // Боты обрабатываются handleBotMove
    
    // Сброс ставки (чтобы было что-то, на что можно блефовать/спотить)
    if (!room.currentBid) {
        room.currentBid = { quantity: 1, faceValue: 2, bidderId: currentPlayer.id };
        io.to(room.id).emit('currentBid', room.currentBid);
        io.to(room.id).emit('gameEvent', { text: `${currentPlayer.name} пропустил ход и делает минимальную ставку!`, type: 'error' });
    }

    // Если ставка есть, то это засчитывается как "НЕ ВЕРЮ"
    handleCallInternal(room, 'bluff', currentPlayer.id);
}

function handleBotMove(room) {
    // ... (Your existing bot logic) ...
    const bot = room.players[room.currentTurn];

    if (room.status !== 'PLAYING' || !bot || !bot.isBot) return;

    // Если бот уже мертв, пропускаем (защита)
    if (bot.diceCount === 0) {
        nextTurn(room);
        return;
    }

    const lastBid = room.currentBid;
    let totalDiceInGame = 0;
    room.players.forEach(p => totalDiceInGame += p.diceCount);

    const myHand = {};
    bot.dice.forEach(d => myHand[d] = (myHand[d] || 0) + 1);

    const diff = room.config.difficulty;

    if (!lastBid) {
        // Начало раунда, просто ставим
        const face = bot.dice[0] || Math.floor(Math.random()*6)+1;
        makeBidInternal(room, bot, 1, face);
        return;
    }

    const needed = lastBid.quantity;
    const face = lastBid.faceValue;

    const inHand = myHand[face] || 0;
    const inHandJokers = room.config.jokers ? (myHand[1] || 0) : 0;
    
    // Сколько кубиков (с учетом джокеров) у бота
    const mySupport = (face === 1 && room.config.jokers) ? inHand : (inHand + (face !== 1 ? inHandJokers : 0));
    
    const unknownDice = totalDiceInGame - bot.diceCount;
    const probPerDie = room.config.jokers ? (face===1 ? 1/6 : 2/6) : 1/6;
    const expectedTotal = mySupport + (unknownDice * probPerDie);
    
    let threshold = 0;
    if (diff === 'easy') threshold = 2.0;
    if (diff === 'medium') threshold = 0.5;
    if (diff === 'pirate') threshold = 0.0; // Пират ставит даже если шансы 50/50

    // 1. ПРОВЕРКА: Не верить?
    if (expectedTotal < needed - threshold) {
        // Бот почти уверен, что это блеф
        if (Math.random() < (diff === 'easy' ? 0.3 : 0.7)) {
            handleCallInternal(room, 'bluff', bot.id);
            return;
        }
    }

    // 2. ПРОВЕРКА: Поставить В ТОЧКУ?
    if (room.config.spot && Math.abs(expectedTotal - needed) < 0.2) {
        if (Math.random() < (diff === 'pirate' ? 0.5 : 0.2)) {
            handleCallInternal(room, 'spot', bot.id);
            return;
        }
    }

    // 3. ПЕРЕБИТЬ: Если не верит, но и не хочет рисковать, или если ставка разумна
    
    let newQty = lastBid.quantity;
    let newVal = lastBid.faceValue;
    
    // Шанс блефа (ставить выше ожидаемого)
    let bluffFactor = 0;
    if (diff === 'pirate') bluffFactor = 1;
    else if (diff === 'medium') bluffFactor = 0.5;

    let targetQty = Math.floor(expectedTotal + 0.5 + bluffFactor);
    targetQty = Math.max(lastBid.quantity, targetQty);
    
    let madeMove = false;

    // Сначала пробуем повысить значение на той же Quantity
    if (targetQty === lastBid.quantity && lastBid.faceValue < 6) {
        if (Math.random() < 0.7) { // 70% шанс просто повысить faceValue
             makeBidInternal(room, bot, lastBid.quantity, lastBid.faceValue + 1);
             madeMove = true;
        }
    } 
    
    // Если не повысили faceValue или не сработало, ставим по targetQty
    if (!madeMove) {
        if (targetQty > lastBid.quantity) {
            newQty = targetQty;
            newVal = Math.floor(Math.random() * 6) + 1; // Новое, случайное значение
            makeBidInternal(room, bot, newQty, newVal);
        } else {
             // Если нужно поставить ту же Quantity, ставим на 6
             makeBidInternal(room, bot, lastBid.quantity + 1, newVal);
        }
    }
}

function makeBidInternal(room, player, quantity, faceValue) {
    // ... (Your existing makeBidInternal logic) ...
    
    // Проверка на Strict
    if (room.config.strict && room.currentBid) {
        if (quantity < room.currentBid.quantity) return;
        if (quantity === room.currentBid.quantity && faceValue <= room.currentBid.faceValue) return;
    } else {
        // Стандартные правила:
        if (room.currentBid) {
            if (quantity < room.currentBid.quantity) return;
            if (quantity === room.currentBid.quantity && faceValue <= room.currentBid.faceValue) return;
        }
    }
    
    room.currentBid = { quantity, faceValue, bidderId: player.id };
    io.to(room.id).emit('currentBid', room.currentBid);
    io.to(room.id).emit('gameEvent', { text: `${player.name} ставит ${quantity}x${faceValue}`, type: 'bid' });
    nextTurn(room);
}

function handleCall(socket, type) {
    // ... (Your existing handleCall logic) ...
    const room = getRoomBySocketId(socket.id);
    if (!room || room.status !== 'PLAYING' || room.players[room.currentTurn].id !== socket.id || !room.currentBid) return;
    if (type === 'spot' && !room.config.spot) return; 

    handleCallInternal(room, type, socket.id);
}

function handleCallInternal(room, type, callerId) {
    // ... (Your existing handleCallInternal logic) ...
    const challenger = room.players.find(p => p.id === callerId);
    const bidder = room.players.find(p => p.id === room.currentBid.bidderId);

    if (!challenger || !bidder) return;

    if (room.timerId) clearTimeout(room.timerId);

    let total = 0;
    let targetFace = room.currentBid.faceValue;
    const allDice = {};
    
    room.players.forEach(p => {
        if (p.diceCount > 0) {
            p.dice.forEach(d => {
                if (d === targetFace) total++;
                else if (room.config.jokers && d === 1 && targetFace !== 1) total++;
            });
            allDice[p.name] = p.dice;
        }
    });

    io.to(room.id).emit('revealDice', allDice);
    let loser, winnerOfRound, msg;

    if (type === 'bluff') {
        if (total < room.currentBid.quantity) {
            msg = `На столе ${total}. Блеф! ${bidder.name} теряет куб.`;
            loser = bidder;
            winnerOfRound = challenger;
        } else {
            msg = `На столе ${total}. Ставка есть! ${challenger.name} теряет куб.`;
            loser = challenger;
            winnerOfRound = bidder;
        }
    } else if (type === 'spot') {
        if (total === room.currentBid.quantity) {
            msg = `В ТОЧКУ! ${total} кубов! ${bidder.name} теряет куб.`;
            loser = bidder;
            winnerOfRound = challenger;
        } else {
            msg = `Мимо! На столе ${total}. ${challenger.name} теряет куб.`;
            loser = challenger;
            winnerOfRound = bidder;
        }
    }

    io.to(room.id).emit('roundResult', { message: msg });
    loser.diceCount--;
    
    // Начисление бонуса за "В ТОЧКУ"
    if (type === 'spot' && total === room.currentBid.quantity && !winnerOfRound.isBot) {
        updateUserXP(winnerOfRound.tgId, 'kill_captain');
    }
    
    setTimeout(() => checkEliminationAndContinue(room, loser, winnerOfRound), 4000);
}

function checkEliminationAndContinue(room, lastLoser, winnerOfRound) {
    // ... (Your existing checkEliminationAndContinue logic) ...
    const active = room.players.filter(p => p.diceCount > 0);

    if (active.length <= 1) {
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
        // ИЩЕМ СЛЕДУЮЩЕГО, КТО БУДЕТ ХОДИТЬ
        let startPlayerIndex;
        if (winnerOfRound) {
            startPlayerIndex = room.players.findIndex(p => p.id === winnerOfRound.id);
        } else {
            // Если ничья (spot) или что-то пошло не так, начинает проигравший
            startPlayerIndex = room.players.findIndex(p => p.id === lastLoser.id);
        }

        // Если проигравший мертв
        if (room.players[startPlayerIndex].diceCount === 0) {
            let l = 0;
            do {
                startPlayerIndex = (startPlayerIndex + 1) % room.players.length;
                l++; if(l > room.players.length) break; // Защита от бесконечного цикла
            } while (room.players[startPlayerIndex].diceCount === 0);
        }
        
        room.currentTurn = startPlayerIndex;
        startNewRound(room, false);
    }
}

function startNewRound(room, isFullShuffle) {
    // ... (Your existing startNewRound logic) ...
    if (isFullShuffle) {
        room.players.forEach(p => {
            if (p.diceCount > 0 && !p.isBot) {
                p.dice = Array.from({ length: p.diceCount }, () => Math.floor(Math.random() * 6) + 1);
            } else if (p.diceCount > 0 && p.isBot) {
                p.dice = Array.from({ length: p.diceCount }, () => Math.floor(Math.random() * 6) + 1);
            }
        });
    } else {
        // ТОЛЬКО ПЕРЕБРОС КУБИКОВ
        room.players.forEach(p => {
            if (p.diceCount > 0) {
                p.dice = Array.from({ length: p.diceCount }, () => Math.floor(Math.random() * 6) + 1);
            }
        });
    }

    room.currentBid = null;
    room.history = [];

    // Отправляем игрокам их новые кубики
    room.players.forEach(p => { if (p.diceCount > 0 && !p.isBot) io.to(p.id).emit('yourDice', p.dice); });
    io.to(room.id).emit('gameEvent', { text: `🎲 РАУНД!`, type: 'info' });
    
    resetTurnTimer(room); 
    broadcastGameState(room);
}

function resetTurnTimer(room) {
    if (room.timerId) clearTimeout(room.timerId);
    
    // Берем время из конфига
    const durationSec = (room.config && room.config.time) ? room.config.time : 30;
    const durationMs = durationSec * 1000;
    
    room.turnDuration = durationMs;
    room.turnDeadline = Date.now() + durationMs;
    
    const currentPlayer = room.players[room.currentTurn];
    
    // Если игрок мертв
    if (currentPlayer.diceCount === 0) {
        nextTurn(room);
        return;
    }

    if (currentPlayer.isBot) {
        // У ботов свое время на раздумья
        const thinkTime = Math.random() * 2000 + 2000;
        room.timerId = setTimeout(() => handleBotMove(room), thinkTime);
    } else {
        // У людей жесткий таймер
        room.timerId = setTimeout(() => handleTimeout(room), durationMs);
    }
}

function nextTurn(room) {
    let l = 0; 
    do { 
        room.currentTurn = (room.currentTurn + 1) % room.players.length; 
        l++; if(l>20)return; 
    } while (room.players[room.currentTurn].diceCount === 0);
    
    resetTurnTimer(room); 
    broadcastGameState(room);
}

function broadcastGameState(room) {
    const now = Date.now();
    const remaining = Math.max(0, room.turnDeadline - now);

    io.to(room.id).emit('gameState', {
        players: room.players.map((p, i) => ({ 
            name: p.name, rank: p.rank, diceCount: p.diceCount, 
            isTurn: i === room.currentTurn, isEliminated: p.diceCount === 0, 
            id: p.id, equipped: p.equipped 
        })),
        currentBid: room.currentBid, 
        history: room.history,
        activeRules: room.config,
        remainingTime: remaining, 
        totalDuration: room.turnDuration 
    });
}

function broadcastRoomUpdate(room) {
    io.to(room.id).emit('roomUpdate', {
        roomId: room.id,
        players: room.players.map(p => ({
            name: p.name, rank: p.rank, ready: p.ready, id: p.id
        })),
        isCreator: room.players[0].id,
        config: room.config
    });
}

io.on('connection', (socket) => {
    
    // --- AUTH AND SYNC ---
    socket.on('login', ({ tgUser, savedData }) => {
        if (!tgUser) return;
        
        socket.tgUserId = tgUser.id;
        const user = syncUserData(tgUser, savedData);
        const rInfo = getRankInfo(user.xp, user.streak);
        
        socket.emit('profileUpdate', { 
            ...user, 
            rankName: rInfo.current.name, 
            nextRankXP: rInfo.next?.min 
        });
    });

    // --- SHOP ---
    socket.on('shopBuy', (itemId) => {
        const user = getUserData(socket.tgUserId);
        const itemPrice = { 'skin_red': 200, 'skin_gold': 1000, 'skin_black': 500, 'skin_blue': 300, 'skin_green': 400, 'skin_purple': 800, 'skin_cyber': 1500, 'skin_bone': 2500, 'frame_wood': 100, 'frame_silver': 300, 'frame_gold': 500, 'frame_fire': 1500 };
        
        if (user.coins >= itemPrice[itemId] && !user.inventory.includes(itemId)) {
            user.coins -= itemPrice[itemId];
            user.inventory.push(itemId);
            pushProfileUpdate(socket.tgUserId);
        } else {
             socket.emit('errorMsg', 'Не удалось купить.');
        }
    });

    socket.on('shopEquip', (itemId) => {
        const user = getUserData(socket.tgUserId);
        if (user.inventory.includes(itemId)) {
            if (itemId.startsWith('skin')) user.equipped.skin = itemId;
            else if (itemId.startsWith('frame')) user.equipped.frame = itemId;
            else if (itemId.startsWith('bg')) user.equipped.bg = itemId;
            pushProfileUpdate(socket.tgUserId);
        }
    });

    // ЗАПРОС ПРОФИЛЯ (Безопасный, без денег)
    socket.on('getUserProfile', (targetId) => {
        // Если это бот
        if (typeof targetId === 'string' && targetId.startsWith('bot_')) return;
        
        let targetUserId = null;

        // Попытка 1: targetId это socket.id (из лобби или игры)
        const room = getRoomBySocketId(targetId); // Пытаемся найти комнату по сокету цели
        if (room) {
            const p = room.players.find(x => x.id === targetId);
            if (p && p.tgId) targetUserId = p.tgId;
        }

        // Попытка 2: Если запрашиваем самого себя (из меню)
        if (targetId === socket.id && socket.tgUserId) targetUserId = socket.tgUserId;

        if (targetUserId) {
            const user = getUserData(targetUserId);
            const rInfo = getRankInfo(user.xp, user.streak);
            
            // Отправляем ТОЛЬКО публичные данные
            socket.emit('showUserProfile', {
                name: user.name,
                rankName: rInfo.current.name,
                matches: user.matches,
                wins: user.wins,
                inventory: user.inventory,
                equipped: user.equipped
            });
        }
    });

    // --- ROOM LOGIC ---
    socket.on('joinOrCreateRoom', ({ roomId, tgUser, options }) => {
        const old = getRoomBySocketId(socket.id); 
        if (old) handlePlayerDisconnect(socket.id, old); 

        if (!tgUser) return;
        const userId = tgUser.id;
        const uData = getUserData(userId);
        const rInfo = getRankInfo(uData.xp, uData.streak);

        let room;
        let isCreator = false;

        if (roomId.startsWith('CPU')) { // PVE Logic
            const diff = options.difficulty || 'easy';
            const botCount = options.players - 1;

            room = { id: roomId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null, history: [], timerId: null, turnDeadline: 0, turnDuration: 30000, config: { dice: options.dice, players: options.players, time: 30, jokers: options.jokers, spot: options.spot, difficulty: diff }, isPvE: true };
            rooms.set(roomId, room); 

            room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: room.config.dice, ready: true, isCreator: true, equipped: uData.equipped });
            
            const botNames = ['Джек', 'Барбосса', 'Уилл', 'Дейви Джонс', 'Тич', 'Гиббс']; 
            for(let i=0; i<botCount; i++) {
                 room.players.push({ id: 'bot_' + i, tgId: null, name: botNames[i % botNames.length], rank: 'Бот', dice: [], diceCount: room.config.dice, ready: true, isBot: true, equipped: { skin: 'skin_black', bg: 'bg_wood', frame: 'frame_default' } });
            }
            socket.join(roomId);
            startGame(room); // Start PVE immediately

        } else if (rooms.has(roomId)) { // Joining PVP
            room = rooms.get(roomId);
            if (room.status !== 'LOBBY' || room.players.length >= room.config.players) {
                socket.emit('errorMsg', 'Комната занята или не существует.');
                return;
            }
            room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: room.config.dice, ready: false, isCreator: false, equipped: uData.equipped });
            socket.join(roomId);

        } else { // Creating PVP
            const newId = roomId || Math.random().toString(36).substring(2,6).toUpperCase();
            room = { id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null, history: [], timerId: null, turnDeadline: 0, turnDuration: 30000, config: options, isPvE: false };
            rooms.set(newId, room);
            room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: options.dice, ready: false, isCreator: true, equipped: uData.equipped });
            socket.join(newId);
            isCreator = true;
        }

        if (room.isPvE) return; // For PVE, update/start already done.
        
        socket.emit('joinedRoom', { roomId: room.id, isCreator });
        broadcastRoomUpdate(room);
    });

    socket.on('setReady', (isReady) => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'LOBBY') return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.ready = isReady;
            broadcastRoomUpdate(room);
        }
    });

    socket.on('startGame', () => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'LOBBY' || !room.players[0].isCreator) return; 

        if (room.players.length < 2) {
            socket.emit('errorMsg', 'Нужно хотя бы 2 игрока.');
            return;
        }
        if (!room.players.every(p => p.ready)) {
            socket.emit('errorMsg', 'Не все игроки готовы.');
            return;
        }

        startGame(room);
    });

    function startGame(room) {
        room.status = 'PLAYING';
        room.players.forEach(p => p.diceCount = room.config.dice);
        room.currentTurn = 0;
        startNewRound(room, true);
    }
    
    // --- GAME ACTIONS ---
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
            // Обновляем статистику всем, кто был в игре
            r.players.forEach(p => { if (!p.isBot && p.tgId) pushProfileUpdate(p.tgId); });

            if (r.isPvE) {
                // PVE - просто начинаем заново
                r.status = 'PLAYING'; 
                r.players.forEach(p => { p.diceCount = r.config.dice; p.dice = []; });
                r.currentBid = null;
                startNewRound(r, true);
            } else {
                // PVP - возвращаем в лобби
                r.status = 'LOBBY';
                r.players.forEach(p => { 
                    p.diceCount = r.config.dice; 
                    p.ready = false; 
                    p.dice = []; 
                });
                r.currentBid = null;
                broadcastRoomUpdate(r);
            }
        }
    });

    socket.on('disconnect', () => {
        const r = getRoomBySocketId(socket.id);
        if (r) handlePlayerDisconnect(socket.id, r);
    });
});

function handlePlayerDisconnect(socketId, room) {
    const i = room.players.findIndex(p => p.id === socketId);
    if (i === -1) return;

    const player = room.players[i];
    
    // Если игрок был в игре
    if (room.status === 'PLAYING') {
        player.diceCount = 0; // Игрок выбывает
        checkEliminationAndContinue(room, player, null);
    }
    
    // Удаляем игрока
    room.players.splice(i, 1);
    
    // Если комната PVE, мы ее не удаляем, но нужно остановить таймер
    if (room.isPvE) {
        if (room.players.length === 0) {
            rooms.delete(room.id);
        }
        return;
    }

    // PVP Logic
    if (room.players.length === 0) {
        if (room.timerId) clearTimeout(room.timerId);
        rooms.delete(room.id);
    } else {
        // Если это был создатель, передаем права
        if (i === 0) { 
            room.players[0].isCreator = true; 
            if(room.status === 'LOBBY') room.players[0].ready = true;
        }

        if (room.status === 'LOBBY') {
            broadcastRoomUpdate(room);
        } else if (room.status === 'PLAYING') {
            // Если была его очередь
            if (room.currentBid && room.currentBid.bidderId === player.id) {
                // Если тот, кто сделал ставку, вышел, раунд отменяется и начинается новый
                io.to(room.id).emit('gameEvent', { text: `${player.name} вышел. Раунд отменен.`, type: 'error' });
                room.currentTurn = room.players.findIndex(p => p.id === room.players[0].id); // Начинает новый создатель
                startNewRound(room, true);
            } else if (room.players[room.currentTurn]?.id === player.id) {
                // Если просто была его очередь
                nextTurn(room);
            } else {
                broadcastGameState(room);
            }
        }
    }
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
