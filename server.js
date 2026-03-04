require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

// Подключаем наши новые файлы
const User = require('./models/User');
const { RANKS, HATS } = require('./config/constants');
const { generateRoomId, rollDice, getRankInfo, findUserIdByUsername } = require('./utils/helpers');
const { 
    userCache, 
    userSockets, 
    addUserSocket, 
    removeUserSocket, 
    findSocketIdByUserId, 
    loadUser, 
    saveUser 
} = require('./services/userService');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const token = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const MONGO_URL = process.env.MONGO_URL;

// --- 0. INIT BOT ---
const bot = token ? new TelegramBot(token, { polling: true }) : null;

// --- INLINE QUERY HANDLER (SHARE GAME) ---
if (bot) {
    bot.on('inline_query', (query) => {
        const roomId = query.query.trim(); // Получаем то, что передал клиент (ID комнаты)
        
        // Если ID пустой, ничего не делаем
        if (!roomId) return;

        // Формируем красивую карточку
        const results = [{
            type: 'photo', // ТЕПЕРЬ ЭТО ФОТО
            id: 'invite_' + roomId,
            photo_url: 'https://raw.githubusercontent.com/gokcedogruu-spec/LiarsDice/main/logo/logotg_one.png', // Большая картинка
            thumb_url: 'https://raw.githubusercontent.com/gokcedogruu-spec/LiarsDice/main/logo/logotg_one.png', // Маленькая превью
            title: '🏴‍☠️ Присоединиться',
            caption: `☠️ Го в костяшки! \nКод комнаты: <b>${roomId}</b>`, // Текст теперь тут
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    {
                        text: "ВОЙТИ В КОМНАТУ",
                        url: `https://t.me/zmssliarsbot/game?startapp=${roomId}` 
                    }
                ]]
            }
        }];

        bot.answerInlineQuery(query.id, results, { cache_time: 0 });
    });
}

// --- 1. DATABASE ---
mongoose.set('strictQuery', false);
if (MONGO_URL) {
    mongoose.connect(MONGO_URL)
        .then(() => console.log('✅ MongoDB Connected'))
        .catch(err => console.error('❌ MongoDB Error:', err));
} else {
    console.log('⚠️ NO MONGO_URL! Data will not save.');
}

const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));
app.get('/ping', (req, res) => res.status(200).send('pong'));

const rooms = new Map();


// --- HELPERS ---

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

// --- GAME LOGIC ---

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
        if (difficulty === 'medium') { baseWinXP = 100; baseWinCoins = 100; }
        else if (difficulty === 'pirate') { baseWinXP = 500; baseWinCoins = 500; }
        else if (difficulty === 'legend') { baseWinXP = 1000; baseWinCoins = 1000; }
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
        activeRules: { jokers: room.config.jokers, spot: room.config.spot, strict: room.config.strict, crazy: room.config.crazy || false },
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
        loopCount++;
        if (loopCount > 20) return; // защита от зацикливания
    } while (room.players[room.currentTurn].diceCount === 0);

    resetTurnTimer(room);
    broadcastGameState(room);
}

function makeBidInternal(room, player, quantity, faceValue) {
    if (room.currentBid) {
        if (room.config.strict) {
            if (quantity <= room.currentBid.quantity) {
                io.to(player.id).emit('errorMsg', 'В строгом режиме нужно повышать количество!');
                return;
            }
        } else {
            if (quantity < room.currentBid.quantity) {
                quantity = room.currentBid.quantity + 1;
            } else if (quantity === room.currentBid.quantity &&
                       faceValue <= room.currentBid.faceValue) {
                faceValue = room.currentBid.faceValue + 1;
            }
        }
    }

    if (faceValue > 6) {
        if (room.config.strict) {
            faceValue = 6;
        } else {
            faceValue = 2;
            quantity++;
        }
    }

    room.currentBid = { quantity, faceValue, playerId: player.id };

    io.to(room.id).emit('gameEvent', {
        text: `${player.name} ставит: ${quantity}x[${faceValue}]`,
        type: 'info'
    });

    nextTurn(room);
}

function checkEliminationAndContinue(room, loser, killer) {
    finalizeRound(room, loser, killer);
}

// --- BOT EMOTES & SKILLS ---
function sendBotEmote(room, bot, type) {
    const chance = room.config.difficulty === 'legend' ? 0.5 : 0.3;
    if (Math.random() > chance && type !== 'win_bluff') return;

    const emotes = {
        'bluff': 'skeptic',  
        'raise': 'bully',    
        'win_bluff': 'gigachad', 
        'wait': 'button',    
        'low_hp': 'sad',     
        'panic': 'panic'     
    };

    if (emotes[type]) {
        setTimeout(() => {
            io.to(room.id).emit('emoteReceived', { id: bot.id, emoji: emotes[type] });
        }, 500); 
    }
}

function tryBotSkill(room, bot) {
    if (room.config.difficulty !== 'legend') return false;
    if (bot.skillsUsed && bot.skillsUsed.length > 0) return false; 

    // LUCKY
    if (bot.diceCount < 4 && Math.random() < 0.7) {
        bot.skillsUsed = ['lucky'];
        const successChance = 0.65; 

        if (Math.random() < successChance) {
            bot.diceCount++;
            bot.dice.push(Math.floor(Math.random()*6)+1);
            io.to(room.id).emit('gameEvent', { text: `⚡ ${bot.name} (Бот) достал кубик из рукава!`, type: 'alert' });
            sendBotEmote(room, bot, 'win_bluff'); 
        } else {
            io.to(room.id).emit('gameEvent', { text: `⚡ ${bot.name} уронил кубик!`, type: 'info' });
            sendBotEmote(room, bot, 'low_hp'); 
        }
        return false; 
    }
    return false;
}

function finalizeRound(room, forcedLoser = null, forcedWinner = null) {
    if (room.timerId) clearTimeout(room.timerId);
    
    let loser = forcedLoser;
    let killer = forcedWinner;

    if (!loser && room.pendingResult) {
        loser = room.pendingResult.loser;
        killer = room.pendingResult.winner;
        
        if (killer.isBot && !loser.isBot) sendBotEmote(room, killer, 'win_bluff');
        if (loser.isBot && loser.diceCount === 2) sendBotEmote(room, loser, 'low_hp');

        room.pendingResult = null; 
    }

    if (!loser) return; 

    const betCoins = room.config.betCoins || 0; 
    const betXp = room.config.betXp || 0;

    loser.diceCount--;

    if (loser.diceCount <= 0) {
        loser.diceCount = 0;
        if (!loser.isBot && loser.tgId) {
            updateUserXP(loser.tgId, room.isPvE ? 'lose_pve' : 'lose_game', null, betCoins, betXp, 0).then(res => { if(res) { pushProfileUpdate(loser.tgId); io.to(loser.id).emit('matchResults', res); } });
        }
        const loserName = loser.name || "Игрок";
        io.to(room.id).emit('gameEvent', { text: `💀 ${loserName} выбывает!`, type: 'error' });
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
    r.players.forEach(p => { 
        if (p.diceCount > 0) { 
            p.dice.forEach(d => { if (d === targetFace) total++; else if (r.config.jokers && d === 1 && targetFace !== 1) total++; }); 
            allDice[p.id] = { dice: p.dice, id: p.id, skin: p.equipped.skin, name: p.name }; 
        } 
    });
    
    let loser, winnerOfRound, msg;
    if (type === 'bluff') {
        if (total < r.currentBid.quantity) { msg = `На столе ${total}. Блеф! ${bidder.name} теряет куб.`; loser = bidder; winnerOfRound = challenger; } 
        else { msg = `На столе ${total}. Ставка есть! ${challenger.name} теряет куб.`; loser = challenger; winnerOfRound = bidder; }
    } else if (type === 'spot') {
        if (total === r.currentBid.quantity) { msg = `В ТОЧКУ! ${total} кубов! ${bidder.name} теряет куб.`; loser = bidder; winnerOfRound = challenger; } 
        else { msg = `Мимо! На столе ${total}. ${challenger.name} теряет куб.`; loser = challenger; winnerOfRound = bidder; }
    }

    io.to(r.id).emit('bluffEffect', { playerId: challenger.id, type: type });

    setTimeout(() => {
        r.status = 'REVEAL';
        r.pendingResult = { loser, winner: winnerOfRound };
        r.readyPlayers = new Set(); 
        r.revealData = { allDice: allDice, message: msg, timeLeft: 30000, animate: true }; 
        
        r.players.forEach(p => { if (p.isBot || p.diceCount === 0) r.readyPlayers.add(p.id); });

        io.to(r.id).emit('revealPhase', { allDice: allDice, message: msg, timeLeft: 30000, animate: true });
        r.timerId = setTimeout(() => finalizeRound(r), 30000);
    }, 2500); 
}

function makeBotRaise(room, bot, lastBid, myHand, diff, totalDice) {
    let nextQty = lastBid.quantity; 
    let nextFace = lastBid.faceValue + 1;
    
    const nextIdx = (room.currentTurn + 1) % room.players.length;
    const nextPlayer = room.players[nextIdx];
    const isGangingUp = (diff === 'legend' && !nextPlayer.isBot && Math.random() < 0.6); 

    let bestFaceToBid = null;
    if (!room.config.strict) {
        let searchFrom = Math.max(2, lastBid.faceValue + 1);
        for (let f = searchFrom; f <= 6; f++) {
            const count = (myHand[f] || 0) + (room.config.jokers ? (myHand[1] || 0) : 0);
            const minSupport = (diff === 'legend') ? 2 : 1;
            if (count >= minSupport) { bestFaceToBid = f; break; }
        }
    }

    if (bestFaceToBid) {
        nextFace = bestFaceToBid;
        if (isGangingUp) { nextQty = lastBid.quantity + 1; sendBotEmote(room, bot, 'raise'); }
    } else {
        nextQty = lastBid.quantity + 1;
        if (isGangingUp && totalDice > 10) { nextQty = lastBid.quantity + 2; sendBotEmote(room, bot, 'raise'); }

        let maxCount = -1;
        let targetF = 2;
        for(let f=2; f<=6; f++) {
             const c = (myHand[f]||0) + (room.config.jokers ? (myHand[1] || 0) : 0);
             if(c > maxCount) { maxCount = c; targetF = f; }
        }
        nextFace = targetF;
    }

    if (room.config.strict) { 
        nextQty = lastBid.quantity + 1; 
        nextFace = Math.floor(Math.random() * 6) + 1; 
        if (nextFace === 1) nextFace = 2;
    } 
    
    if (nextFace > 6) { nextFace = 2; nextQty = lastBid.quantity + 1; }
    if (nextQty <= lastBid.quantity && nextFace <= lastBid.faceValue) { nextQty = lastBid.quantity + 1; }

    makeBidInternal(room, bot, nextQty, nextFace);
}

function handleBotMove(room) {
    if (room.status !== 'PLAYING') return;
    const bot = room.players[room.currentTurn];
    if (!bot || bot.diceCount === 0) { nextTurn(room); return; }

    if (tryBotSkill(room, bot)) return; 

    const lastBid = room.currentBid;
    
    if (lastBid && room.lastQuantity && lastBid.quantity >= room.lastQuantity + 2) {
        const prevIdx = (room.currentTurn - 1 + room.players.length) % room.players.length;
        if (!room.players[prevIdx].isBot && Math.random() < 0.7) sendBotEmote(room, bot, 'panic');
    }
    if(lastBid) room.lastQuantity = lastBid.quantity;

    let totalDiceInGame = 0; room.players.forEach(p => totalDiceInGame += p.diceCount);
    
    const myHand = {}; 
    bot.dice.forEach(d => myHand[d] = (myHand[d] || 0) + 1);
    const diff = room.config.difficulty;

    if (!lastBid) { 
        let bestFace = 6; 
        let maxCount = 0;
        
        for(let f=2; f<=6; f++) { 
            const count = (myHand[f] || 0) + (room.config.jokers ? (myHand[1] || 0) : 0);
            if(count > maxCount) { maxCount = count; bestFace = f; } 
        }
        
        let startQty = Math.max(1, Math.floor(totalDiceInGame / 3.5));
        if (maxCount >= startQty) startQty = maxCount; 

        makeBidInternal(room, bot, startQty, bestFace); 
        return; 
    }

    const needed = lastBid.quantity; 
    const face = lastBid.faceValue;
    const inHand = myHand[face] || 0; 
    const inHandJokers = room.config.jokers ? (myHand[1] || 0) : 0;
    
    const mySureCount = (face === 1 && room.config.jokers) ? inHand : (inHand + (face !== 1 ? inHandJokers : 0));
    const unknownDice = totalDiceInGame - bot.diceCount;
    const probPerDie = room.config.jokers ? (face===1 ? 1/6 : 2/6) : 1/6;
    const expectedTotal = mySureCount + (unknownDice * probPerDie);
    
    let threshold = 0.8; 
    if (diff === 'pirate') threshold = -0.2; 
    if (diff === 'legend') threshold = -0.8; 

    if ((diff === 'pirate' || diff === 'legend') && room.config.spot) {
        if (Math.abs(expectedTotal - needed) < 0.35) {
            const risk = diff === 'legend' ? 0.6 : 0.3;
            if (Math.random() < risk) { handleCall(null, 'spot', room, bot); return; }
        }
    }

    if (mySureCount >= needed) {
        makeBotRaise(room, bot, lastBid, myHand, diff, totalDiceInGame);
        return;
    }

    if (needed > expectedTotal + threshold) {
        const safeZone = totalDiceInGame * 0.4;
        if (needed <= safeZone) {
             makeBotRaise(room, bot, lastBid, myHand, diff, totalDiceInGame);
        } else {
             sendBotEmote(room, bot, 'bluff'); 
             handleCall(null, 'bluff', room, bot);
        }
    } else {
        makeBotRaise(room, bot, lastBid, myHand, diff, totalDiceInGame);
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
    else { 
        room.timerId = setTimeout(() => handleTimeout(room), duration); 
        const waitTime = 7000 + Math.random() * 5000;
        const turnCheck = room.currentTurn;
        setTimeout(() => {
            if (room.status === 'PLAYING' && room.currentTurn === turnCheck) {
                const bots = room.players.filter(p => p.isBot && p.diceCount > 0);
                if (bots.length > 0) {
                    const impatientBot = bots[Math.floor(Math.random() * bots.length)];
                    sendBotEmote(room, impatientBot, 'wait');
                }
            }
        }, waitTime);
    }
}

function handlePlayerDisconnect(socketId, room, isVoluntary = false) {
    const i = room.players.findIndex(p => p.id === socketId);
    if (i === -1) return;
    const player = room.players[i]; const wasCreator = player.isCreator;
    
    if (room.status === 'PLAYING' || room.status === 'REVEAL') {
        if (isVoluntary) {
            player.hasLeft = true;
            io.to(room.id).emit('gameEvent', { text: `🏃‍♂‍ ${player.name} сдался и покинул стол!`, type: 'error' });
            if (player.diceCount > 0) { player.diceCount = 0; if (!player.isBot && player.tgId) { updateUserXP(player.tgId, room.isPvE ? 'lose_pve' : 'lose_game', null, room.config.betCoins, room.config.betXp).then(res => { if(res) io.to(player.id).emit('matchResults', res); }); } }
            if(room.status === 'REVEAL') finalizeRound(room); 
            else {
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
            }
        } else { 
            if (room.status === 'REVEAL') {
               if(!room.readyPlayers) room.readyPlayers = new Set();
               room.readyPlayers.add(player.id);
               if(room.readyPlayers.size >= room.players.length) finalizeRound(room);
            }
            io.to(room.id).emit('gameEvent', { text: `🔌 ${player.name} отключился...`, type: 'error' }); 
        }
    } else {
        io.to(room.id).emit('gameEvent', { text: `🏃‍♂‍ ${player.name} ушел!`, type: 'error' });
        room.players.splice(i, 1);
        if (room.players.filter(p => !p.isBot).length === 0) { 
            if(room.timerId) clearTimeout(room.timerId); 
            console.log(`Комната ${room.id} пуста. Удаление через 60 сек...`);
            room.deletionTimer = setTimeout(() => {
                if (rooms.has(room.id)) { rooms.delete(room.id); console.log(`Комната ${room.id} удалена.`); }
            }, 60000); 
        }
        else { 
            if (wasCreator) {
                const newLeader = room.players.find(p => !p.isBot);
                if (newLeader) { newLeader.isCreator = true; io.to(room.id).emit('gameEvent', { text: `👑 ${newLeader.name} теперь капитан!`, type: 'info' }); }
            }
            broadcastRoomUpdate(room); 
        }
    }
}

function handleSkill(socket, skillType) {
    const room = getRoomBySocketId(socket.id);
    if (!room || room.status === 'FINISHED') return;
    if (room.status !== 'PLAYING') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.tgId) return;

    if (player.skillsUsed && player.skillsUsed.includes(skillType)) {
        socket.emit('errorMsg', 'Навык уже использован!');
        return;
    }

    const user = userCache.get(player.tgId);
    const rankInfo = getRankInfo(user.xp, user.streak);
    const level = rankInfo.current.level;

    try {
        if (skillType === 'ears') {
            if (level < 4) return socket.emit('errorMsg', 'Нужен ранг Боцман');
            if (room.currentTurn !== room.players.indexOf(player)) return socket.emit('errorMsg', 'Только в свой ход');
            if (!room.currentBid) return socket.emit('errorMsg', 'Ставок нет');

            if (Math.random() < 0.5) {
                const bid = room.currentBid;
                let total = 0;
                room.players.forEach(p => {
                    p.dice.forEach(d => {
                        if (d === bid.faceValue || (room.config.jokers && d === 1 && bid.faceValue !== 1)) total++;
                    });
                });
                const isLying = total < bid.quantity;
                socket.emit('skillResult', {
                    type: 'ears',
                    text: isLying ? "Он ВРЁТ!" : "Похоже на правду..."
                });
            } else {
                socket.emit('skillResult', {
                    type: 'ears',
                    text: "Ничего не слышно..."
                });
            }

            if (!player.skillsUsed) player.skillsUsed = [];
            player.skillsUsed.push('ears');
            broadcastGameState(room);

            // уведомление о скилле
            io.to(room.id).emit('skillUsed', {
                playerId: player.id,
                name: player.name,
                skill: 'ears'
            });
        }

        else if (skillType === 'lucky') {
            if (level < 5) return socket.emit('errorMsg', 'Нужен ранг 1-й помощник');
            if (player.diceCount >= 5) return socket.emit('errorMsg', 'Максимум кубиков');

            if (Math.random() < 0.5) {
                player.diceCount++;
                player.dice.push(Math.floor(Math.random() * 6) + 1);
                io.to(room.id).emit('gameEvent', {
                    text: `🎲 ${player.name} достал кубик!`,
                    type: 'info'
                });
                io.to(player.id).emit('yourDice', player.dice);
                socket.emit('skillResult', {
                    type: 'lucky',
                    text: "Вы достали кубик из рукава!"
                });
            } else {
                player.diceCount--;
                player.dice.pop();
                io.to(room.id).emit('gameEvent', {
                    text: `🤡 ${player.name} уронил кубик!`,
                    type: 'error'
                });
                io.to(player.id).emit('yourDice', player.dice);
                socket.emit('skillResult', {
                    type: 'lucky',
                    text: "Фокус не удался, кубик потерян!"
                });
                if (player.diceCount === 0) {
                    checkEliminationAndContinue(room, player, null);
                    // дальше состояние обновит finalizeRound/startNewRound
                }
            }

            if (!player.skillsUsed) player.skillsUsed = [];
            player.skillsUsed.push('lucky');

            // если игрок ещё жив, можно просто обновить состояние
            if (player.diceCount > 0) {
                broadcastGameState(room);
            }

            io.to(room.id).emit('skillUsed', {
                playerId: player.id,
                name: player.name,
                skill: 'lucky'
            });
        }

        else if (skillType === 'kill') {
            if (level < 6) return socket.emit('errorMsg', 'Нужен ранг Капитан');

            const active = room.players.filter(p => p.diceCount > 0);
            if (active.length !== 2) return socket.emit('errorMsg', 'Нужно 1 на 1');

            const enemy = active.find(p => p.id !== player.id);
            if (!enemy) return socket.emit('errorMsg', 'Противник не найден');

            if (player.diceCount !== 1 || enemy.diceCount !== 1) {
                return socket.emit('errorMsg', 'У всех по 1 кубу');
            }

            if (Math.random() < 0.5) {
                io.to(room.id).emit('gameEvent', {
                    text: `🔫 ${player.name} пристрелил ${enemy.name}!`,
                    type: 'info'
                });
                // НЕ трогаем diceCount вручную, пусть всё сделает finalizeRound
                checkEliminationAndContinue(room, enemy, player);
            } else {
                io.to(room.id).emit('gameEvent', {
                    text: `🔫 ${player.name} промахнулся и застрелился!`,
                    type: 'error'
                });
                checkEliminationAndContinue(room, player, enemy);
            }

            if (!player.skillsUsed) player.skillsUsed = [];
            player.skillsUsed.push('kill');

            // состояние и таймеры обновит finalizeRound / startNewRound / gameOver
            io.to(room.id).emit('skillUsed', {
                playerId: player.id,
                name: player.name,
                skill: 'kill'
            });
        }

    } catch (e) {
        console.error(e);
        socket.emit('errorMsg', 'Ошибка навыка');
    }
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
            checkEliminationAndContinue(room, {diceCount:0, isBot:true, name: "Админская кара"}, null);
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
        addUserSocket(tgUser.id, socket.id); // <-- НОВАЯ СТРОКА
        const user = await loadUser(tgUser);
        const rank = getRankInfo(user.xp, user.streak);
        socket.emit('profileUpdate', { ...user, rankName: rank.current.name, currentRankMin: rank.current.min, nextRankXP: rank.next?.min || 'MAX', rankLevel: rank.current.level });
        if (user.pendingInvites && user.pendingInvites.length > 0) {
            user.pendingInvites.forEach(invite => { if (rooms.has(invite.roomId)) socket.emit('gameInvite', invite); });
            user.pendingInvites = []; await saveUser(tgUser.id);
        }
        for (const [roomId, room] of rooms) {
            if (room.status === 'PLAYING' || room.status === 'REVEAL') {
                const existingPlayer = room.players.find(p => p.tgId === tgUser.id);
                if (existingPlayer && !existingPlayer.hasLeft) {
                    existingPlayer.id = socket.id;
                    socket.join(roomId);
                    socket.emit('yourDice', existingPlayer.dice);
                    broadcastGameState(room);
                    if (room.status === 'REVEAL' && room.revealData) socket.emit('revealPhase', room.revealData);
                    socket.emit('gameEvent', { text: '🔄 Вы вернулись в бой!', type: 'info' });
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

    socket.on('disconnect', () => {
        // 1. Удаляем сокет из userSockets
        if (socket.tgUserId) {
            removeUserSocket(socket.tgUserId, socket.id);
        }

        // 2. Обрабатываем отключение в комнате
        const room = getRoomBySocketId(socket.id);
        if (room) {
            handlePlayerDisconnect(socket.id, room, false);
        }
    });

        // 2. Обрабатываем отключение в комнате (НЕ добровольный выход)
        const room = getRoomBySocketId(socket.id);
        if (room) {
            handlePlayerDisconnect(socket.id, room, false);
        }
    });
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

    socket.on('friendAction', async ({ action, payload }) => {
    if (!socket.tgUserId) return;
    const userId = socket.tgUserId;

    try {
        // ГАРАНТИРУЕМ, что user есть (из кеша или базы)
        let user = userCache.get(userId);
        if (!user) {
            const dbUser = await User.findOne({ id: userId });
            if (!dbUser) {
                // Пользователь ещё не создан / не логинился — безопасно выходим
                return;
            }
            user = dbUser.toObject();
            userCache.set(userId, user);
        }

        if (action === 'search') {
            let targetName = payload.trim().toLowerCase();
            if (targetName.startsWith('@')) targetName = targetName.substring(1);
            const found = await User.findOne({
                $and: [
                    { id: { $ne: userId } },
                    { $or: [{ username: targetName }, { name: new RegExp('^' + targetName + '$', 'i') }] }
                ]
            });
            if (found) socket.emit('friendSearchResult', { id: found.id, name: found.name });
            else socket.emit('friendSearchResult', null);
        }
        else if (action === 'request') {
            let targetId = payload;
            if (typeof payload === 'string' && isNaN(parseInt(payload))) {
                const ts = io.sockets.sockets.get(payload);
                if (ts && ts.tgUserId) targetId = ts.tgUserId;
                else return socket.emit('errorMsg', 'Игрок не найден');
            } else {
                targetId = parseInt(payload);
            }
            if (targetId === userId) return;

            let target = userCache.get(targetId);
            if (!target) {
                const t = await User.findOne({ id: targetId });
                if (t) target = t.toObject();
            }
            if (target && !target.requests.includes(userId) && !target.friends.includes(userId)) {
                target.requests.push(userId);
                if (userCache.has(targetId)) userCache.set(targetId, target);
                await User.updateOne({ id: targetId }, { requests: target.requests });

                const ts = findSocketIdByUserId(targetId);
                if (ts) {
                    io.to(ts).emit('notification', { type: 'friend_req' });
                    io.to(ts).emit('forceFriendUpdate');
                }
                socket.emit('errorMsg', 'Запрос отправлен!');
            } else {
                socket.emit('errorMsg', 'Ошибка запроса');
            }
        }
        else if (action === 'accept') {
            const targetId = parseInt(payload);
            let target = userCache.get(targetId);
            if (!target) {
                const t = await User.findOne({ id: targetId });
                if (t) target = t.toObject();
            }
            if (target) {
                if (!user.friends.includes(targetId)) user.friends.push(targetId);
                if (!target.friends.includes(userId)) target.friends.push(userId);
                user.requests = user.requests.filter(r => r !== targetId);

                userCache.set(userId, user);
                await saveUser(userId);

                if (userCache.has(targetId)) userCache.set(targetId, target);
                await User.updateOne({ id: targetId }, { friends: target.friends });

                socket.emit('friendAction', { action: 'get' });
                const ts = findSocketIdByUserId(targetId);
                if (ts) io.to(ts).emit('forceFriendUpdate');
            }
        }
        else if (action === 'decline') {
            const targetId = parseInt(payload);
            if (user.friends.includes(targetId)) {
                user.friends = user.friends.filter(x => x !== targetId);
                let target = userCache.get(targetId);
                if (!target) {
                    const t = await User.findOne({ id: targetId });
                    if (t) target = t.toObject();
                }
                if (target) {
                    target.friends = target.friends.filter(x => x !== userId);
                    if (userCache.has(targetId)) userCache.set(targetId, target);
                    await User.updateOne({ id: targetId }, { friends: target.friends });
                    const ts = findSocketIdByUserId(targetId);
                    if (ts) io.to(ts).emit('forceFriendUpdate');
                }
            } else {
                user.requests = user.requests.filter(x => x !== targetId);
            }
            userCache.set(userId, user);
            await saveUser(userId);
            socket.emit('friendAction', { action: 'get' });
        }
        else if (action === 'get') {
            const list = [];
            for (const fid of user.friends) {
                let fName = "Unknown";
                let st = "offline";
                const fc = userCache.get(fid);
                if (fc) {
                    fName = fc.name;
                    if (findSocketIdByUserId(fid)) st = "online";
                } else {
                    const fd = await User.findOne({ id: fid });
                    if (fd) fName = fd.name;
                }
                list.push({ id: fid, name: fName, status: st });
            }

            const reqs = [];
            for (const rid of user.requests) {
                const r = await User.findOne({ id: rid });
                if (r) reqs.push({ id: rid, name: r.name });
            }

            socket.emit('friendUpdate', { friends: list, requests: reqs });
        }
    } catch (e) {
        console.error('friendAction error:', e);
        socket.emit('errorMsg', 'Ошибка системы друзей');
    }
});
    socket.on('inviteToRoom', (targetId) => {
        if (!socket.tgUserId) return;
        const myRoom = getRoomBySocketId(socket.id);
        if (!myRoom || myRoom.status !== 'LOBBY') return;
        
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
    
    socket.on('leaveRoom', () => {
        const room = getRoomBySocketId(socket.id);
        if (room) handlePlayerDisconnect(socket.id, room, true);
    });

    socket.on('joinOrCreateRoom', ({ roomId, tgUser, options, mode }) => {
        const old = getRoomBySocketId(socket.id); 
        if (old) handlePlayerDisconnect(socket.id, old, true);

        for (const [rId, r] of rooms) {
            const cloneIdx = r.players.findIndex(p => p.tgId === tgUser.id && !p.isBot);
            if (cloneIdx !== -1) {
                r.players.splice(cloneIdx, 1);
                broadcastRoomUpdate(r);
            }
        }

        if (!tgUser) return;
        const userId = tgUser.id; 
        const uData = userCache.get(userId);
        const rInfo = getRankInfo(uData.xp, uData.streak);
        
        if (options && options.dice < 3) options.dice = 3;
        // Защита от неправильных настроек
        if (options) {
            options.dice = Math.min(Math.max(parseInt(options.dice) || 5, 3), 10); // от 3 до 10 кубов
            options.players = Math.min(Math.max(parseInt(options.players) || 2, 2), 10); // от 2 до 10 игроков
            options.time = Math.min(Math.max(parseInt(options.time) || 30, 15), 60); // от 15 до 60 секунд
        }
        if (options && (options.betCoins > uData.coins || options.betXp > uData.xp)) { socket.emit('errorMsg', 'NO_FUNDS'); return; }

        let room; let isCreator = false;

        if (mode === 'pve') {
            const newId = 'CPU_' + Math.random().toString(36).substring(2,6);
            room = { 
                id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null, history: [], timerId: null, turnDeadline: 0, 
                config: { dice: Math.max(3, options.dice), players: options.players, time: 30, jokers: options.jokers, spot: options.spot, strict: options.strict, difficulty: options.difficulty, crazy: !!options.crazy }, 
                isPvE: true 
            };
            rooms.set(newId, room); isCreator = true;
            room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: room.config.dice, ready: true, isCreator: true, equipped: uData.equipped, skillsUsed: [], rankLevel: rInfo.current.level });
            
            const namesMedium = ['Гиббс', 'Пинтел', 'Раджетти', 'Марти', 'Коттон', 'Малрой', 'Скрам', 'Мёртогг', 'Попугай'];
            const namesPirate = ['Джек Воробей', 'Уилл Тернер', 'Элизабет', 'Капитан Тиг', 'Сяо Фэнь', 'Флинт', 'Джон Сильвер', 'Прихлоп Билл', 'Анжелика'];
            const namesLegend = ['Дейви Джонс', 'Черная Борода', 'Барбосса', 'Шри Сумбаджи', 'Салазар', 'Калипсо', 'Капитан Крюк', 'Чёрный Барт', 'Амман Корсар'];

            let targetNames = namesMedium;
            let botRank = 'Матрос';
            if (options.difficulty === 'pirate') { targetNames = namesPirate; botRank = 'Капитан'; }
            if (options.difficulty === 'legend') { targetNames = namesLegend; botRank = 'Легенда морей'; }
            
            for(let i=0; i<options.players-1; i++) { 
                room.players.push({ id: 'bot_' + Math.random(), name: `${targetNames[i % targetNames.length]}`, rank: botRank, dice: [], diceCount: room.config.dice, ready: true, isCreator: false, isBot: true, equipped: { frame: 'frame_default' }, rankLevel: 0 }); 
            }
            socket.join(newId); startNewRound(room, true); return;
        }
        
        if (roomId) { 
            room = rooms.get(roomId); 
            if (room && room.deletionTimer) { clearTimeout(room.deletionTimer); room.deletionTimer = null; }
            if (!room || room.players.length >= room.config.players) { socket.emit('errorMsg', 'Ошибка входа или комната полна'); return; } 
            if (room.status === 'LOBBY' || room.status === 'FINISHED') {
                if (room.config.betCoins > uData.coins || room.config.betXp > uData.xp) { socket.emit('errorMsg', 'NO_FUNDS'); return; }
            }
        } else { 
            const newId = generateRoomId(); 
            const st = options || { dice: 5, players: 10, time: 30 }; if(st.dice < 3) st.dice = 3; 
            room = { id: newId, players: [], status: 'LOBBY', currentTurn: 0, currentBid: null, history: [], timerId: null, turnDeadline: 0, config: st, isPvE: false }; 
            rooms.set(newId, room); roomId = newId; isCreator = true; 
        }
        
        if (!isCreator) {
            const hasActiveCreator = room.players.some(p => p.isCreator);
            if (!hasActiveCreator) isCreator = true;
        }

        let initialDice = room.config.dice;
        let initialReady = false;
        if (room.status === 'PLAYING' || room.status === 'REVEAL') {
            initialDice = 0;
            initialReady = true; 
            socket.emit('gameEvent', { text: 'Вы вошли как наблюдатель', type: 'info' });
        }

        room.players.push({ id: socket.id, tgId: userId, name: uData.name, rank: rInfo.current.name, dice: [], diceCount: initialDice, ready: initialReady, isCreator: isCreator, equipped: uData.equipped, skillsUsed: [], rankLevel: rInfo.current.level });
        socket.join(roomId); 
        if (room.status === 'PLAYING' || room.status === 'REVEAL') broadcastGameState(room); else broadcastRoomUpdate(room);
    });

    socket.on('setReady', (isReady) => { const r = getRoomBySocketId(socket.id); if (r?.status === 'LOBBY') { const p = r.players.find(x => x.id === socket.id); if (p) { p.ready = isReady; broadcastRoomUpdate(r); } } });
    socket.on('startGame', () => { const r = getRoomBySocketId(socket.id); if (r) { const p = r.players.find(x => x.id === socket.id); if (p?.isCreator && r.players.length >= 2 && r.players.every(x => x.ready)) startNewRound(r, true); } });
    socket.on('makeBid', ({ quantity, faceValue }) => {
        const r = getRoomBySocketId(socket.id);
        if (!r || r.status !== 'PLAYING' || r.players[r.currentTurn].id !== socket.id) return;

        // ПРОВЕРКА: Превращаем в числа и проверяем, что это вообще числа
        const q = parseInt(quantity);
        const v = parseInt(faceValue);

        if (isNaN(q) || isNaN(v) || q < 1 || v < 1 || v > 6) {
            return socket.emit('errorMsg', 'Некорректная ставка!');
        }

        makeBidInternal(r, r.players[r.currentTurn], q, v);
    });
    socket.on('callBluff', () => handleCall(socket, 'bluff'));
    socket.on('callSpot', () => handleCall(socket, 'spot'));
    
    socket.on('playerReadyNext', () => {
        const r = getRoomBySocketId(socket.id);
        if(r && r.status === 'REVEAL') {
            if(!r.readyPlayers) r.readyPlayers = new Set();
            r.readyPlayers.add(socket.id);
            if(r.readyPlayers.size >= r.players.length) finalizeRound(r);
        }
    });

    socket.on('requestRestart', async () => { 
        const r = getRoomBySocketId(socket.id); 
        if (r?.status === 'FINISHED') { 
            for(const p of r.players) { if (!p.isBot && p.tgId) await pushProfileUpdate(p.tgId); }
            if (r.isPvE) { r.status = 'PLAYING'; r.players.forEach(p => { p.diceCount = r.config.dice; p.dice = []; p.skillsUsed = []; }); r.currentBid = null; startNewRound(r, true); } 
            else { r.status = 'LOBBY'; r.players.forEach(p => { p.diceCount = r.config.dice; p.ready = false; p.dice = []; p.skillsUsed = []; }); r.currentBid = null; broadcastRoomUpdate(r); } 
        } 
    });

    // --- LEADERBOARD ---
    socket.on('getLeaderboard', async () => {
        try {
            const topUsers = await User.find({}).sort({ xp: -1 }).limit(50).select('id name xp wins streak equipped');
            const leaderboard = topUsers.map((u, index) => {
                const rInfo = getRankInfo(u.xp, u.streak || 0);
                return {
                    rank: index + 1,
                    id: u.id,
                    name: u.name,
                    xp: u.xp,
                    wins: u.wins,
                    rankName: rInfo.current.name,
                    frame: u.equipped?.frame || 'frame_default'
                };
            });
            socket.emit('leaderboardData', leaderboard);
        } catch (e) { console.error(e); socket.emit('errorMsg', 'Ошибка загрузки топа'); }
    });
});

// --- KEEP ALIVE LOGIC ---
// Этот код заставляет сервер "стучаться" сам в себя, чтобы не заснуть на Render
const APP_URL = process.env.APP_URL || `https://liarsdicezmss.onrender.com`;

setInterval(() => {
    https.get(`${APP_URL}/ping`, (res) => {
        console.log(`Self-ping sent to ${APP_URL}/ping: Status ${res.statusCode}`);
    }).on('error', (err) => {
        console.error(`Self-ping failed: ${err.message}`);
    });
}, 10 * 60 * 1000); // Пингуем каждые 10 минут (10 * 60 * 1000 миллисекунд)

server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });














