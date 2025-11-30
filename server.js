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

        // ADMIN ONLY
        if (fromId !== ADMIN_ID) return;

        const args = text.split(' ');
        const cmd = args[0].toLowerCase();

        // ... (Admin commands: setxp, setcoins, reset, kick, win - same as before) ...
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
    let valid = false;
    
    if (!room.currentBid) {
        valid = quantity > 0 && faceValue >= 1 && faceValue <= 6;
    } else {
        // Стандартные правила (Perudo):
        // 1. Повысить количество (номинал любой)
        // 2. Оставить количество, повысить номинал
        
        if (quantity > room.currentBid.quantity) valid = true;
        else if (quantity === room.currentBid.quantity && faceValue > room.currentBid.faceValue) valid = true;
        
        // Правило "Только повышение" (Strict Mode)
        // Если включено: нельзя понижать количество, даже если меняешь номинал
        if (room.config.strict) {
            if (quantity < room.currentBid.quantity) valid = false;
        }
    }

    // Для бота - автокоррекция, если он ошибся
    if (player.isBot && !valid) {
        if (room.currentBid) {
            quantity = room.currentBid.quantity + 1;
            faceValue = room.currentBid.faceValue; 
        } else { quantity = 1; faceValue = 2; }
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

io.on('connection', (socket) => {
    // ... (LOGIN, SHOP - same as before) ...
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

    socket.on('sendEmote', (emoji) => {
        const room = getRoomBySocketId(socket.id);
        if (room) io.to(room.id).emit('emoteReceived', { id: socket.id, emoji: emoji });
    });

    socket.on('joinOrCreateRoom', ({ roomId, tgUser, options, mode }) => {
        const old = getRoomBySocketId(socket.id);
        if (old) leaveRoom(socket, old);

        if (!tgUser) return;
        const userId = tgUser.id;
        const uData = getUserData(userId);
        const rInfo = getRankInfo(uData.xp, uData.streak);
        let room; let isCreator = false;

        // Common config setup
        const st = options || {};
        const config = { 
            dice: st.dice || 5, 
            players: st.players || 10, 
            time: st.time || 30, 
            jokers: !!st.jokers, 
            spot: !!st.spot, 
            difficulty: st.difficulty || 'easy',
            strict: !!st.strict // NEW RULE
        };

        if (mode === 'pve') {
            const newId = 'CPU_' + Math.random().toString(36).substring(2,6);
            const botCount = config.players - 1;
            room = {
                id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null,
                history: [], timerId: null, turnDeadline: 0, config: config, isPvE: true
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
                    rank: config.difficulty === 'pirate' ? 'Капитан' : 'Матрос', dice: [], diceCount: room.config.dice, ready: true, isCreator: false, isBot: true, equipped: { frame: 'frame_default' }
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
            room = {
                id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null,
                history: [], timerId: null, turnDeadline: 0, config: config, isPvE: false
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
        
        quantity = parseInt(quantity); faceValue = parseInt(faceValue);
        let valid = false;

        if (!r.currentBid) {
            valid = quantity > 0 && faceValue >= 1 && faceValue <= 6;
        } else {
            if (quantity > r.currentBid.quantity) valid = true;
            else if (quantity === r.currentBid.quantity && faceValue > r.currentBid.faceValue) valid = true;
            
            // STRICT RULE CHECK
            if (r.config.strict) {
                if (quantity < r.currentBid.quantity) valid = false;
            }
        }

        if (!valid) { socket.emit('errorMsg', r.config.strict ? 'Нельзя понижать ставку!' : 'Нужно повысить ставку!'); return; }
        r.currentBid = { quantity, faceValue, playerId: socket.id };
        io.to(r.id).emit('gameEvent', { text: `${r.players[r.currentTurn].name} ставит: ${quantity}x[${faceValue}]`, type: 'info' });
        nextTurn(r);
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

// ... Helpers (checkElimination, leaveRoom, broadcastRoomUpdate, startNewRound, nextTurn, broadcastGameState) - same as before
// Just updated broadcastGameState to include strict rule in UI if needed

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
        if (loser.diceCount === 0) {
            let loopCount = 0;
            do { 
                idx = (idx + 1) % room.players.length; 
                loopCount++;
                if(loopCount > 20) break; 
            } while (room.players[idx].diceCount === 0);
        }
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
    resetTurnTimer(room);
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
    io.to(room.id).emit('gameState', {
        players: room.players.map((p, i) => ({ 
            name: p.name, rank: p.rank, diceCount: p.diceCount, 
            isTurn: i === room.currentTurn, isEliminated: p.diceCount === 0, 
            id: p.id, equipped: p.equipped 
        })),
        currentBid: room.currentBid, 
        turnDeadline: room.turnDeadline,
        activeRules: { jokers: room.config.jokers, spot: room.config.spot, strict: room.config.strict }
    });
}

const PING_INTERVAL = 10 * 60 * 1000;
const MY_URL = 'https://liarsdicezmss.onrender.com';
setInterval(() => { https.get(MY_URL, (res) => {}).on('error', (err) => {}); }, PING_INTERVAL);

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
