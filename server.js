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

// --- 1. STATIC FILES & PING ---
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));
app.get('/', (req, res) => { res.sendFile(path.join(publicPath, 'index.html')); });
app.get('/ping', (req, res) => { res.status(200).send('pong'); });

// --- 2. DATA ---
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

const HATS = {
    // RARE (1M) - Req: Level 6 (Captain)
    'hat_fallen': { price: 1000000, level: 6 },
    'hat_rich': { price: 1000000, level: 6 },
    'hat_underwater': { price: 1000000, level: 6 },
    'hat_voodoo': { price: 1000000, level: 6 },
    
    // LEGENDARY (10M) - Req: Level 6 (Captain)
    'hat_king_voodoo': { price: 10000000, level: 6 },
    'hat_cursed': { price: 10000000, level: 6 },
    'hat_flame': { price: 10000000, level: 6 },
    'hat_frozen': { price: 10000000, level: 6 },
    'hat_ghost': { price: 10000000, level: 6 },

    // MYTHICAL (100M) - Req: Level 7 (Legend)
    'hat_lava': { price: 100000000, level: 7 },
    'hat_shadow': { price: 100000000, level: 7 },
    'hat_antarctica': { price: 100000000, level: 7 }
};

const userDB = new Map();
const rooms = new Map();

function getUserData(userId) {
    if (!userDB.has(userId)) {
        userDB.set(userId, { 
            xp: 0, matches: 0, wins: 0, streak: 0, coins: 100,
            name: 'Unknown', username: null,
            inventory: ['skin_white', 'bg_default', 'frame_default'], 
            equipped: { skin: 'skin_white', bg: 'bg_default', frame: 'frame_default', hat: null }
        });
    }
    return userDB.get(userId);
}

function syncUserData(tgUser, savedData) {
    const userId = tgUser.id;
    let user = userDB.get(userId);
    if (!user) {
        user = { 
            xp: 0, matches: 0, wins: 0, streak: 0, coins: 100,
            name: tgUser.first_name, 
            username: tgUser.username ? tgUser.username.toLowerCase() : null,
            inventory: ['skin_white', 'bg_default', 'frame_default'], 
            equipped: { skin: 'skin_white', bg: 'bg_default', frame: 'frame_default', hat: null }
        };
    } else {
        user.name = tgUser.first_name;
        user.username = tgUser.username ? tgUser.username.toLowerCase() : null;
    }
    if (savedData) {
        if (typeof savedData.xp === 'number') user.xp = Math.max(user.xp, savedData.xp);
        if (typeof savedData.coins === 'number') user.coins = savedData.coins;
        if (typeof savedData.matches === 'number') user.matches = Math.max(user.matches, savedData.matches);
        if (typeof savedData.wins === 'number') user.wins = Math.max(user.wins, savedData.wins);
        if (typeof savedData.streak === 'number') user.streak = savedData.streak;
        if (Array.isArray(savedData.inventory)) {
            const combined = new Set([...user.inventory, ...savedData.inventory]);
            user.inventory = Array.from(combined);
        }
        if (savedData.equipped) user.equipped = { ...user.equipped, ...savedData.equipped };
    }
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

function updateUserXP(userId, type, difficulty = null, betCoins = 0, betXp = 0, winnerPotMultiplier = 0) {
    if (typeof userId === 'string' && userId.startsWith('bot')) return null;
    const user = getUserData(userId);
    const currentRankInfo = getRankInfo(user.xp, user.streak);
    
    if (type === 'win_game') {
        user.matches++; user.wins++; user.streak++;
        user.xp += 65; user.coins += 50;
        if(winnerPotMultiplier > 0) {
            user.coins += (betCoins * winnerPotMultiplier);
            user.xp += (betXp * winnerPotMultiplier);
        }
    } 
    else if (type === 'lose_game') {
        user.matches++; user.streak = 0;
        if (currentRankInfo.current.penalty) user.xp -= currentRankInfo.current.penalty;
        user.coins += 10;
        user.coins -= betCoins;
        user.xp -= betXp;
    }
    else if (type === 'win_pve') {
        user.matches++;
        if (difficulty === 'medium') { user.xp += 10; user.coins += 10; }
        else if (difficulty === 'pirate') { user.xp += 40; user.coins += 40; }
    }
    else if (type === 'lose_pve') {
        user.matches++;
    }

    if (user.xp < 0) user.xp = 0;
    if (user.coins < 0) user.coins = 0;

    // CHECK HAT REQUIREMENTS AFTER XP CHANGE
    const newRankInfo = getRankInfo(user.xp, user.streak);
    if (user.equipped.hat && newRankInfo.current.level < 6) {
        // Lost Captain status -> Unequip hat
        user.equipped.hat = null;
    }

    userDB.set(userId, user);
    return user;
}

function findUserIdByUsername(input) {
    if(!input) return null;
    const target = input.toLowerCase().replace('@', '').trim();
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
    const sockets = Array.from(io.sockets.sockets.values());
    const s = sockets.find(s => s.tgUserId === uid);
    if (s) return s.id;
    return null;
}

function pushProfileUpdate(userId) {
    const socketId = findSocketIdByUserId(userId);
    if (socketId) {
        const user = userDB.get(userId);
        const rInfo = getRankInfo(user.xp, user.streak);
        io.to(socketId).emit('profileUpdate', { 
            ...user, rankName: rInfo.current.name, currentRankMin: rInfo.current.min, nextRankXP: rInfo.next?.min, rankLevel: rInfo.current.level 
        });
    }
}

// --- 3. GAME LOGIC ---
function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function rollDice(count) { return Array.from({length: count}, () => Math.floor(Math.random() * 6) + 1).sort((a,b)=>a-b); }
function getRoomBySocketId(id) { for (const [k,v] of rooms) if (v.players.find(p=>p.id===id)) return v; return null; }

function resolveBackground(room) {
    if (room.isPvE) return 'bg_default';
    const creator = room.players.find(p => p.isCreator);
    if (creator && creator.tgId) {
        const uData = getUserData(creator.tgId);
        if (uData.equipped.bg && uData.equipped.bg !== 'bg_default') return uData.equipped.bg;
    }
    const candidates = room.players.filter(p => !p.isBot && p.tgId).map(p => {
        const uData = getUserData(p.tgId); 
        const rInfo = getRankInfo(uData.xp, uData.streak);
        return { bg: uData.equipped.bg || 'bg_default', rankLevel: rInfo.current.level, streak: uData.streak };
    }).filter(c => c.bg !== 'bg_default');
    if (candidates.length === 0) return 'bg_default';
    candidates.sort((a, b) => {
        if (b.rankLevel !== a.rankLevel) return b.rankLevel - a.rankLevel;
        return b.streak - a.streak;
    });
    return candidates[0].bg;
}

function broadcastGameState(room) {
    const now = Date.now();
    const remaining = Math.max(0, room.turnDeadline - now);
    const playersData = room.players.map((p, i) => {
        let availableSkills = [];
        if (!p.isBot && p.tgId && p.diceCount > 0) {
            const uData = getUserData(p.tgId);
            const rankInfo = getRankInfo(uData.xp, uData.streak);
            const lvl = rankInfo.current.level;
            const used = p.skillsUsed || [];
            if (lvl >= 4 && !used.includes('ears')) availableSkills.push('ears'); 
            if (lvl >= 5 && !used.includes('lucky')) availableSkills.push('lucky'); 
            if (lvl >= 6 && !used.includes('kill')) availableSkills.push('kill'); 
        }
        return { 
            name: p.name, rank: p.rank, diceCount: p.diceCount, 
            isTurn: i === room.currentTurn, isEliminated: p.diceCount === 0, 
            id: p.id, equipped: p.equipped, availableSkills: availableSkills
        };
    });
    io.to(room.id).emit('gameState', {
        players: playersData, currentBid: room.currentBid, 
        totalDuration: room.turnDuration, remainingTime: remaining,
        activeRules: { jokers: room.config.jokers, spot: room.config.spot, strict: room.config.strict },
        activeBackground: room.activeBackground
    });
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
    room.activeBackground = resolveBackground(room); 
    room.players.forEach(p => {
        if (isFirst) {
            if (p.diceCount === 0) p.diceCount = room.config.dice;
            p.skillsUsed = []; 
        }
        p.dice = p.diceCount > 0 ? rollDice(p.diceCount) : [];
    });
    if (startIdx !== null) room.currentTurn = startIdx;
    else if (isFirst) room.currentTurn = 0;
    let safety = 0;
    while (room.players[room.currentTurn].diceCount === 0) {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
        safety++;
        if(safety > 20) break;
    }
    room.players.forEach(p => { if (p.diceCount > 0 && !p.isBot) io.to(p.id).emit('yourDice', p.dice); });
    io.to(room.id).emit('gameEvent', { text: `🎲 РАУНД!`, type: 'info' });
    broadcastGameState(room);
    resetTurnTimer(room);
}

function nextTurn(room) {
    let loopCount = 0;
    do {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
        loopCount++;
        if (loopCount > 20) return; 
    } while (room.players[room.currentTurn].diceCount === 0);
    resetTurnTimer(room); 
    broadcastGameState(room);
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
        if(room.config.strict) faceValue = 6; else { faceValue = 2; quantity++; }
    }
    room.currentBid = { quantity, faceValue, playerId: player.id };
    io.to(room.id).emit('gameEvent', { text: `${player.name} ставит: ${quantity}x[${faceValue}]`, type: 'info' });
    nextTurn(room);
}

function checkEliminationAndContinue(room, loser, killer) {
    const betCoins = room.config.betCoins || 0;
    const betXp = room.config.betXp || 0;

    if (loser.diceCount === 0) {
        if (!loser.isBot && loser.tgId) {
            const d = updateUserXP(loser.tgId, room.isPvE ? 'lose_pve' : 'lose_game', null, betCoins, betXp, 0);
            if(d) pushProfileUpdate(loser.tgId);
        }
        io.to(room.id).emit('gameEvent', { text: `💀 ${loser.name} выбывает!`, type: 'error' });
    }
    const active = room.players.filter(p => p.diceCount > 0);
    if (active.length === 1) {
        const winner = active[0];
        room.status = 'FINISHED';
        if (room.timerId) clearTimeout(room.timerId);
        if (!winner.isBot && winner.tgId) {
            const type = room.isPvE ? 'win_pve' : 'win_game';
            const diff = room.isPvE ? room.config.difficulty : null;
            const multiplier = room.players.length - 1; 
            updateUserXP(winner.tgId, type, diff, betCoins, betXp, multiplier);
            pushProfileUpdate(winner.tgId);
        }
        io.to(room.id).emit('gameOver', { winner: winner.name });
    } else {
        let nextIdx = room.players.indexOf(loser);
        if (nextIdx === -1 || loser.diceCount === 0) {
            let searchStart = nextIdx !== -1 ? nextIdx : room.currentTurn;
            let loopCount = 0;
            do {
                searchStart = (searchStart + 1) % room.players.length;
                loopCount++;
                if(loopCount > 20) break;
            } while (room.players[searchStart].diceCount === 0);
            nextIdx = searchStart;
        }
        startNewRound(room, false, nextIdx);
    }
}

function handleCall(socket, type, roomOverride = null, playerOverride = null) {
    const r = roomOverride || getRoomBySocketId(socket.id);
    if (!r || r.status !== 'PLAYING' || !r.currentBid) return;
    const challenger = playerOverride || r.players[r.players.findIndex(p => p.id === socket.id)];
    if (!challenger || r.players[r.currentTurn].id !== challenger.id) return;
    if (r.timerId) clearTimeout(r.timerId);
    const bidder = r.players.find(x => x.id === r.currentBid.playerId);
    if (!bidder) { startNewRound(r, false, r.currentTurn); return; }
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

function handleBotMove(room) {
    if (room.status !== 'PLAYING') return;
    const bot = room.players[room.currentTurn];
    if (!bot || bot.diceCount === 0) { nextTurn(room); return; }
    const lastBid = room.currentBid;
    let totalDiceInGame = 0; room.players.forEach(p => totalDiceInGame += p.diceCount);
    const myHand = {}; bot.dice.forEach(d => myHand[d] = (myHand[d] || 0) + 1);
    const diff = room.config.difficulty;
    if (!lastBid) {
        const face = bot.dice[0] || Math.floor(Math.random()*6)+1;
        makeBidInternal(room, bot, 1, face); return;
    }
    const needed = lastBid.quantity; const face = lastBid.faceValue;
    const inHand = myHand[face] || 0;
    const inHandJokers = room.config.jokers ? (myHand[1] || 0) : 0;
    const mySupport = (face === 1 && room.config.jokers) ? inHand : (inHand + (face !== 1 ? inHandJokers : 0));
    const unknownDice = totalDiceInGame - bot.diceCount;
    const probPerDie = room.config.jokers ? (face===1 ? 1/6 : 2/6) : 1/6;
    const expectedTotal = mySupport + (unknownDice * probPerDie);
    let threshold = diff === 'easy' ? 2.0 : diff === 'medium' ? 0.5 : -0.5;
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

function handleTimeout(room) {
    if (room.status !== 'PLAYING') return;
    const loser = room.players[room.currentTurn];
    if (!loser) { nextTurn(room); return; } 
    io.to(room.id).emit('gameEvent', { text: `⏳ ${loser.name} уснул и выбывает!`, type: 'error' });
    loser.diceCount = 0; 
    checkEliminationAndContinue(room, loser, null);
}

function resetTurnTimer(room) {
    if (room.timerId) clearTimeout(room.timerId);
    const duration = room.config.time * 1000;
    room.turnDuration = duration;
    room.turnDeadline = Date.now() + duration;
    broadcastGameState(room);
    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer || currentPlayer.diceCount === 0) { nextTurn(room); return; }
    if (currentPlayer.isBot) {
        const thinkTime = Math.random() * 2000 + 2000;
        room.timerId = setTimeout(() => handleBotMove(room), thinkTime);
    } else {
        room.timerId = setTimeout(() => handleTimeout(room), duration);
    }
}

function handlePlayerDisconnect(socketId, room, isVoluntary = false) {
    const i = room.players.findIndex(p => p.id === socketId);
    if (i === -1) return;
    const player = room.players[i];
    const wasCreator = player.isCreator;
    
    if (room.status === 'PLAYING') {
        if (isVoluntary) {
            io.to(room.id).emit('gameEvent', { text: `🏃‍♂️ ${player.name} сдался и покинул стол!`, type: 'error' });
            if (player.diceCount > 0) {
                player.diceCount = 0;
                if (!player.isBot && player.tgId) {
                    updateUserXP(player.tgId, room.isPvE ? 'lose_pve' : 'lose_game', null, room.config.betCoins, room.config.betXp);
                }
            }
            room.players.splice(i, 1);
            if (i === room.currentTurn) {
                if (room.currentTurn >= room.players.length) room.currentTurn = 0;
                resetTurnTimer(room);
            } else if (i < room.currentTurn) {
                room.currentTurn--;
            }
            const active = room.players.filter(p => p.diceCount > 0);
            if (active.length === 1) {
                const winner = active[0]; room.status = 'FINISHED';
                if (room.timerId) clearTimeout(room.timerId);
                if (!winner.isBot && winner.tgId) {
                    const type = room.isPvE ? 'win_pve' : 'win_game';
                    const diff = room.isPvE ? room.config.difficulty : null;
                    const multiplier = room.players.length; 
                    updateUserXP(winner.tgId, type, diff, room.config.betCoins, room.config.betXp, multiplier);
                }
                io.to(room.id).emit('gameOver', { winner: winner.name });
            } else {
                broadcastGameState(room);
            }
        } else {
            io.to(room.id).emit('gameEvent', { text: `🔌 ${player.name} отключился...`, type: 'error' });
        }
    } else {
        io.to(room.id).emit('gameEvent', { text: `🏃‍♂️ ${player.name} ушел!`, type: 'error' });
        room.players.splice(i, 1);
        if (room.players.filter(p => !p.isBot).length === 0) { if(room.timerId) clearTimeout(room.timerId); rooms.delete(room.id); }
        else { if (wasCreator && room.players[0]) room.players[0].isCreator = true; broadcastRoomUpdate(room); }
    }
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

    console.log(`[SKILL] Player ${player.name} tries ${skillType}. Level: ${level}`);

    try {
        if (skillType === 'ears') {
            if (level < 4) return socket.emit('errorMsg', 'Нужен ранг Боцман');
            if (room.currentTurn !== room.players.indexOf(player)) return socket.emit('errorMsg', 'Только в свой ход');
            if (!room.currentBid) return socket.emit('errorMsg', 'Ставок нет');
            let chance = level === 4 ? 0.35 : level === 5 ? 0.50 : level === 6 ? 0.75 : 1.0;
            if (Math.random() < chance) {
                const bid = room.currentBid; let total = 0;
                room.players.forEach(p => { p.dice.forEach(d => { if (d === bid.faceValue || (room.config.jokers && d===1 && bid.faceValue!==1)) total++; }) });
                const isLying = total < bid.quantity;
                socket.emit('skillResult', { type: 'ears', text: isLying ? "Он ВРЁТ!" : "Похоже на правду..." });
            } else socket.emit('skillResult', { type: 'ears', text: "Ничего не слышно..." });
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
                socket.emit('skillResult', { type: 'lucky', text: "Вы достали кубик из рукава!" });
            } else socket.emit('skillResult', { type: 'lucky', text: "Фокус не удался..." });
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
    } catch(e) { console.error(e); socket.emit('errorMsg', 'Ошибка навыка'); }
}

// --- 4. ADMIN COMMANDS ---
const bot = token ? new TelegramBot(token, { polling: true }) : null;
if (bot) {
    bot.on('message', (msg) => {
        const chatId = msg.chat.id; const text = (msg.text || '').trim(); const fromId = msg.from.id;
        if (text.toLowerCase().startsWith('/start')) {
            bot.sendMessage(chatId, "☠️ Костяшки", { reply_markup: { inline_keyboard: [[{ text: "🎲 ИГРАТЬ", web_app: { url: 'https://liarsdicezmss.onrender.com' } }]] } }); return;
        }
        if (fromId !== ADMIN_ID) return;
        const args = text.split(' '); const cmd = args[0].toLowerCase();
        const refreshUser = (uid) => { pushProfileUpdate(uid); const socketId = findSocketIdByUserId(uid); if (socketId) { const room = getRoomBySocketId(socketId); if (room) broadcastGameState(room); } };

        if (cmd === '/me') {
            const user = userDB.get(ADMIN_ID); if (!user) return bot.sendMessage(chatId, "Enter game first");
            if (args[1] === 'rich') { user.coins = 100000000; userDB.set(ADMIN_ID, user); refreshUser(ADMIN_ID); bot.sendMessage(chatId, "Rich"); }
            if (args[1] === 'xp') { user.xp = parseInt(args[2] || 0); userDB.set(ADMIN_ID, user); refreshUser(ADMIN_ID); bot.sendMessage(chatId, `XP: ${user.xp}`); }
        }
        else if (cmd === '/givehat') {
            // /givehat @username hat_id
            if (args.length < 3) return bot.sendMessage(chatId, "/givehat @user hat_id");
            const uid = findUserIdByUsername(args[1]); 
            if (!uid) return bot.sendMessage(chatId, "User not found");
            const user = userDB.get(uid);
            const hatId = args[2];
            if (!user.inventory.includes(hatId)) user.inventory.push(hatId);
            userDB.set(uid, user); refreshUser(uid);
            bot.sendMessage(chatId, `Gave ${hatId} to ${user.name}`);
        }
        else if (cmd === '/removehat') {
            if (args.length < 3) return;
            const uid = findUserIdByUsername(args[1]); if (!uid) return;
            const user = userDB.get(uid);
            const hatId = args[2];
            user.inventory = user.inventory.filter(i => i !== hatId);
            if (user.equipped.hat === hatId) user.equipped.hat = null;
            userDB.set(uid, user); refreshUser(uid);
            bot.sendMessage(chatId, `Removed ${hatId}`);
        }
        else if (cmd === '/setxp') {
            if (args.length < 3) return;
            const uid = findUserIdByUsername(args[1]); if (!uid) return;
            const user = userDB.get(uid); user.xp = parseInt(args[2]);
            if(user.xp>=75000) user.streak=100;
            userDB.set(uid, user); refreshUser(uid);
            bot.sendMessage(chatId, `XP ${user.xp}`);
        }
        else if (cmd === '/setcoins') {
            if (args.length < 3) return;
            const uid = findUserIdByUsername(args[1]); if (!uid) return;
            const user = userDB.get(uid); user.coins = parseInt(args[2]);
            userDB.set(uid, user); refreshUser(uid);
            bot.sendMessage(chatId, `Coins ${user.coins}`);
        }
        else if (cmd === '/rich') {
            if (args.length < 2) return;
            const uid = findUserIdByUsername(args[1]); if (!uid) return;
            const user = userDB.get(uid); user.coins = 100000000;
            userDB.set(uid, user); refreshUser(uid);
            bot.sendMessage(chatId, "Rich");
        }
        else if (cmd === '/win') {
            const socketId = findSocketIdByUserId(ADMIN_ID); if(!socketId) return bot.sendMessage(chatId, "You are not in a room");
            const room = getRoomBySocketId(socketId); if (!room || room.status !== 'PLAYING') return bot.sendMessage(chatId, "Not active");
            room.players.forEach(p => { if (p.tgId !== ADMIN_ID) p.diceCount = 0; });
            checkEliminationAndContinue(room, {diceCount:0, isBot:true}, null);
            bot.sendMessage(chatId, "Win");
        }
        else if (cmd === '/unlockall') {
            if (args.length < 2) return;
            const uid = findUserIdByUsername(args[1]); if (!uid) return;
            const user = userDB.get(uid);
            // Add all hats to unlock all
            const allHats = Object.keys(HATS);
            user.inventory = [
                'skin_white', 'skin_red', 'skin_gold', 'skin_black', 'skin_blue', 'skin_green', 'skin_purple', 'skin_cyber', 'skin_bone',
                'bg_default', 'bg_lvl1', 'bg_lvl2', 'bg_lvl3', 'bg_lvl4', 'bg_lvl5',
                'frame_default', 'frame_wood', 'frame_silver', 'frame_gold', 'frame_fire', 'frame_ice', 'frame_neon', 'frame_royal', 'frame_ghost', 'frame_kraken', 'frame_captain',
                ...allHats
            ];
            userDB.set(uid, user); refreshUser(uid);
            bot.sendMessage(chatId, "Unlocked all items");
        }
        else if (cmd === '/reset') {
            if (args.length < 2) return;
            const uid = findUserIdByUsername(args[1]); if (!uid) return;
            const user = userDB.get(uid);
            user.xp = 0; user.coins = 0; user.wins = 0; user.matches = 0; user.streak = 0;
            user.inventory = ['skin_white', 'bg_default', 'frame_default'];
            user.equipped = { skin: 'skin_white', bg: 'bg_default', frame: 'frame_default', hat: null };
            userDB.set(uid, user); refreshUser(uid);
            bot.sendMessage(chatId, `Reset: ${user.name}`);
        }
    });
}

// --- 5. SOCKET LISTENERS ---
io.on('connection', (socket) => {
    socket.on('login', ({ tgUser, savedData }) => {
        if (!tgUser) return;
        const data = syncUserData(tgUser, savedData);
        const rank = getRankInfo(data.xp, data.streak);
        socket.tgUserId = tgUser.id;
        socket.emit('profileUpdate', { 
            ...data, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level 
        });

        // --- RECONNECTION LOGIC ---
        for (const [roomId, room] of rooms) {
            if (room.status === 'PLAYING') {
                const existingPlayer = room.players.find(p => p.tgId === tgUser.id);
                if (existingPlayer) {
                    existingPlayer.id = socket.id;
                    socket.join(roomId);
                    if(existingPlayer.diceCount > 0) socket.emit('yourDice', existingPlayer.dice);
                    
                    const now = Date.now();
                    const remaining = Math.max(0, room.turnDeadline - now);
                    const playersData = room.players.map((p, i) => {
                        let availableSkills = [];
                        if (!p.isBot && p.tgId && p.diceCount > 0) {
                            const uData = getUserData(p.tgId);
                            const rankInfo = getRankInfo(uData.xp, uData.streak);
                            const lvl = rankInfo.current.level;
                            const used = p.skillsUsed || [];
                            if (lvl >= 4 && !used.includes('ears')) availableSkills.push('ears'); 
                            if (lvl >= 5 && !used.includes('lucky')) availableSkills.push('lucky'); 
                            if (lvl >= 6 && !used.includes('kill')) availableSkills.push('kill'); 
                        }
                        return { 
                            name: p.name, rank: p.rank, diceCount: p.diceCount, 
                            isTurn: i === room.currentTurn, isEliminated: p.diceCount === 0, 
                            id: p.id, equipped: p.equipped, availableSkills: availableSkills
                        };
                    });

                    socket.emit('gameState', {
                        players: playersData, currentBid: room.currentBid, 
                        totalDuration: room.turnDuration, remainingTime: remaining,
                        activeRules: { jokers: room.config.jokers, spot: room.config.spot, strict: room.config.strict },
                        activeBackground: room.activeBackground
                    });
                    socket.emit('gameEvent', { text: '🔄 Вы вернулись в игру!', type: 'info' });
                }
            }
        }
    });
    
    socket.on('leaveRoom', () => { const r = getRoomBySocketId(socket.id); if(r) handlePlayerDisconnect(socket.id, r, true); });
    
    socket.on('shopBuy', (itemId) => { 
        if (!socket.tgUserId) return;
        const user = getUserData(socket.tgUserId);
        const PRICES = { 'skin_red': 200, 'skin_gold': 1000, 'skin_black': 500, 'skin_blue': 300, 'skin_green': 400, 'skin_purple': 800, 'skin_cyber': 1500, 'skin_bone': 2500, 'bg_lvl1': 150000, 'bg_lvl2': 150000, 'bg_lvl3': 150000, 'bg_lvl4': 150000, 'bg_lvl5': 500000, 'frame_wood': 100, 'frame_silver': 300, 'frame_gold': 500, 'frame_fire': 1500, 'frame_ice': 1200, 'frame_neon': 2000, 'frame_royal': 5000, 'frame_ghost': 3000, 'frame_kraken': 4000, 'frame_captain': 10000 };
        const price = PRICES[itemId];
        if (price && user.coins >= price && !user.inventory.includes(itemId)) {
            user.coins -= price; user.inventory.push(itemId); userDB.set(socket.tgUserId, user);
            const rank = getRankInfo(user.xp, user.streak);
            socket.emit('profileUpdate', { ...user, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level });
            socket.emit('gameEvent', { text: 'Покупка успешна!', type: 'info' });
        }
    });

    socket.on('hatBuy', (hatId) => {
        if (!socket.tgUserId) return;
        const user = getUserData(socket.tgUserId);
        const hat = HATS[hatId];
        if (hat && user.coins >= hat.price && !user.inventory.includes(hatId)) {
            const rInfo = getRankInfo(user.xp, user.streak);
            if (rInfo.current.level < hat.level) {
                socket.emit('errorMsg', 'Ранг слишком низок!'); return;
            }
            user.coins -= hat.price; 
            user.inventory.push(hatId); 
            userDB.set(socket.tgUserId, user);
            socket.emit('profileUpdate', { ...user, rankName: rInfo.current.name, currentRankMin: rInfo.current.min, nextRankXP: rInfo.next?.min || 'MAX', rankLevel: rInfo.current.level });
            socket.emit('gameEvent', { text: 'Шляпа куплена!', type: 'info' });
        } else {
            socket.emit('errorMsg', 'Ошибка покупки');
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
            socket.emit('profileUpdate', { ...user, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level });
            const room = getRoomBySocketId(socket.id); if(room) { const p = room.players.find(pl => pl.id === socket.id); if(p) { p.equipped = {...user.equipped}; if(room.status==='LOBBY') broadcastRoomUpdate(room); } }
        }
    });

    socket.on('hatEquip', (hatId) => {
        if (!socket.tgUserId) return;
        const user = getUserData(socket.tgUserId);
        if (hatId === null) {
            user.equipped.hat = null; // Unequip
        } else if (user.inventory.includes(hatId)) {
            user.equipped.hat = hatId;
        }
        userDB.set(socket.tgUserId, user);
        const rank = getRankInfo(user.xp, user.streak);
        socket.emit('profileUpdate', { ...user, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level });
        const room = getRoomBySocketId(socket.id); if(room) { const p = room.players.find(pl => pl.id === socket.id); if(p) { p.equipped = {...user.equipped}; if(room.status==='LOBBY') broadcastRoomUpdate(room); } }
    });

    socket.on('sendEmote', (emoji) => { const room = getRoomBySocketId(socket.id); if(room) io.to(room.id).emit('emoteReceived', { id: socket.id, emoji: emoji }); });
    socket.on('useSkill', (skillType) => handleSkill(socket, skillType));
    socket.on('getPlayerStats', (targetId) => {
        let userData = null;
        if (targetId === 'me') { if (socket.tgUserId) userData = getUserData(socket.tgUserId); }
        else if (!targetId.startsWith('bot') && !targetId.startsWith('CPU')) { const room = getRoomBySocketId(socket.id); if(room) { const tp = room.players.find(p=>p.id===targetId); if(tp && tp.tgId) userData = getUserData(tp.tgId); } }
        if (userData) { 
            const rank = getRankInfo(userData.xp, userData.streak); 
            socket.emit('showPlayerStats', { name: userData.name, rankName: rank.current.name, matches: userData.matches, wins: userData.wins, inventory: userData.inventory, equipped: userData.equipped }); 
        }
    });
    socket.on('joinOrCreateRoom', ({ roomId, tgUser, options, mode }) => {
        const old = getRoomBySocketId(socket.id); if (old) handlePlayerDisconnect(socket.id, old, true);
        if (!tgUser) return;
        const userId = tgUser.id; const uData = getUserData(userId); const rInfo = getRankInfo(uData.xp, uData.streak);
        
        if (options && (options.betCoins > uData.coins || options.betXp > uData.xp)) {
            socket.emit('errorMsg', 'NO_FUNDS'); 
            return;
        }

        let room; let isCreator = false;
        if (mode === 'pve') {
            const newId = 'CPU_' + Math.random().toString(36).substring(2,6);
            room = { id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null, history: [], timerId: null, turnDeadline: 0, config: { dice: options.dice, players: options.players, time: 30, jokers: options.jokers, spot: options.spot, strict: options.strict, difficulty: options.difficulty }, isPvE: true };
            rooms.set(newId, room); isCreator = true;
            room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: room.config.dice, ready: true, isCreator: true, equipped: uData.equipped });
            const botNames = ['Джек', 'Барбосса', 'Уилл', 'Дейви Джонс', 'Тич', 'Гиббс'];
            for(let i=0; i<options.players-1; i++) { room.players.push({ id: 'bot_' + Math.random(), name: `${botNames[i%botNames.length]} (Бот)`, rank: options.difficulty === 'pirate' ? 'Капитан' : 'Матрос', dice: [], diceCount: room.config.dice, ready: true, isCreator: false, isBot: true, equipped: { frame: 'frame_default' } }); }
            socket.join(newId); startNewRound(room, true); return;
        }
        if (roomId) { 
            room = rooms.get(roomId); 
            if (!room || room.status !== 'LOBBY' || room.players.length >= room.config.players) { socket.emit('errorMsg', 'Ошибка входа'); return; } 
            if (room.config.betCoins > uData.coins || room.config.betXp > uData.xp) {
                socket.emit('errorMsg', 'NO_FUNDS');
                return;
            }
        }
        else { const newId = generateRoomId(); const st = options || { dice: 5, players: 10, time: 30 }; room = { id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null, history: [], timerId: null, turnDeadline: 0, config: st, isPvE: false }; rooms.set(newId, room); roomId = newId; isCreator = true; }
        room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: room.config.dice, ready: false, isCreator: isCreator, equipped: uData.equipped });
        socket.join(roomId); broadcastRoomUpdate(room);
    });
    socket.on('setReady', (isReady) => { const r = getRoomBySocketId(socket.id); if (r?.status === 'LOBBY') { const p = r.players.find(x => x.id === socket.id); if (p) { p.ready = isReady; broadcastRoomUpdate(r); } } });
    socket.on('startGame', () => { const r = getRoomBySocketId(socket.id); if (r) { const p = r.players.find(x => x.id === socket.id); if (p?.isCreator && r.players.length >= 2 && r.players.every(x => x.ready)) startNewRound(r, true); } });
    socket.on('makeBid', ({ quantity, faceValue }) => { const r = getRoomBySocketId(socket.id); if (!r || r.status !== 'PLAYING' || r.players[r.currentTurn].id !== socket.id) return; makeBidInternal(r, r.players[r.currentTurn], parseInt(quantity), parseInt(faceValue)); });
    socket.on('callBluff', () => handleCall(socket, 'bluff'));
    socket.on('callSpot', () => handleCall(socket, 'spot'));
    socket.on('requestRestart', () => { const r = getRoomBySocketId(socket.id); if (r?.status === 'FINISHED') { r.players.forEach(p => { if (!p.isBot && p.tgId) pushProfileUpdate(p.tgId); }); if (r.isPvE) { r.status = 'PLAYING'; r.players.forEach(p => { p.diceCount = r.config.dice; p.dice = []; p.skillsUsed = []; }); r.currentBid = null; startNewRound(r, true); } else { r.status = 'LOBBY'; r.players.forEach(p => { p.diceCount = r.config.dice; p.ready = false; p.dice = []; p.skillsUsed = []; }); r.currentBid = null; broadcastRoomUpdate(r); } } });
    socket.on('disconnect', () => { const r = getRoomBySocketId(socket.id); if (r) handlePlayerDisconnect(socket.id, r, false); });
});

const PING_INTERVAL = 14 * 60 * 1000;
const MY_URL = 'https://liarsdicezmss.onrender.com/ping';
setInterval(() => { 
    https.get(MY_URL, (res) => {}).on('error', (err) => { console.error("Ping error:", err.message); }); 
}, PING_INTERVAL);

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
