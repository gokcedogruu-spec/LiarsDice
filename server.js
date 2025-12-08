require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const token = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const MONGO_URL = process.env.MONGO_URL;

// --- 0. INIT BOT ---
const bot = token ? new TelegramBot(token, { polling: true }) : null;

// --- 1. DATABASE ---
mongoose.set('strictQuery', false);
if (MONGO_URL) {
    mongoose.connect(MONGO_URL)
        .then(() => console.log('✅ MongoDB Connected'))
        .catch(err => console.error('❌ MongoDB Error:', err));
} else {
    console.log('⚠️ NO MONGO_URL! Data will not save.');
}

const userSchema = new mongoose.Schema({
    id: { type: Number, required: true, unique: true },
    name: String,
    username: String,
    xp: { type: Number, default: 0 },
    coins: { type: Number, default: 100 },
    matches: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    streak: { type: Number, default: 0 },
    lossStreak: { type: Number, default: 0 },
    matchHistory: { type: Array, default: [] },
    friends: { type: [Number], default: [] },
    requests: { type: [Number], default: [] },
    pendingInvites: { type: Array, default: [] },
    inventory: { type: [String], default: ['skin_white', 'bg_default', 'frame_default'] },
    equipped: {
        skin: { type: String, default: 'skin_white' },
        bg: { type: String, default: 'bg_default' },
        frame: { type: String, default: 'frame_default' },
        hat: { type: String, default: null }
    }
});
const User = mongoose.model('User', userSchema);

// --- 2. SERVER CONFIG ---
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
app.get('/ping', (req, res) => res.status(200).send('pong'));

// --- 3. GAME DATA ---
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
    'hat_fallen': { price: 1000000, level: 6 }, 'hat_rich': { price: 1000000, level: 6 },
    'hat_underwater': { price: 1000000, level: 6 }, 'hat_voodoo': { price: 1000000, level: 6 },
    'hat_king_voodoo': { price: 10000000, level: 6 }, 'hat_cursed': { price: 10000000, level: 6 },
    'hat_flame': { price: 10000000, level: 6 }, 'hat_frozen': { price: 10000000, level: 6 },
    'hat_ghost': { price: 10000000, level: 6 }, 'hat_lava': { price: 100000000, level: 7 },
    'hat_deadlycursed': { price: 100000000, level: 7 }, 'hat_antarctica': { price: 100000000, level: 7 }
};

const userCache = new Map();
const rooms = new Map();

// --- 4. HELPERS ---
async function loadUser(tgUser) {
    let user = await User.findOne({ id: tgUser.id });
    if (!user) {
        user = new User({ id: tgUser.id, name: tgUser.first_name, username: tgUser.username ? tgUser.username.toLowerCase() : null });
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

async function saveUser(userId) {
    const data = userCache.get(userId);
    if (data) {
        const { _id, ...updateData } = data;
        await User.updateOne({ id: userId }, updateData);
    }
}

async function findUserIdByUsername(input) {
    if (!input) return null;
    const target = input.toLowerCase().replace('@', '').trim();
    if (/^\d+$/.test(target)) {
        const idNum = parseInt(target);
        const u = await User.findOne({ id: idNum });
        return u ? u.id : null;
    }
    const u = await User.findOne({ username: new RegExp(`^${target}$`, 'i') });
    return u ? u.id : null;
}

function getRankInfo(xp, streak) {
    let current = RANKS[0]; let next = null;
    for (let i = 0; i < RANKS.length; i++) {
        const r = RANKS[i];
        let match = false;
        if (r.name === "Легенда морей") { if (xp >= r.min && streak >= r.reqStreak) match = true; }
        else { if (xp >= r.min) match = true; }
        if (match) { current = r; next = RANKS[i+1] || null; }
    }
    return { current, next };
}

function findSocketIdByUserId(uid) {
    const sockets = Array.from(io.sockets.sockets.values());
    const s = sockets.find(s => s.tgUserId === uid);
    return s ? s.id : null;
}

function getRoomBySocketId(id) { for (const [k,v] of rooms) if (v.players.find(p=>p.id===id)) return v; return null; }

async function pushProfileUpdate(userId) {
    const socketId = findSocketIdByUserId(userId);
    if (socketId) {
        let user = userCache.get(userId);
        if (!user) {
            const dbUser = await User.findOne({ id: userId });
            if(dbUser) { user = dbUser.toObject(); userCache.set(userId, user); }
        }
        if(user) {
            const rank = getRankInfo(user.xp, user.streak);
            io.to(socketId).emit('profileUpdate', { ...user, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level });
        }
    }
}

// --- GAME LOGIC HELPERS ---
function generateRoomId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function rollDice(count) { return Array.from({length: count}, () => Math.floor(Math.random() * 6) + 1).sort((a,b)=>a-b); }

function resolveBackground(room) {
    if (room.isPvE) {
        const creator = room.players.find(p => p.isCreator);
        if (creator && creator.tgId) {
            const u = userCache.get(creator.tgId);
            return u ? (u.equipped.bg || 'bg_default') : 'bg_default';
        }
        return 'bg_default';
    }
    const candidates = room.players.filter(p => !p.isBot && p.tgId).map(p => {
        const u = userCache.get(p.tgId);
        if(!u) return null;
        const rInfo = getRankInfo(u.xp, u.streak);
        return { bg: u.equipped.bg || 'bg_default', rankLevel: rInfo.current.level, streak: u.streak };
    }).filter(c => c && c.bg !== 'bg_default');
    
    if (candidates.length === 0) return 'bg_default';
    candidates.sort((a, b) => {
        if (b.rankLevel !== a.rankLevel) return b.rankLevel - a.rankLevel;
        return b.streak - a.streak;
    });
    return candidates[0].bg;
}

// --- REWARD SYSTEM ---
async function updateUserXP(userId, type, difficulty = null, betCoins = 0, betXp = 0, winnerPotMultiplier = 0) {
    if (!userId || (typeof userId === 'string' && userId.startsWith('bot'))) return null;
    let user = userCache.get(userId);
    if (!user) { const dbUser = await User.findOne({id:userId}); if(dbUser) { user = dbUser.toObject(); userCache.set(userId, user); } else return null; }

    const oldRankInfo = getRankInfo(user.xp, user.streak);
    const skin = user.equipped.skin;

    if (!user.matchHistory) user.matchHistory = [];
    if (typeof user.lossStreak === 'undefined') user.lossStreak = 0;

    let baseWinXP = 65; let baseWinCoins = 50;
    if (type === 'win_pve') {
        if (difficulty === 'medium') { baseWinXP = 10; baseWinCoins = 10; }
        else if (difficulty === 'pirate') { baseWinXP = 40; baseWinCoins = 40; }
    }

    let potCoins = 0; let potXP = 0;
    if (winnerPotMultiplier > 0) { potCoins = betCoins * winnerPotMultiplier; potXP = betXp * winnerPotMultiplier; }

    let deltaCoins = 0; let deltaXP = 0; let reportDetails = [];

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

        let bonusMultiplierCoins = 1.0; let bonusMultiplierXP = 1.0;
        let flatBonusCoins = 0; let flatBonusXP = 0;

        if (skin !== 'skin_green' && user.streak > 0 && user.streak % 10 === 0) {
            const avg10 = calcAvg(10);
            const bC = Math.floor(avg10.c * 0.10); const bX = Math.floor(avg10.x * 0.10);
            flatBonusCoins += bC; flatBonusXP += bX;
            reportDetails.push(`Серия 10 побед: +${bC}💰 +${bX}⭐`);
        }

        if (skin === 'skin_gold') { bonusMultiplierCoins += 0.15; bonusMultiplierXP -= 0.10; reportDetails.push("Золото: +15%💰 -10%⭐"); }
        if (skin === 'skin_black') { bonusMultiplierCoins -= 0.10; bonusMultiplierXP += 0.15; reportDetails.push("Метка: -10%💰 +15%⭐"); }
        if (skin === 'skin_red' && user.streak > 0 && user.streak % 5 === 0) {
            const avg5 = calcAvg(5); const bC = Math.floor(avg5.c * 0.04);
            flatBonusCoins += bC; reportDetails.push(`Рубин (5 побед): +${bC}💰`);
        }
        if (skin === 'skin_green') {
            let poisonStack = Math.min(user.streak, 20); let poisonFactor = poisonStack / 100; 
            bonusMultiplierCoins += poisonFactor; bonusMultiplierXP += poisonFactor;
            if(poisonStack > 0) reportDetails.push(`Яд (x${poisonStack}): +${Math.round(poisonFactor*100)}%`);
        }
        if (skin === 'skin_purple') {
            const r = Math.random();
            if (r < 0.1) { bonusMultiplierCoins += 1.0; reportDetails.push("Вуду: ДЖЕКПОТ (x2)!"); }
            else if (r > 0.9) { bonusMultiplierCoins = 0; reportDetails.push("Вуду: Неудача (x0)..."); }
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

        if (skin === 'skin_red') { xpLossBase = Math.floor(xpLossBase * 1.05); reportDetails.push("Рубин: -5% XP штраф"); }
        if (skin === 'skin_blue') { xpLossBase = Math.floor(xpLossBase * 0.8); reportDetails.push("Морской: Штраф снижен"); }
        if (skin === 'skin_bone') {
            coinLossBase = Math.floor(coinLossBase * 1.05);
            if (Math.random() < 0.2 && betCoins > 0) { consolation += Math.floor(betCoins * 0.10); reportDetails.push("Костяной: Возврат 10% ставки!"); }
        }
        if (skin === 'skin_green') {
            let poisonLossStack = Math.min(user.lossStreak, 20); let f = 1.0 + (poisonLossStack / 100);
            xpLossBase = Math.floor(xpLossBase * f); coinLossBase = Math.floor(coinLossBase * f);
            consolation = 0; reportDetails.push(`Яд: Штраф увеличен (+${poisonLossStack}%)`);
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
    if (user.equipped.hat && newRankInfo.current.level < 6) user.equipped.hat = null;
    let rankUpMsg = null;
    if (newRankInfo.current.level > oldRankInfo.current.level) rankUpMsg = newRankInfo.current.name;

    await saveUser(userId);
    return { coins: deltaCoins, xp: deltaXP, details: reportDetails, rankUp: rankUpMsg, streak: user.streak };
}

function broadcastGameState(room) {
    const now = Date.now();
    const remaining = Math.max(0, room.turnDeadline - now);
    const playersData = room.players.map((p, i) => {
        let availableSkills = [];
        if (!p.isBot && p.tgId && p.diceCount > 0) {
            const u = userCache.get(p.tgId);
            const rInfo = u ? getRankInfo(u.xp, u.streak) : { current: { level: 0 } };
            const lvl = rInfo.current.level;
            const used = p.skillsUsed || [];
            if (lvl >= 4 && !used.includes('ears')) availableSkills.push('ears'); 
            if (lvl >= 5 && !used.includes('lucky')) availableSkills.push('lucky'); 
            if (lvl >= 6 && !used.includes('kill')) availableSkills.push('kill'); 
        }
        return { name: p.name, rank: p.rank, diceCount: p.diceCount, isTurn: i === room.currentTurn, isEliminated: p.diceCount === 0, id: p.id, equipped: p.equipped, availableSkills: availableSkills };
    });
    io.to(room.id).emit('gameState', {
        players: playersData, currentBid: room.currentBid, totalDuration: room.turnDuration, remainingTime: remaining,
        activeRules: { jokers: room.config.jokers, spot: room.config.spot, strict: room.config.strict },
        activeBackground: room.activeBackground
    });
}

function broadcastRoomUpdate(room) {
    io.to(room.id).emit('roomUpdate', {
        roomId: room.id,
        players: room.players.map(p => ({ name: p.name, rank: p.rank, ready: p.ready, isCreator: p.isCreator, diceCount: room.config.dice, id: p.id, equipped: p.equipped })),
        status: room.status, config: room.config, isPvE: room.isPvE
    });
}

// --- BOT LOGIC & ROUND ---
function startNewRound(room, isFirst = false, startIdx = null) {
    room.status = 'PLAYING'; room.currentBid = null; room.activeBackground = resolveBackground(room); 
    room.players.forEach(p => {
        if (isFirst) { if (p.diceCount === 0) p.diceCount = room.config.dice; p.skillsUsed = []; }
        p.dice = p.diceCount > 0 ? rollDice(p.diceCount) : [];
    });
    if (startIdx !== null) room.currentTurn = startIdx;
    else if (isFirst) { room.currentTurn = Math.floor(Math.random() * room.players.length); io.to(room.id).emit('gameEvent', { text: `🎲 Первый ход: ${room.players[room.currentTurn].name}`, type: 'info' }); }
    
    let safety = 0;
    while (room.players[room.currentTurn].diceCount === 0) {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
        safety++; if(safety > 20) break;
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
        loopCount++; if (loopCount > 20) return; 
    } while (room.players[room.currentTurn].diceCount === 0);
    resetTurnTimer(room); broadcastGameState(room);
}

function makeBidInternal(room, player, quantity, faceValue) {
    if (room.currentBid) {
        if (room.config.strict) { if (quantity <= room.currentBid.quantity) { io.to(player.id).emit('errorMsg', 'В строгом режиме нужно повышать количество!'); return; } } 
        else { if (quantity < room.currentBid.quantity) quantity = room.currentBid.quantity + 1; else if (quantity === room.currentBid.quantity && faceValue <= room.currentBid.faceValue) faceValue = room.currentBid.faceValue + 1; }
    }
    if (faceValue > 6) { if(room.config.strict) faceValue = 6; else { faceValue = 2; quantity++; } }
    room.currentBid = { quantity, faceValue, playerId: player.id };
    io.to(room.id).emit('gameEvent', { text: `${player.name} ставит: ${quantity}x[${faceValue}]`, type: 'info' });
    nextTurn(room);
}

function checkEliminationAndContinue(room, loser, killer) {
    if (room.timerId) clearTimeout(room.timerId);
    const betCoins = room.config.betCoins || 0; const betXp = room.config.betXp || 0;

    if (loser.diceCount === 0) {
        if (!loser.isBot && loser.tgId) {
            updateUserXP(loser.tgId, room.isPvE ? 'lose_pve' : 'lose_game', null, betCoins, betXp, 0).then(res => { if(res) { pushProfileUpdate(loser.tgId); io.to(loser.id).emit('matchResults', res); } });
        }
        io.to(room.id).emit('gameEvent', { text: `💀 ${loser.name} выбывает!`, type: 'error' });
    }
    const active = room.players.filter(p => p.diceCount > 0);
    if (active.length === 1) {
        const winner = active[0]; room.status = 'FINISHED';
        if (!winner.isBot && winner.tgId) {
            const type = room.isPvE ? 'win_pve' : 'win_game'; const diff = room.isPvE ? room.config.difficulty : null; const multiplier = room.players.length - 1; 
            updateUserXP(winner.tgId, type, diff, betCoins, betXp, multiplier).then(res => { pushProfileUpdate(winner.tgId); io.to(winner.id).emit('matchResults', res); });
        }
        io.to(room.id).emit('gameOver', { winner: winner.name });
    } else {
        let nextIdx = room.players.indexOf(loser);
        if (nextIdx === -1 || loser.diceCount === 0) {
            let searchStart = nextIdx !== -1 ? nextIdx : room.currentTurn;
            let loopCount = 0;
            do { searchStart = (searchStart + 1) % room.players.length; loopCount++; if(loopCount > 20) break; } while (room.players[searchStart].diceCount === 0);
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
    r.players.forEach(p => { if (p.diceCount > 0) { p.dice.forEach(d => { if (d === targetFace) total++; else if (r.config.jokers && d === 1 && targetFace !== 1) total++; }); allDice[p.name] = p.dice; } });
    io.to(r.id).emit('revealDice', allDice);
    
    let loser, winnerOfRound, msg;
    if (type === 'bluff') {
        if (total < r.currentBid.quantity) { msg = `На столе ${total}. Блеф! ${bidder.name} теряет куб.`; loser = bidder; winnerOfRound = challenger; } 
        else { msg = `На столе ${total}. Ставка есть! ${challenger.name} теряет куб.`; loser = challenger; winnerOfRound = bidder; }
    } else if (type === 'spot') {
        if (total === r.currentBid.quantity) { msg = `В ТОЧКУ! ${total} кубов! ${bidder.name} теряет куб.`; loser = bidder; winnerOfRound = challenger; } 
        else { msg = `Мимо! На столе ${total}. ${challenger.name} теряет куб.`; loser = challenger; winnerOfRound = bidder; }
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
    if (!lastBid) { makeBidInternal(room, bot, 1, bot.dice[0] || Math.floor(Math.random()*6)+1); return; }
    const needed = lastBid.quantity; const face = lastBid.faceValue;
    const inHand = myHand[face] || 0; const inHandJokers = room.config.jokers ? (myHand[1] || 0) : 0;
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
        if (room.config.strict) { nextQty = lastBid.quantity + 1; nextFace = Math.floor(Math.random() * 6) + 1; } else { if (nextFace > 6) { nextFace = 2; nextQty++; } }
        makeBidInternal(room, bot, nextQty, nextFace);
    }
}

function handleTimeout(room) {
    if (room.status !== 'PLAYING') return;
    const loser = room.players[room.currentTurn];
    if (!loser) { nextTurn(room); return; } 
    io.to(room.id).emit('gameEvent', { text: `⏳ ${loser.name} уснул и выбывает!`, type: 'error' });
    loser.diceCount = 0; checkEliminationAndContinue(room, loser, null);
}

function resetTurnTimer(room) {
    if (room.timerId) clearTimeout(room.timerId);
    const duration = room.config.time * 1000;
    room.turnDuration = duration; room.turnDeadline = Date.now() + duration;
    broadcastGameState(room);
    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer || currentPlayer.diceCount === 0) { nextTurn(room); return; }
    if (currentPlayer.isBot) { const thinkTime = Math.random() * 2000 + 2000; room.timerId = setTimeout(() => handleBotMove(room), thinkTime); } 
    else { room.timerId = setTimeout(() => handleTimeout(room), duration); }
}

function handlePlayerDisconnect(socketId, room, isVoluntary = false) {
    const i = room.players.findIndex(p => p.id === socketId);
    if (i === -1) return;
    const player = room.players[i]; const wasCreator = player.isCreator;
    
    if (room.status === 'PLAYING') {
        if (isVoluntary) {
            io.to(room.id).emit('gameEvent', { text: `🏃‍♂‍ ${player.name} сдался и покинул стол!`, type: 'error' });
            if (player.diceCount > 0) { player.diceCount = 0; if (!player.isBot && player.tgId) { updateUserXP(player.tgId, room.isPvE ? 'lose_pve' : 'lose_game', null, room.config.betCoins, room.config.betXp).then(res => { if(res) io.to(player.id).emit('matchResults', res); }); } }
            room.players.splice(i, 1);
            if (i === room.currentTurn) { if (room.currentTurn >= room.players.length) room.currentTurn = 0; resetTurnTimer(room); } else if (i < room.currentTurn) { room.currentTurn--; }
            const active = room.players.filter(p => p.diceCount > 0);
            if (active.length === 1) {
                const winner = active[0]; room.status = 'FINISHED'; if (room.timerId) clearTimeout(room.timerId);
                if (!winner.isBot && winner.tgId) {
                    const type = room.isPvE ? 'win_pve' : 'win_game'; const diff = room.isPvE ? room.config.difficulty : null; const multiplier = room.players.length; 
                    updateUserXP(winner.tgId, type, diff, room.config.betCoins, room.config.betXp, multiplier).then(res => { pushProfileUpdate(winner.tgId); io.to(winner.id).emit('matchResults', res); });
                }
                io.to(room.id).emit('gameOver', { winner: winner.name });
            } else { broadcastGameState(room); }
        } else { io.to(room.id).emit('gameEvent', { text: `🔌 ${player.name} отключился...`, type: 'error' }); }
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
    if (player.skillsUsed && player.skillsUsed.includes(skillType)) { socket.emit('errorMsg', 'Навык уже использован!'); return; }
    const user = userCache.get(player.tgId);
    const rankInfo = getRankInfo(user.xp, user.streak); const level = rankInfo.current.level;

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
            
            if(!player.skillsUsed) player.skillsUsed = []; player.skillsUsed.push('ears'); broadcastGameState(room);
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
                player.diceCount--; player.dice.pop();
                io.to(room.id).emit('gameEvent', { text: `🤡 ${player.name} уронил кубик!`, type: 'error' });
                io.to(player.id).emit('yourDice', player.dice);
                socket.emit('skillResult', { type: 'lucky', text: "Фокус не удался, кубик потерян!" });
                if(player.diceCount === 0) checkEliminationAndContinue(room, player, null);
            }
            if(!player.skillsUsed) player.skillsUsed = []; player.skillsUsed.push('lucky'); broadcastGameState(room);
        }
        else if (skillType === 'kill') {
            if (level < 6) return socket.emit('errorMsg', 'Нужен ранг Капитан');
            const active = room.players.filter(p => p.diceCount > 0);
            if (active.length !== 2) return socket.emit('errorMsg', 'Нужно 1 на 1');
            const enemy = active.find(p => p.id !== player.id);
            if (player.diceCount !== 1 || enemy.diceCount !== 1) return socket.emit('errorMsg', 'У всех по 1 кубу');
            
            if (Math.random() < 0.5) {
                io.to(room.id).emit('gameEvent', { text: `🔫 ${player.name} пристрелил ${enemy.name}!`, type: 'info' });
                enemy.diceCount = 0; checkEliminationAndContinue(room, enemy, player);
            } else {
                io.to(room.id).emit('gameEvent', { text: `🔫 ${player.name} промахнулся и застрелился!`, type: 'error' });
                player.diceCount = 0; checkEliminationAndContinue(room, player, enemy);
            }
            if(!player.skillsUsed) player.skillsUsed = []; player.skillsUsed.push('kill'); broadcastGameState(room);
        }
    } catch(e) { console.error(e); socket.emit('errorMsg', 'Ошибка навыка'); }
}

// --- ADMIN ---
if (bot) {
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id; const text = (msg.text || '').trim(); const fromId = msg.from.id;
        if (text.toLowerCase().startsWith('/start')) { bot.sendMessage(chatId, "☠️ Костяшки", { reply_markup: { inline_keyboard: [[{ text: "🎲 ИГРАТЬ", web_app: { url: 'https://liarsdicezmss.onrender.com' } }]] } }); return; }
        if (fromId !== ADMIN_ID) return;

        const args = text.split(' '); const cmd = args[0].toLowerCase();
        const refreshUser = (uid) => pushProfileUpdate(uid);

        let user = userCache.get(ADMIN_ID);
        if(!user) {
            const dbUser = await User.findOne({id: ADMIN_ID});
            if(dbUser) { user = dbUser.toObject(); userCache.set(ADMIN_ID, user); }
            else { bot.sendMessage(chatId, "Login first"); return; }
        }

        if (cmd === '/me') {
            if (args[1] === 'rich') { user.coins = 100000000; await saveUser(ADMIN_ID); refreshUser(ADMIN_ID); bot.sendMessage(chatId, "💰 Rich mode"); }
            if (args[1] === 'xp') { user.xp = parseInt(args[2]); await saveUser(ADMIN_ID); refreshUser(ADMIN_ID); bot.sendMessage(chatId, `⭐ XP: ${user.xp}`); }
        }
        else if (cmd === '/setxp') {
            const targetId = await findUserIdByUsername(args[1]);
            if(targetId) {
                let tUser = userCache.get(targetId);
                if(!tUser) { const d = await User.findOne({id: targetId}); if(d) { tUser = d.toObject(); userCache.set(targetId, tUser); } }
                if(tUser) {
                    tUser.xp = parseInt(args[2]);
                    if(tUser.xp >= 75000) tUser.streak = 100;
                    await saveUser(targetId); refreshUser(targetId);
                    bot.sendMessage(chatId, `Set XP for ${tUser.name}`);
                }
            } else bot.sendMessage(chatId, "User not found");
        }
        else if (cmd === '/setcoins') {
            const targetId = await findUserIdByUsername(args[1]);
            if(targetId) {
                let tUser = userCache.get(targetId);
                if(!tUser) { const d = await User.findOne({id: targetId}); if(d) { tUser = d.toObject(); userCache.set(targetId, tUser); } }
                if(tUser) {
                    tUser.coins = parseInt(args[2]);
                    await saveUser(targetId); refreshUser(targetId);
                    bot.sendMessage(chatId, `Set Coins for ${tUser.name}`);
                }
            } else bot.sendMessage(chatId, "User not found");
        }
        else if (cmd === '/streak') {
            user.streak = parseInt(args[1] || 0); await saveUser(ADMIN_ID); refreshUser(ADMIN_ID); bot.sendMessage(chatId, `🔥 Streak: ${user.streak}`);
        }
        else if (cmd === '/givehat') {
            const targetId = await findUserIdByUsername(args[1]);
            if(targetId) {
                let tUser = userCache.get(targetId);
                if(!tUser) { const d = await User.findOne({id: targetId}); if(d) { tUser = d.toObject(); userCache.set(targetId, tUser); } }
                if(tUser) {
                    if (!tUser.inventory.includes(args[2])) tUser.inventory.push(args[2]);
                    await saveUser(targetId); refreshUser(targetId);
                    bot.sendMessage(chatId, `Gave ${args[2]} to ${tUser.name}`);
                }
            } else bot.sendMessage(chatId, "User not found");
        }
        else if (cmd === '/win') {
            const socketId = findSocketIdByUserId(ADMIN_ID); 
            if(!socketId) return bot.sendMessage(chatId, "You are not in a room");
            const room = getRoomBySocketId(socketId); 
            if (!room || room.status !== 'PLAYING') return bot.sendMessage(chatId, "Not active");
            room.players.forEach(p => { if (p.tgId !== ADMIN_ID) p.diceCount = 0; });
            checkEliminationAndContinue(room, {diceCount:0, isBot:true}, null);
            bot.sendMessage(chatId, "🏆 Force Win!");
        }
        else if (cmd === '/reset') {
            const targetId = await findUserIdByUsername(args[1]);
            if(targetId) {
                let tUser = userCache.get(targetId);
                if(!tUser) { const d = await User.findOne({id: targetId}); if(d) { tUser = d.toObject(); userCache.set(targetId, tUser); } }
                tUser.xp = 0; tUser.coins = 0; tUser.wins = 0; tUser.matches = 0; tUser.streak = 0;
                tUser.inventory = ['skin_white', 'bg_default', 'frame_default'];
                tUser.equipped = { skin: 'skin_white', bg: 'bg_default', frame: 'frame_default', hat: null };
                await saveUser(targetId); refreshUser(targetId);
                bot.sendMessage(chatId, `Reset: ${tUser.name}`);
            }
        }
    });
}

// --- SOCKET ---
io.on('connection', (socket) => {
    socket.on('login', async ({ tgUser }) => {
        if (!tgUser) return;
        socket.tgUserId = tgUser.id;
        const user = await loadUser(tgUser);
        const rank = getRankInfo(user.xp, user.streak);
        socket.emit('profileUpdate', { ...user, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level });
        if (user.pendingInvites && user.pendingInvites.length > 0) {
            user.pendingInvites.forEach(invite => { if (rooms.has(invite.roomId)) socket.emit('gameInvite', invite); });
            user.pendingInvites = []; await saveUser(tgUser.id);
        }
        for (const [roomId, room] of rooms) {
            if (room.status === 'PLAYING') {
                const existingPlayer = room.players.find(p => p.tgId === tgUser.id);
                if (existingPlayer) {
                    existingPlayer.id = socket.id;
                    socket.join(roomId);
                    if(existingPlayer.diceCount > 0) socket.emit('yourDice', existingPlayer.dice);
                    broadcastGameState(room);
                    socket.emit('gameEvent', { text: '🔄 Вы вернулись!', type: 'info' });
                }
            }
        }
    });

    socket.on('shopBuy', async (itemId) => {
        if (!socket.tgUserId) return;
        const user = userCache.get(socket.tgUserId);
        const PRICES = { 
            'skin_red': 5000, 'skin_gold': 6500, 'skin_black': 6500, 'skin_blue': 10000, 
            'skin_green': 15000, 'skin_purple': 25000, 'skin_bone': 25000, 
            'bg_lvl1': 150000, 'bg_lvl2': 150000, 'bg_lvl3': 150000, 'bg_lvl4': 150000, 'bg_lvl5': 500000, 
            'frame_wood': 2500, 'frame_silver': 5000, 'frame_gold': 5000, 'frame_fire': 7500, 
            'frame_ice': 7500, 'frame_neon': 7500, 'frame_royal': 10000, 'frame_ghost': 10000, 
            'frame_kraken': 15000, 'frame_captain': 20000, 'frame_abyss': 25000
        };
        const price = PRICES[itemId];
        if (price && user.coins >= price && !user.inventory.includes(itemId)) {
            user.coins -= price; user.inventory.push(itemId); 
            await saveUser(socket.tgUserId);
            const rank = getRankInfo(user.xp, user.streak);
            socket.emit('profileUpdate', { ...user, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level });
            socket.emit('gameEvent', { text: 'Покупка успешна!', type: 'info' });
        }
    });

    socket.on('hatBuy', async (hatId) => {
        if (!socket.tgUserId) return;
        const user = userCache.get(socket.tgUserId);
        const hat = HATS[hatId];
        if (hat && user.coins >= hat.price && !user.inventory.includes(hatId)) {
            const rInfo = getRankInfo(user.xp, user.streak);
            if (rInfo.current.level < hat.level) return socket.emit('errorMsg', 'Ранг слишком низок!');
            user.coins -= hat.price; user.inventory.push(hatId); 
            await saveUser(socket.tgUserId);
            socket.emit('profileUpdate', { ...user, rankName: rInfo.current.name, currentRankMin: rInfo.current.min, nextRankXP: rInfo.next?.min || 'MAX', rankLevel: rInfo.current.level });
            socket.emit('gameEvent', { text: 'Шляпа куплена!', type: 'info' });
        }
    });

    socket.on('shopEquip', async (itemId) => {
        if (!socket.tgUserId) return;
        const user = userCache.get(socket.tgUserId);
        if (user.inventory.includes(itemId)) {
            if (itemId.startsWith('skin_')) user.equipped.skin = itemId;
            if (itemId.startsWith('bg_') || itemId === 'table_default') user.equipped.bg = itemId;
            if (itemId.startsWith('frame_')) user.equipped.frame = itemId;
            await saveUser(socket.tgUserId);
            const rank = getRankInfo(user.xp, user.streak);
            socket.emit('profileUpdate', { ...user, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level });
            const room = getRoomBySocketId(socket.id); if(room) { const p = room.players.find(pl => pl.id === socket.id); if(p) { p.equipped = {...user.equipped}; if(room.status==='LOBBY') broadcastRoomUpdate(room); } }
        }
    });

    socket.on('hatEquip', async (hatId) => {
        if (!socket.tgUserId) return;
        const user = userCache.get(socket.tgUserId);
        if (hatId === null || user.inventory.includes(hatId)) {
            user.equipped.hat = hatId;
            await saveUser(socket.tgUserId);
            const rank = getRankInfo(user.xp, user.streak);
            socket.emit('profileUpdate', { ...user, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level });
            const room = getRoomBySocketId(socket.id); if(room) { const p = room.players.find(pl => pl.id === socket.id); if(p) { p.equipped = {...user.equipped}; if(room.status==='LOBBY') broadcastRoomUpdate(room); } }
        }
    });

    socket.on('sendEmote', (emoji) => { const room = getRoomBySocketId(socket.id); if(room) io.to(room.id).emit('emoteReceived', { id: socket.id, emoji: emoji }); });
    
    socket.on('useSkill', (skillType) => handleSkill(socket, skillType));
    
    socket.on('getPlayerStats', async (targetId) => {
        let userData = null;
        if (targetId === 'me') { if (socket.tgUserId) userData = userCache.get(socket.tgUserId); }
        else if (!targetId.startsWith('bot') && !targetId.startsWith('CPU')) { 
            const room = getRoomBySocketId(socket.id); 
            if(room) { 
                const tp = room.players.find(p=>p.id===targetId); 
                if(tp && tp.tgId) userData = userCache.get(tp.tgId); 
            }
            if(!userData && !isNaN(parseInt(targetId))) userData = await User.findOne({id: targetId});
        }
        if (userData) { 
            const rank = getRankInfo(userData.xp, userData.streak); 
            socket.emit('showPlayerStats', { id: userData.id, name: userData.name, rankName: rank.current.name, matches: userData.matches, wins: userData.wins, inventory: userData.inventory, equipped: userData.equipped }); 
        }
    });

    // FRIEND ACTIONS (DB VERSION)
    socket.on('friendAction', async ({ action, payload }) => {
        if (!socket.tgUserId) return;
        const userId = socket.tgUserId;
        const user = userCache.get(userId);

        if (action === 'search') {
            let targetName = payload.trim().toLowerCase();
            if (targetName.startsWith('@')) targetName = targetName.substring(1);
            
            const found = await User.findOne({
                $and: [
                    { id: { $ne: userId } },
                    { $or: [{ username: targetName }, { name: new RegExp('^'+targetName+'$', 'i') }] }
                ]
            });
            
            if (found) socket.emit('friendSearchResult', { id: found.id, name: found.name });
            else socket.emit('friendSearchResult', null);
        }
        
        else if (action === 'request') {
            let targetId = payload;
            if (typeof payload === 'string' && isNaN(parseInt(payload))) {
                 const ts = io.sockets.sockets.get(payload);
                 if(ts && ts.tgUserId) targetId = ts.tgUserId; else return socket.emit('errorMsg', 'Игрок не найден');
            } else targetId = parseInt(payload);
            
            if(targetId === userId) return;
            let target = userCache.get(targetId);
            if(!target) { const t = await User.findOne({id: targetId}); if(t) target = t.toObject(); }
            
            if(target && !target.requests.includes(userId) && !target.friends.includes(userId)) {
                target.requests.push(userId);
                if(userCache.has(targetId)) userCache.set(targetId, target);
                await User.updateOne({id: targetId}, {requests: target.requests});
                const ts = findSocketIdByUserId(targetId);
                if(ts) { io.to(ts).emit('notification', {type: 'friend_req'}); io.to(ts).emit('forceFriendUpdate'); }
                socket.emit('errorMsg', 'Запрос отправлен!');
            } else socket.emit('errorMsg', 'Ошибка запроса');
        }
        
        else if (action === 'accept') {
            const targetId = parseInt(payload);
            let target = userCache.get(targetId);
            if(!target) { const t = await User.findOne({id: targetId}); if(t) target = t.toObject(); }
            
            if(target) {
                if(!user.friends.includes(targetId)) user.friends.push(targetId);
                if(!target.friends.includes(userId)) target.friends.push(userId);
                user.requests = user.requests.filter(r => r !== targetId);
                
                userCache.set(userId, user); await saveUser(userId);
                if(userCache.has(targetId)) userCache.set(targetId, target);
                await User.updateOne({id: targetId}, {friends: target.friends});
                
                socket.emit('friendAction', { action: 'get' });
                const ts = findSocketIdByUserId(targetId); if(ts) io.to(ts).emit('forceFriendUpdate');
            }
        }
        
        else if (action === 'decline') {
            const targetId = parseInt(payload);
            if(user.friends.includes(targetId)) {
                user.friends = user.friends.filter(x => x !== targetId);
                let target = userCache.get(targetId);
                if(!target) { const t = await User.findOne({id: targetId}); if(t) target = t.toObject(); }
                if(target) {
                    target.friends = target.friends.filter(x => x !== userId);
                    if(userCache.has(targetId)) userCache.set(targetId, target);
                    await User.updateOne({id: targetId}, {friends: target.friends});
                    const ts = findSocketIdByUserId(targetId);
                    if(ts) io.to(ts).emit('forceFriendUpdate');
                }
            } else {
                user.requests = user.requests.filter(x => x !== targetId);
            }
            userCache.set(userId, user); await saveUser(userId);
            socket.emit('friendAction', { action: 'get' });
        }

        else if (action === 'get') {
             const list = [];
             for (const fid of user.friends) {
                 let fName = "Unknown"; let st = "offline";
                 const fc = userCache.get(fid);
                 if(fc) { fName = fc.name; if(findSocketIdByUserId(fid)) st="online"; }
                 else { const fd = await User.findOne({id: fid}); if(fd) fName = fd.name; }
                 list.push({id: fid, name: fName, status: st});
             }
             const reqs = [];
             for (const rid of user.requests) {
                 const r = await User.findOne({id: rid});
                 if(r) reqs.push({id: rid, name: r.name});
             }
             socket.emit('friendUpdate', { friends: list, requests: reqs });
        }
    });

    socket.on('inviteToRoom', (targetId) => {
        if (!socket.tgUserId) return;
        const myRoom = getRoomBySocketId(socket.id);
        if (!myRoom) return;
        const targetIdInt = parseInt(targetId);
        const targetSocket = findSocketIdByUserId(targetIdInt);
        const user = userCache.get(socket.tgUserId);
        
        if(targetSocket) {
            io.to(targetSocket).emit('gameInvite', { inviter: user.name, roomId: myRoom.id, betCoins: myRoom.config.betCoins, betXp: myRoom.config.betXp });
            socket.emit('gameEvent', { text: 'Приглашение отправлено!', type: 'info' });
        } else {
            User.findOne({id: targetIdInt}).then(t => {
                if(t) {
                    t.pendingInvites.push({ inviter: user.name, roomId: myRoom.id, betCoins: myRoom.config.betCoins, betXp: myRoom.config.betXp });
                    t.save();
                    socket.emit('gameEvent', { text: 'Приглашение отправлено (оффлайн)!', type: 'info' });
                }
            });
        }
    });

    socket.on('joinOrCreateRoom', ({ roomId, tgUser, options, mode }) => {
        const old = getRoomBySocketId(socket.id); if (old) handlePlayerDisconnect(socket.id, old, true);
        if (!tgUser) return;
        const userId = tgUser.id; 
        const uData = userCache.get(userId);
        const rInfo = getRankInfo(uData.xp, uData.streak);
        
        if (options && options.dice < 3) options.dice = 3;
        if (options && (options.betCoins > uData.coins || options.betXp > uData.xp)) { socket.emit('errorMsg', 'NO_FUNDS'); return; }

        let room; let isCreator = false;
        if (mode === 'pve') {
            const newId = 'CPU_' + Math.random().toString(36).substring(2,6);
            room = { id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null, history: [], timerId: null, turnDeadline: 0, config: { dice: Math.max(3, options.dice), players: options.players, time: 30, jokers: options.jokers, spot: options.spot, strict: options.strict, difficulty: options.difficulty }, isPvE: true };
            rooms.set(newId, room); isCreator = true;
            room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: room.config.dice, ready: true, isCreator: true, equipped: uData.equipped, skillsUsed: [], rankLevel: rInfo.current.level });
            const botNames = ['Джек', 'Барбосса', 'Уилл', 'Дейви Джонс', 'Тич', 'Гиббс'];
            for(let i=0; i<options.players-1; i++) { room.players.push({ id: 'bot_' + Math.random(), name: `${botNames[i%botNames.length]} (Бот)`, rank: options.difficulty === 'pirate' ? 'Капитан' : 'Матрос', dice: [], diceCount: room.config.dice, ready: true, isCreator: false, isBot: true, equipped: { frame: 'frame_default' }, rankLevel: 0 }); }
            socket.join(newId); startNewRound(room, true); return;
        }
        if (roomId) { 
            room = rooms.get(roomId); 
            if (!room || room.status !== 'LOBBY' || room.players.length >= room.config.players) { socket.emit('errorMsg', 'Ошибка входа'); return; } 
            if (room.config.betCoins > uData.coins || room.config.betXp > uData.xp) { socket.emit('errorMsg', 'NO_FUNDS'); return; }
        }
        else { const newId = generateRoomId(); const st = options || { dice: 5, players: 10, time: 30 }; if(st.dice < 3) st.dice = 3; room = { id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null, history: [], timerId: null, turnDeadline: 0, config: st, isPvE: false }; rooms.set(newId, room); roomId = newId; isCreator = true; }
        
        room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: room.config.dice, ready: false, isCreator: isCreator, equipped: uData.equipped, skillsUsed: [], rankLevel: rInfo.current.level });
        socket.join(roomId); broadcastRoomUpdate(room);
    });

    socket.on('setReady', (isReady) => { const r = getRoomBySocketId(socket.id); if (r?.status === 'LOBBY') { const p = r.players.find(x => x.id === socket.id); if (p) { p.ready = isReady; broadcastRoomUpdate(r); } } });
    socket.on('startGame', () => { const r = getRoomBySocketId(socket.id); if (r) { const p = r.players.find(x => x.id === socket.id); if (p?.isCreator && r.players.length >= 2 && r.players.every(x => x.ready)) startNewRound(r, true); } });
    socket.on('makeBid', ({ quantity, faceValue }) => { const r = getRoomBySocketId(socket.id); if (!r || r.status !== 'PLAYING' || r.players[r.currentTurn].id !== socket.id) return; makeBidInternal(r, r.players[r.currentTurn], parseInt(quantity), parseInt(faceValue)); });
    socket.on('callBluff', () => handleCall(socket, 'bluff'));
    socket.on('callSpot', () => handleCall(socket, 'spot'));
    
    socket.on('requestRestart', async () => { 
        const r = getRoomBySocketId(socket.id); 
        if (r?.status === 'FINISHED') { 
            for(const p of r.players) { if (!p.isBot && p.tgId) await pushProfileUpdate(p.tgId); }
            if (r.isPvE) { r.status = 'PLAYING'; r.players.forEach(p => { p.diceCount = r.config.dice; p.dice = []; p.skillsUsed = []; }); r.currentBid = null; startNewRound(r, true); } 
            else { r.status = 'LOBBY'; r.players.forEach(p => { p.diceCount = r.config.dice; p.ready = false; p.dice = []; p.skillsUsed = []; }); r.currentBid = null; broadcastRoomUpdate(r); } 
        } 
    });
});

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
