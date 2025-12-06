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
    'hat_fallen': { price: 1000000, level: 6 },
    'hat_rich': { price: 1000000, level: 6 },
    'hat_underwater': { price: 1000000, level: 6 },
    'hat_voodoo': { price: 1000000, level: 6 },
    'hat_king_voodoo': { price: 10000000, level: 6 },
    'hat_cursed': { price: 10000000, level: 6 },
    'hat_flame': { price: 10000000, level: 6 },
    'hat_frozen': { price: 10000000, level: 6 },
    'hat_ghost': { price: 10000000, level: 6 },
    'hat_lava': { price: 100000000, level: 7 },
    'hat_deadlycursed': { price: 100000000, level: 7 },
    'hat_antarctica': { price: 100000000, level: 7 }
};

const userDB = new Map();
const rooms = new Map();

function getUserData(userId) {
    if (!userDB.has(userId)) {
        userDB.set(userId, { 
            xp: 0, matches: 0, wins: 0, streak: 0, coins: 100,
            matchHistory: [], lossStreak: 0,
            friends: [], requests: [], 
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
            matchHistory: [], lossStreak: 0,
            friends: [], requests: [],
            name: tgUser.first_name, 
            username: tgUser.username ? tgUser.username.toLowerCase() : null,
            inventory: ['skin_white', 'bg_default', 'frame_default'], 
            equipped: { skin: 'skin_white', bg: 'bg_default', frame: 'frame_default', hat: null }
        };

        if (savedData) {
            if (typeof savedData.xp === 'number') user.xp = savedData.xp; 
            if (typeof savedData.coins === 'number') user.coins = savedData.coins;
            if (typeof savedData.matches === 'number') user.matches = savedData.matches;
            if (typeof savedData.wins === 'number') user.wins = savedData.wins;
            if (typeof savedData.streak === 'number') user.streak = savedData.streak;
            if (Array.isArray(savedData.friends)) user.friends = savedData.friends;
            if (Array.isArray(savedData.requests)) user.requests = savedData.requests;
            if (Array.isArray(savedData.inventory)) {
                const combined = new Set([...user.inventory, ...savedData.inventory]);
                user.inventory = Array.from(combined);
            }
            if (savedData.equipped) user.equipped = { ...user.equipped, ...savedData.equipped };
        }
    } else {
        user.name = tgUser.first_name;
        user.username = tgUser.username ? tgUser.username.toLowerCase() : null;
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
    const oldRankInfo = getRankInfo(user.xp, user.streak);
    const skin = user.equipped.skin;

    if (!user.matchHistory) user.matchHistory = [];
    if (typeof user.lossStreak === 'undefined') user.lossStreak = 0;

    let baseWinXP = 65;
    let baseWinCoins = 50;
    
    if (type === 'win_pve') {
        if (difficulty === 'medium') { baseWinXP = 10; baseWinCoins = 10; }
        else if (difficulty === 'pirate') { baseWinXP = 40; baseWinCoins = 40; }
    }

    let potCoins = 0;
    let potXP = 0;
    if (winnerPotMultiplier > 0) {
        potCoins = betCoins * winnerPotMultiplier;
        potXP = betXp * winnerPotMultiplier;
    }

    let deltaCoins = 0;
    let deltaXP = 0;
    let reportDetails = [];

    if (type === 'win_game' || type === 'win_pve') {
        user.matches++; user.wins++; user.streak++; user.lossStreak = 0;
        
        let totalMatchCoins = baseWinCoins + potCoins;
        let totalMatchXP = baseWinXP + potXP;

        user.matchHistory.push({ c: totalMatchCoins, x: totalMatchXP });
        if (user.matchHistory.length > 10) user.matchHistory.shift();

        const calcAvg = (n) => {
            const slice = user.matchHistory.slice(-n);
            if (slice.length === 0) return { c: 0, x: 0 };
            const sumC = slice.reduce((a, b) => a + b.c, 0);
            const sumX = slice.reduce((a, b) => a + b.x, 0);
            return { c: sumC / slice.length, x: sumX / slice.length };
        };

        let bonusMultiplierCoins = 1.0;
        let bonusMultiplierXP = 1.0;
        let flatBonusCoins = 0;
        let flatBonusXP = 0;

        if (skin !== 'skin_green' && user.streak > 0 && user.streak % 10 === 0) {
            const avg10 = calcAvg(10);
            const bC = Math.floor(avg10.c * 0.10);
            const bX = Math.floor(avg10.x * 0.10);
            flatBonusCoins += bC;
            flatBonusXP += bX;
            reportDetails.push(`Серия 10 побед: +${bC}💰 +${bX}⭐`);
        }

        if (skin === 'skin_gold') { 
            bonusMultiplierCoins += 0.15; bonusMultiplierXP -= 0.10;
            reportDetails.push("Золото: +15%💰 -10%⭐");
        }
        if (skin === 'skin_black') { 
            bonusMultiplierCoins -= 0.10; bonusMultiplierXP += 0.15;
            reportDetails.push("Метка: -10%💰 +15%⭐");
        }

        if (skin === 'skin_red' && user.streak > 0 && user.streak % 5 === 0) {
            const avg5 = calcAvg(5);
            const bC = Math.floor(avg5.c * 0.04);
            flatBonusCoins += bC;
            reportDetails.push(`Рубин (5 побед): +${bC}💰`);
        }

        if (skin === 'skin_green') {
            let poisonStack = Math.min(user.streak, 20);
            let poisonFactor = poisonStack / 100; 
            bonusMultiplierCoins += poisonFactor;
            bonusMultiplierXP += poisonFactor;
            if(poisonStack > 0) reportDetails.push(`Яд (x${poisonStack}): +${Math.round(poisonFactor*100)}%`);
        }

        if (skin === 'skin_purple') {
            const r = Math.random();
            if (r < 0.1) { 
                bonusMultiplierCoins += 1.0; 
                reportDetails.push("Вуду: ДЖЕКПОТ (x2)!");
            } else if (r > 0.9) {
                bonusMultiplierCoins = 0; 
                reportDetails.push("Вуду: Неудача (x0)...");
            }
        }

        deltaCoins = Math.floor((totalMatchCoins * bonusMultiplierCoins) + flatBonusCoins);
        deltaXP = Math.floor((totalMatchXP * bonusMultiplierXP) + flatBonusXP);

        if(potCoins > 0 || potXP > 0) reportDetails.unshift(`Банк: ${potCoins}💰 ${potXP}⭐`);
        reportDetails.unshift(`Победа: ${baseWinCoins}💰 ${baseWinXP}⭐`);

    } else if (type === 'lose_game' || type === 'lose_pve') {
        user.matches++; user.streak = 0; user.lossStreak++;

        let rankPenalty = oldRankInfo.current.penalty || 0;
        let xpLossBase = rankPenalty + betXp;
        let coinLossBase = betCoins;
        let consolation = 10;

        if (skin === 'skin_red') {
            xpLossBase = Math.floor(xpLossBase * 1.05);
            reportDetails.push("Рубин: -5% XP штраф");
        }
        if (skin === 'skin_blue') {
            xpLossBase = Math.floor(xpLossBase * 0.8);
            reportDetails.push("Морской: Штраф снижен");
        }
        if (skin === 'skin_bone') {
            coinLossBase = Math.floor(coinLossBase * 1.05);
            if (Math.random() < 0.2 && betCoins > 0) {
                consolation += Math.floor(betCoins * 0.10);
                reportDetails.push("Костяной: Возврат 10% ставки!");
            }
        }
        if (skin === 'skin_green') {
            let poisonLossStack = Math.min(user.lossStreak, 20);
            let f = 1.0 + (poisonLossStack / 100);
            xpLossBase = Math.floor(xpLossBase * f);
            coinLossBase = Math.floor(coinLossBase * f);
            consolation = 0;
            reportDetails.push(`Яд: Штраф увеличен (+${poisonLossStack}%)`);
        }

        deltaXP = -xpLossBase;
        deltaCoins = -coinLossBase + consolation;
        
        if (consolation > 0) reportDetails.push(`Утешение: +${consolation}💰`);
        if (coinLossBase > 0) reportDetails.push(`Потеря ставки: -${coinLossBase}💰`);
        if (xpLossBase > 0) reportDetails.push(`Потеря опыта: -${xpLossBase}⭐`);
    }

    user.xp += deltaCoins > 0 ? 0 : 0;
    user.coins += deltaCoins;
    user.xp += deltaXP;

    if (user.xp < 0) user.xp = 0;
    if (user.coins < 0) user.coins = 0;

    const newRankInfo = getRankInfo(user.xp, user.streak);
    if (user.equipped.hat && newRankInfo.current.level < 6) {
        user.equipped.hat = null;
    }

    let rankUpMsg = null;
    if (newRankInfo.current.level > oldRankInfo.current.level) {
        rankUpMsg = newRankInfo.current.name;
    }

    userDB.set(userId, user);

    return {
        coins: deltaCoins,
        xp: deltaXP,
        details: reportDetails,
        rankUp: rankUpMsg,
        streak: user.streak
    };
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
        const rank = getRankInfo(user.xp, user.streak);
        io.to(socketId).emit('profileUpdate', { 
            ...user, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level 
        });
    }
}

// --- 3. GAME LOGIC ---
function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function rollDice(count) { return Array.from({length: count}, () => Math.floor(Math.random() * 6) + 1).sort((a,b)=>a-b); }
function getRoomBySocketId(id) { for (const [k,v] of rooms) if (v.players.find(p=>p.id===id)) return v; return null; }

function resolveBackground(room) {
    if (room.isPvE) {
        const creator = room.players.find(p => p.isCreator);
        if (creator && creator.tgId) {
            const uData = getUserData(creator.tgId);
            return uData.equipped.bg || 'bg_default';
        }
        return 'bg_default';
    }
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
    
    if (startIdx !== null) {
        room.currentTurn = startIdx;
    } else if (isFirst) {
        room.currentTurn = Math.floor(Math.random() * room.players.length);
        io.to(room.id).emit('gameEvent', { text: `🎲 Первый ход: ${room.players[room.currentTurn].name}`, type: 'info' });
    }

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
    if (room.timerId) clearTimeout(room.timerId);

    const betCoins = room.config.betCoins || 0;
    const betXp = room.config.betXp || 0;

    if (loser.diceCount === 0) {
        if (!loser.isBot && loser.tgId) {
            const result = updateUserXP(loser.tgId, room.isPvE ? 'lose_pve' : 'lose_game', null, betCoins, betXp, 0);
            if(result) {
                pushProfileUpdate(loser.tgId);
                io.to(loser.id).emit('matchResults', result);
            }
        }
        io.to(room.id).emit('gameEvent', { text: `💀 ${loser.name} выбывает!`, type: 'error' });
    }
    const active = room.players.filter(p => p.diceCount > 0);
    if (active.length === 1) {
        const winner = active[0];
        room.status = 'FINISHED';
        if (!winner.isBot && winner.tgId) {
            const type = room.isPvE ? 'win_pve' : 'win_game';
            const diff = room.isPvE ? room.config.difficulty : null;
            const multiplier = room.players.length - 1; 
            const result = updateUserXP(winner.tgId, type, diff, betCoins, betXp, multiplier);
            
            pushProfileUpdate(winner.tgId);
            io.to(winner.id).emit('matchResults', result);
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
            io.to(room.id).emit('gameEvent', { text: `🏃‍♂‍ ${player.name} сдался и покинул стол!`, type: 'error' });
            if (player.diceCount > 0) {
                player.diceCount = 0;
                if (!player.isBot && player.tgId) {
                    const result = updateUserXP(player.tgId, room.isPvE ? 'lose_pve' : 'lose_game', null, room.config.betCoins, room.config.betXp);
                    if(result) io.to(player.id).emit('matchResults', result);
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
                    const result = updateUserXP(winner.tgId, type, diff, room.config.betCoins, room.config.betXp, multiplier);
                    io.to(winner.id).emit('matchResults', result);
                }
                io.to(room.id).emit('gameOver', { winner: winner.name });
            } else {
                broadcastGameState(room);
            }
        } else {
            io.to(room.id).emit('gameEvent', { text: `🔌 ${player.name} отключился...`, type: 'error' });
        }
    } else {
        io.to(room.id).emit('gameEvent', { text: `🏃‍♂‍ ${player.name} ушел!`, type: 'error' });
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
            
            if (Math.random() < 0.5) {
                const bid = room.currentBid; let total = 0;
                room.players.forEach(p => { p.dice.forEach(d => { if (d === bid.faceValue || (room.config.jokers && d===1 && bid.faceValue!==1)) total++; }) });
                const isLying = total < bid.quantity;
                socket.emit('skillResult', { type: 'ears', text: isLying ? "Он ВРЁТ!" : "Похоже на правду..." });
            } else socket.emit('skillResult', { type: 'ears', text: "Ничего не слышно..." });
            
            if(!player.skillsUsed) player.skillsUsed = []; 
            player.skillsUsed.push('ears'); 
            broadcastGameState(room);
        }
        else if (skillType === 'lucky') {
            if (level < 5) return socket.emit('errorMsg', 'Нужен ранг 1-й помощник');
            if (player.diceCount >= 5) return socket.emit('errorMsg', 'Максимум кубиков');
            
            if (Math.random() < 0.5) {
                player.diceCount++; player.dice.push(Math.floor(Math.random()*6)+1);
                io.to(room.id).emit('gameEvent', { text: `🎲 ${player.name} достал кубик!`, type: 'info' });
                io.to(player.id).emit('yourDice', player.dice); 
                socket.emit('skillResult', { type: 'lucky', text: "Вы достали кубик из рукава!" });
            } else {
                player.diceCount--;
                player.dice.pop();
                io.to(room.id).emit('gameEvent', { text: `🤡 ${player.name} уронил кубик!`, type: 'error' });
                io.to(player.id).emit('yourDice', player.dice);
                socket.emit('skillResult', { type: 'lucky', text: "Фокус не удался, кубик потерян!" });
                
                if(player.diceCount === 0) {
                    checkEliminationAndContinue(room, player, null);
                }
            }
            if(!player.skillsUsed) player.skillsUsed = []; 
            player.skillsUsed.push('lucky'); 
            broadcastGameState(room);
        }
        else if (skillType === 'kill') {
            if (level < 6) return socket.emit('errorMsg', 'Нужен ранг Капитан');
            const active = room.players.filter(p => p.diceCount > 0);
            if (active.length !== 2) return socket.emit('errorMsg', 'Нужно 1 на 1');
            const enemy = active.find(p => p.id !== player.id);
            if (player.diceCount !== 1 || enemy.diceCount !== 1) return socket.emit('errorMsg', 'У всех по 1 кубу');
            
            if (Math.random() < 0.5) {
                io.to(room.id).emit('gameEvent', { text: `🔫 ${player.name} пристрелил ${enemy.name}!`, type: 'info' });
                enemy.diceCount = 0; 
                checkEliminationAndContinue(room, enemy, player);
            } else {
                io.to(room.id).emit('gameEvent', { text: `🔫 ${player.name} промахнулся и застрелился!`, type: 'error' });
                player.diceCount = 0; 
                checkEliminationAndContinue(room, player, enemy);
            }
            if(!player.skillsUsed) player.skillsUsed = []; 
            player.skillsUsed.push('kill'); 
            broadcastGameState(room);
        }
    } catch(e) { console.error(e); socket.emit('errorMsg', 'Ошибка навыка'); }
}

// --- FRIEND LOGIC ---
io.on('connection', (socket) => {
    // ... (Merge with existing listeners)
    
    socket.on('friendAction', ({ action, payload }) => {
        if (!socket.tgUserId) return;
        const userId = socket.tgUserId;
        const user = getUserData(userId);

        if (action === 'get') {
            const list = user.friends.map(fid => {
                const fData = getUserData(fid);
                let status = 'offline';
                const fSocket = findSocketIdByUserId(fid);
                if (fSocket) {
                    status = 'online';
                    const room = getRoomBySocketId(fSocket);
                    if (room && room.status === 'PLAYING') status = 'ingame';
                }
                return { id: fid, name: fData.name, status: status };
            });
            
            const reqs = user.requests.map(rid => {
                const rData = getUserData(rid);
                return { id: rid, name: rData.name };
            });

            socket.emit('friendUpdate', { friends: list, requests: reqs });
        }

        else if (action === 'search') {
            const targetName = payload.trim().toLowerCase();
            if (!targetName) return;
            let foundId = null;
            for (const [uid, uData] of userDB.entries()) {
                if (uid !== userId && (uData.username === targetName || uData.name.toLowerCase() === targetName)) {
                    foundId = uid;
                    break;
                }
            }
            if (foundId) {
                const fData = getUserData(foundId);
                socket.emit('friendSearchResult', { id: foundId, name: fData.name });
            } else {
                socket.emit('friendSearchResult', null);
            }
        }

        else if (action === 'request') {
            // FIX: Handle socketID from in-game button
            let targetId = payload;
            if (typeof payload === 'string' && isNaN(parseInt(payload))) {
                 // Try to find user by socket ID
                 const targetSocket = io.sockets.sockets.get(payload);
                 if (targetSocket && targetSocket.tgUserId) targetId = targetSocket.tgUserId;
                 else return socket.emit('errorMsg', 'Игрок не найден');
            } else {
                 targetId = parseInt(payload);
            }

            if (targetId === userId || user.friends.includes(targetId)) return;
            
            const target = getUserData(targetId);
            if (!target.requests.includes(userId)) {
                target.requests.push(userId);
                userDB.set(targetId, target);
                
                const targetSocket = findSocketIdByUserId(targetId);
                if (targetSocket) {
                    io.to(targetSocket).emit('notification', { type: 'friend_req' });
                    io.to(targetSocket).emit('forceFriendUpdate'); 
                }
                socket.emit('errorMsg', 'Запрос отправлен!');
            } else {
                socket.emit('errorMsg', 'Уже отправлено.');
            }
        }

        else if (action === 'accept') {
            const targetId = parseInt(payload);
            const target = getUserData(targetId);
            
            if (!user.friends.includes(targetId)) user.friends.push(targetId);
            if (!target.friends.includes(userId)) target.friends.push(userId);
            
            user.requests = user.requests.filter(r => r !== targetId);
            
            userDB.set(userId, user);
            userDB.set(targetId, target);
            
            socket.emit('friendAction', { action: 'get' });
            
            const targetSocket = findSocketIdByUserId(targetId);
            if(targetSocket) io.to(targetSocket).emit('forceFriendUpdate');
        }

        else if (action === 'decline') {
            const targetId = parseInt(payload);
            
            // Logic: If friend exists -> delete friend. If request exists -> delete request.
            if (user.friends.includes(targetId)) {
                // REMOVE FRIEND
                user.friends = user.friends.filter(id => id !== targetId);
                const target = getUserData(targetId);
                if(target) {
                    target.friends = target.friends.filter(id => id !== userId);
                    userDB.set(targetId, target);
                    const targetSocket = findSocketIdByUserId(targetId);
                    if(targetSocket) io.to(targetSocket).emit('forceFriendUpdate');
                }
            } else {
                // DECLINE REQUEST
                user.requests = user.requests.filter(r => r !== targetId);
            }
            
            userDB.set(userId, user);
            socket.emit('friendAction', { action: 'get' });
        }
    });

    socket.on('inviteToRoom', (targetId) => {
        if (!socket.tgUserId) return;
        const myRoom = getRoomBySocketId(socket.id);
        if (!myRoom || myRoom.status !== 'LOBBY') return; 

        const targetSocket = findSocketIdByUserId(targetId);
        if (!targetSocket) {
            socket.emit('errorMsg', 'Игрок оффлайн.');
            return;
        }

        const targetRoom = getRoomBySocketId(targetSocket);
        if (targetRoom && targetRoom.status === 'PLAYING') {
            socket.emit('errorMsg', 'Игрок уже в бою.');
            return;
        }

        const user = getUserData(socket.tgUserId);
        
        io.to(targetSocket).emit('gameInvite', {
            inviter: user.name,
            roomId: myRoom.id,
            betCoins: myRoom.config.betCoins,
            betXp: myRoom.config.betXp
        });
        socket.emit('errorMsg', 'Приглашение отправлено!');
    });
});

const PING_INTERVAL = 14 * 60 * 1000;
const MY_URL = 'https://liarsdicezmss.onrender.com/ping';
setInterval(() => { 
    https.get(MY_URL, (res) => {}).on('error', (err) => { console.error("Ping error:", err.message); }); 
}, PING_INTERVAL);

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
