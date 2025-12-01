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
        // Создание дефолтного пользователя
        const userData = {
            id: userId,
            rating: 100,
            wins: 0,
            losses: 0,
            streak: 0,
            name: `User${userId}`,
            coins: 100,
            inventory: [],
            equipped: {} // { itemType: itemId }
        };
        userDB.set(userId, userData);
    }
    const user = userDB.get(userId);
    user.rank = getRank(user.rating);
    return user;
}

function getRank(rating) {
    let rank = RANKS[0].name;
    for (const r of RANKS) {
        if (rating >= r.min) {
            rank = r.name;
        }
    }
    return rank;
}

// --- GAME STATE ---
const rooms = new Map(); // Map<roomId, roomObject>

// --- BOT LOGIC ---
const BOT_NAMES = ["Бот 1", "Бот 2", "Бот 3", "Бот 4", "Бот 5"];

function createBotPlayer(name) {
    return {
        id: `bot_${Date.now()}_${Math.random()}`,
        name: name,
        rank: 'Бот',
        diceCount: 5,
        dice: [],
        isBot: true,
        isEliminated: false,
        equipped: {}
    };
}

function makeBotBid(room) {
    // Простая бот-логика: повышает ставку или блефует с шансом 20%
    const currentBid = room.currentBid;
    const player = room.players[room.currentTurn];
    
    if (!currentBid) {
        // Начальная ставка
        room.currentBid = { qty: 1, val: 2 };
        io.to(room.id).emit('gameEvent', { text: `🤖 ${player.name} ставит 1 x 🎲2`, type: 'bid' });
        return;
    }

    const { qty, val } = currentBid;
    let newQty = qty;
    let newVal = val;
    let action = '';

    if (Math.random() < 0.2 && qty >= 2) {
        // Шанс блефа/В Точку
        if (room.rules.spot && Math.random() < 0.5) {
            action = 'spot';
        } else {
            action = 'bluff';
        }
    } else {
        // Повышение
        if (Math.random() < 0.5) {
            newQty = qty + 1;
            newVal = val;
        } else {
            newQty = qty;
            newVal = val < 6 ? val + 1 : 6;
            if (newVal === 6 && newQty === qty) newQty++; // Если дошли до 6, повышаем количество
        }
        
        // Убеждаемся, что новая ставка выше
        if (newQty * 10 + newVal <= qty * 10 + val) {
             newQty++;
        }

        action = 'bid';
        room.currentBid = { qty: newQty, val: newVal };
    }

    switch (action) {
        case 'bid':
            io.to(room.id).emit('gameEvent', { text: `🤖 ${player.name} ставит ${newQty} x 🎲${newVal}`, type: 'bid' });
            break;
        case 'bluff':
            resolveBluff(room);
            break;
        case 'spot':
            resolveSpot(room);
            break;
    }
}


function rollDice(room) {
    let allDice = [];
    room.players.forEach(p => {
        if (p.diceCount > 0) {
            p.dice = Array(p.diceCount).fill(0).map(() => Math.floor(Math.random() * 6) + 1);
            allDice = allDice.concat(p.dice);
        } else {
             p.dice = []; // Кубиков нет
        }
    });
    room.allDice = allDice;
}

function resetGame(room, settings) {
    room.state = 'lobby';
    room.currentTurn = -1;
    room.currentBid = null;
    room.rules = settings.rules || settings.pve;
    room.dicePerPlayer = settings.dice || 5;
    room.turnDuration = (settings.time || 30) * 1000;
    room.turnDeadline = 0;
    
    room.players.forEach(p => {
        p.diceCount = room.dicePerPlayer;
        p.dice = [];
        p.isEliminated = false;
    });
    
    // Удаляем ботов, если это не PvE
    if (settings.pve && settings.pve.bots > 0) {
        // оставляем ботов
    } else {
        room.players = room.players.filter(p => !p.isBot);
    }
}

function startGame(room) {
    room.state = 'game';
    room.currentTurn = Math.floor(Math.random() * room.players.length);
    room.currentBid = null;
    
    rollDice(room);
    
    // Отправка кубиков только владельцам
    room.players.forEach(p => { if (p.diceCount > 0 && !p.isBot) io.to(p.id).emit('yourDice', p.dice); });
    io.to(room.id).emit('gameEvent', { text: `🎲 РАУНД!`, type: 'info' });
    
    resetTurnTimer(room); // Таймер ДО отправки
    broadcastGameState(room);
}

function nextTurn(room) {
    let l = 0; 
    do { 
        room.currentTurn = (room.currentTurn + 1) % room.players.length; 
        l++; if(l>20)return; 
    } while (room.players[room.currentTurn].diceCount === 0);
    
    resetTurnTimer(room); 
    broadcastGameState(room);
    
    // Ход бота
    const player = room.players[room.currentTurn];
    if (player.isBot) {
        setTimeout(() => makeBotBid(room), 1000); // Бот делает ход через 1с
    }
}

function checkTurnTimeout(room) {
    const player = room.players[room.currentTurn];

    if (!player) return;

    if (player.isBot) {
        // Логика для бота остается
        makeBotBid(room);
        room.turnDeadline = Date.now(); // Сброс таймер
        nextTurn(room);
    } else {
        // --- ИЗМЕНЕНИЕ: ИСКЛЮЧЕНИЕ ИГРОКА ПРИ ТАЙМ-АУТЕ ---
        player.diceCount = 0; // Исключаем игрока
        player.isEliminated = true;
        io.to(room.id).emit('gameEvent', { text: `⏰ ${player.name} не успел сделать ход и выбывает из раунда!`, type: 'alert' });
        
        // Отправляем сообщение только этому игроку, что он выбыл
        io.to(player.id).emit('roundResult', { message: '⏰ Вы не успели сделать ход и выбыли из раунда!' });

        broadcastGameState(room);
        
        const winners = room.players.filter(p => p.diceCount > 0);
        if (winners.length <= 1) {
            endRound(room);
        } else {
            // Переход хода
            nextTurn(room);
        }
    }
}

function resetTurnTimer(room) {
    if (room.timer) clearTimeout(room.timer);
    room.turnDeadline = Date.now() + room.turnDuration;
    room.timer = setTimeout(() => checkTurnTimeout(room), room.turnDuration + 500); // + буфер
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
        remainingTime: remaining,
        totalDuration: room.turnDuration,
        rules: room.rules
    });
}

function resolveBluff(room) {
    if (!room.currentBid) {
        io.to(room.id).emit('gameEvent', { text: `⚠️ Нельзя сказать "Не верю" без ставки!`, type: 'error' });
        return;
    }

    clearTimeout(room.timer);

    const { qty, val } = room.currentBid;
    let count = 0;
    
    // Подсчет
    if (room.rules.jokers) {
        count = room.allDice.filter(d => d === val || d === 1).length;
    } else {
        count = room.allDice.filter(d => d === val).length;
    }

    let message = '';
    let loserId = null;
    let winnerId = null;

    if (count >= qty) {
        // Ставка была правдой
        const bidderIndex = (room.currentTurn - 1 + room.players.length) % room.players.length;
        let bidder = room.players[bidderIndex];
        let caller = room.players[room.currentTurn];
        
        // Находим реальных игроков, которые могут быть не исключены
        let l = 0;
        while(bidder.diceCount === 0 && l < room.players.length) {
            bidderIndex = (bidderIndex - 1 + room.players.length) % room.players.length;
            bidder = room.players[bidderIndex];
            l++;
        }
        
        if(bidder.diceCount === 0) { // Никого не нашли
            io.to(room.id).emit('gameEvent', { text: `⚠️ Ошибка: не удалось найти игрока, сделавшего ставку.`, type: 'error' });
            endRound(room); return;
        }


        message = `✅ ${bidder.name} не блефовал! Найдено ${count} x 🎲${val}. ${caller.name} теряет кубик.`;
        loserId = caller.id;
        winnerId = bidder.id;
        caller.diceCount--;
    } else {
        // Ставка была блефом
        const bidderIndex = (room.currentTurn - 1 + room.players.length) % room.players.length;
        let bidder = room.players[bidderIndex];
        let caller = room.players[room.currentTurn];

        // Находим реальных игроков, которые могут быть не исключены
        let l = 0;
        while(bidder.diceCount === 0 && l < room.players.length) {
            bidderIndex = (bidderIndex - 1 + room.players.length) % room.players.length;
            bidder = room.players[bidderIndex];
            l++;
        }

        if(bidder.diceCount === 0) { // Никого не нашли
            io.to(room.id).emit('gameEvent', { text: `⚠️ Ошибка: не удалось найти игрока, сделавшего ставку.`, type: 'error' });
            endRound(room); return;
        }

        message = `❌ ${bidder.name} блефовал! Найдено ${count} x 🎲${val}. ${bidder.name} теряет кубик.`;
        loserId = bidder.id;
        winnerId = caller.id;
        bidder.diceCount--;
    }

    io.to(room.id).emit('roundResult', { message: message, allDice: room.allDice, loserId: loserId });
    endRound(room);
}

function resolveSpot(room) {
    if (!room.currentBid) {
        io.to(room.id).emit('gameEvent', { text: `⚠️ Нельзя сказать "В Точку" без ставки!`, type: 'error' });
        return;
    }
    
    clearTimeout(room.timer);

    const { qty, val } = room.currentBid;
    let count = 0;
    
    // Подсчет
    if (room.rules.jokers) {
        count = room.allDice.filter(d => d === val || d === 1).length;
    } else {
        count = room.allDice.filter(d => d === val).length;
    }

    let message = '';
    let winner = room.players[room.currentTurn];
    let loserId = null;
    let winnerId = winner.id; // По умолчанию, назвавший - победитель, пока не определен проигравший

    if (count === qty) {
        // Успех!
        message = `🎯 В ТОЧКУ! Найдено ${count} x 🎲${val}. ${winner.name} забирает по кубику у всех!`;
        winner.diceCount++;
        room.players.forEach(p => {
            if (p.id !== winner.id && p.diceCount > 0) {
                p.diceCount--;
            }
        });
        
    } else {
        // Неудача
        message = `❌ НЕ ТОЧНО! Найдено ${count} x 🎲${val}. ${winner.name} теряет кубик.`;
        winner.diceCount--;
        loserId = winner.id;
        winnerId = null;
    }

    io.to(room.id).emit('roundResult', { message: message, allDice: room.allDice, loserId: loserId, spotSuccess: count === qty });
    endRound(room);
}

function endRound(room) {
    room.currentBid = null;
    room.state = 'intermission';
    
    // Обновление статуса исключенных игроков
    room.players.forEach(p => { 
        if (p.diceCount <= 0) p.isEliminated = true;
    });

    const activePlayers = room.players.filter(p => p.diceCount > 0);

    if (activePlayers.length <= 1) {
        // КОНЕЦ ИГРЫ
        if (activePlayers.length === 1) {
            const winner = activePlayers[0];
            io.to(room.id).emit('gameOver', { winner: winner.name });
            io.to(room.id).emit('gameEvent', { text: `👑 ${winner.name} побеждает!`, type: 'success' });
        } else {
            // Ничья или ошибка
            io.to(room.id).emit('gameOver', { winner: 'Никто' });
            io.to(room.id).emit('gameEvent', { text: `🤝 Игра окончена ничьей.`, type: 'success' });
        }
        
        // Удаляем комнату через 10с
        setTimeout(() => rooms.delete(room.id), 10000);
    } else {
        // СЛЕДУЮЩИЙ РАУНД
        io.to(room.id).emit('gameEvent', { text: `➡️ Следующий раунд через 5 секунд...`, type: 'info' });
        
        // Переход хода к проигравшему (для Bluff/Spot) или к следующему игроку
        let nextStartTurn = room.currentTurn; 
        
        // Если проигравший выбыл, начинаем с его следующего
        if(room.players[nextStartTurn] && room.players[nextStartTurn].diceCount === 0) {
            let l = 0;
            do { 
                nextStartTurn = (nextStartTurn + 1) % room.players.length; 
                l++; if(l>20)break; 
            } while (room.players[nextStartTurn].diceCount === 0);
        }
        
        room.currentTurn = nextStartTurn;
        
        setTimeout(() => {
            startGame(room); // Начать новый раунд
        }, 5000);
    }
}


// --- SOCKET.IO ---

io.on('connection', (socket) => {
    
    // 1. LOGIN
    socket.on('login', ({ username, userId, coins, inventory, equipped }) => {
        let userData = getUserData(userId);
        
        if (username) userData.name = username;
        
        // Обновление данных (имитация загрузки с клиента)
        userData.coins = coins !== undefined ? coins : userData.coins;
        userData.inventory = inventory || userData.inventory;
        userData.equipped = equipped || userData.equipped;
        
        socket.data.user = userData;
        socket.emit('loginSuccess', { name: userData.name, rank: userData.rank, rating: userData.rating, coins: userData.coins, inventory: userData.inventory, equipped: userData.equipped });
    });

    // 2. CREATE ROOM
    socket.on('createRoom', ({ settings }) => {
        const userId = socket.data.user.id;
        const existingRoomId = [...rooms.values()].find(r => r.players.some(p => p.id === userId))?.id;
        if (existingRoomId) socket.leave(existingRoomId);

        const roomId = `room_${Date.now()}`;
        const room = {
            id: roomId,
            name: `${socket.data.user.name}'s room`,
            players: [{ 
                id: socket.id, name: socket.data.user.name, rank: socket.data.user.rank, 
                diceCount: settings.dice || 5, dice: [], isBot: false, isEliminated: false, 
                equipped: socket.data.user.equipped
            }],
            state: 'lobby', // lobby, game, intermission
            currentTurn: -1,
            currentBid: null, // { qty: 1, val: 2 }
            rules: settings.rules, // { jokers: false, spot: false, strict: false }
            dicePerPlayer: settings.dice || 5,
            turnDuration: (settings.time || 30) * 1000,
            turnDeadline: 0,
            timer: null,
            allDice: []
        };

        if (settings.pve && settings.pve.bots > 0) {
            for (let i = 0; i < settings.pve.bots; i++) {
                room.players.push(createBotPlayer(BOT_NAMES[i % BOT_NAMES.length]));
            }
            room.rules = settings.pve; // Обновляем правила для PvE
        }

        rooms.set(roomId, room);
        socket.join(roomId);
        socket.data.roomId = roomId;
        io.to(roomId).emit('roomUpdate', { 
            roomId: roomId, 
            settings: room.rules, 
            players: room.players.map(p => ({ 
                name: p.name, rank: p.rank, isBot: p.isBot, id: p.id, equipped: p.equipped
            })) 
        });
        socket.emit('joinedRoom', { roomId: roomId, settings: room.rules });
    });

    // 3. JOIN ROOM
    socket.on('joinRoom', ({ roomId }) => {
        const existingRoomId = [...rooms.values()].find(r => r.players.some(p => p.id === socket.data.user.id))?.id;
        if (existingRoomId) socket.leave(existingRoomId);

        const room = rooms.get(roomId);
        if (room && room.state === 'lobby' && !room.players.some(p => p.id === socket.data.user.id)) {
            const newPlayer = {
                id: socket.id, name: socket.data.user.name, rank: socket.data.user.rank, 
                diceCount: room.dicePerPlayer, dice: [], isBot: false, isEliminated: false, 
                equipped: socket.data.user.equipped
            };
            room.players.push(newPlayer);
            socket.join(roomId);
            socket.data.roomId = roomId;
            
            io.to(roomId).emit('roomUpdate', { 
                roomId: roomId, 
                settings: room.rules, 
                players: room.players.map(p => ({ 
                    name: p.name, rank: p.rank, isBot: p.isBot, id: p.id, equipped: p.equipped 
                })) 
            });
            socket.emit('joinedRoom', { roomId: roomId, settings: room.rules });
        } else if (room && room.players.some(p => p.id === socket.data.user.id)) {
            // Reconnect
            socket.join(roomId);
            socket.data.roomId = roomId;
            const myPlayer = room.players.find(p => p.id === socket.data.user.id);
            myPlayer.id = socket.id; // Обновляем ID сокета
            
            io.to(roomId).emit('roomUpdate', { 
                roomId: roomId, 
                settings: room.rules, 
                players: room.players.map(p => ({ 
                    name: p.name, rank: p.rank, isBot: p.isBot, id: p.id, equipped: p.equipped 
                })) 
            });
            socket.emit('joinedRoom', { roomId: roomId, settings: room.rules });
            if (room.state === 'game' || room.state === 'intermission') {
                 broadcastGameState(room);
                 if(myPlayer.diceCount > 0) io.to(myPlayer.id).emit('yourDice', myPlayer.dice);
            }
        } else {
            socket.emit('joinFailed', { message: 'Комната не найдена или игра уже началась.' });
        }
    });

    // 4. START GAME
    socket.on('startGame', () => {
        const roomId = socket.data.roomId;
        const room = rooms.get(roomId);
        
        if (room && room.players.length >= 2 && room.state === 'lobby') {
            startGame(room);
        } else if(room && room.players.length < 2) {
             socket.emit('gameEvent', { text: `⚠️ Нужно минимум 2 игрока для старта.`, type: 'error' });
        }
    });
    
    // 5. MAKE BID
    socket.on('makeBid', ({ qty, val }) => {
        const roomId = socket.data.roomId;
        const room = rooms.get(roomId);
        
        if (!room || room.state !== 'game' || room.players[room.currentTurn].id !== socket.id) {
            socket.emit('gameEvent', { text: `⚠️ Сейчас не ваш ход!`, type: 'error' });
            return;
        }
        
        const currentBid = room.currentBid;
        const player = room.players[room.currentTurn];

        if (qty < 1 || val < 2 || val > 6) {
            socket.emit('gameEvent', { text: `⚠️ Некорректная ставка.`, type: 'error' });
            return;
        }
        
        if (currentBid) {
            const currentTotal = currentBid.qty * 10 + currentBid.val;
            const newTotal = qty * 10 + val;
            
            if (newTotal <= currentTotal) {
                socket.emit('gameEvent', { text: `⚠️ Ставка должна быть выше текущей: ${currentBid.qty} x 🎲${currentBid.val}`, type: 'error' });
                return;
            }
        } else {
             if (qty * 10 + val < 12) { // Минимальная ставка 1x2
                socket.emit('gameEvent', { text: `⚠️ Минимальная ставка 1 x 🎲2`, type: 'error' });
                return;
             }
        }
        
        room.currentBid = { qty, val };
        io.to(roomId).emit('gameEvent', { text: `${player.name} ставит ${qty} x 🎲${val}`, type: 'bid' });
        
        nextTurn(room);
    });
    
    // 6. CALL BLUFF
    socket.on('callBluff', () => {
        const roomId = socket.data.roomId;
        const room = rooms.get(roomId);
        
        if (!room || room.state !== 'game' || room.players[room.currentTurn].id !== socket.id) {
            socket.emit('gameEvent', { text: `⚠️ Сейчас не ваш ход!`, type: 'error' });
            return;
        }
        
        if (!room.currentBid) {
            socket.emit('gameEvent', { text: `⚠️ Нельзя сказать "Не верю" без ставки!`, type: 'error' });
            return;
        }
        
        const player = room.players[room.currentTurn];
        io.to(roomId).emit('gameEvent', { text: `${player.name} говорит "НЕ ВЕРЮ!"`, type: 'bluff' });
        
        resolveBluff(room);
    });

    // 7. CALL SPOT
    socket.on('callSpot', () => {
        const roomId = socket.data.roomId;
        const room = rooms.get(roomId);
        
        if (!room || room.state !== 'game' || room.players[room.currentTurn].id !== socket.id) {
            socket.emit('gameEvent', { text: `⚠️ Сейчас не ваш ход!`, type: 'error' });
            return;
        }

        if (!room.rules.spot) {
            socket.emit('gameEvent', { text: `⚠️ Правило 'В Точку' не включено.`, type: 'error' });
            return;
        }
        
        if (!room.currentBid) {
            socket.emit('gameEvent', { text: `⚠️ Нельзя сказать "В Точку" без ставки!`, type: 'error' });
            return;
        }
        
        const player = room.players[room.currentTurn];
        io.to(roomId).emit('gameEvent', { text: `${player.name} говорит "В ТОЧКУ!"`, type: 'spot' });
        
        resolveSpot(room);
    });

    // 8. DISCONNECT / LEAVE ROOM
    socket.on('disconnect', () => {
        const userId = socket.data.user?.id;
        const roomId = socket.data.roomId;
        const room = rooms.get(roomId);

        if (room) {
            // Удаляем не-ботов
            room.players = room.players.filter(p => p.id !== socket.id && p.id !== userId);
            
            if (room.players.length === 0) {
                clearTimeout(room.timer);
                rooms.delete(roomId);
            } else {
                io.to(roomId).emit('roomUpdate', { 
                    roomId: roomId, 
                    settings: room.rules, 
                    players: room.players.map(p => ({ 
                        name: p.name, rank: p.rank, isBot: p.isBot, id: p.id, equipped: p.equipped 
                    })) 
                });
                
                if (room.state === 'game' && room.players.every(p => p.diceCount === 0 || p.isBot)) {
                    // Если остались только боты и/или исключенные
                    // Находим не исключенного бота
                    const firstBot = room.players.find(p => p.isBot && p.diceCount > 0);
                    if(firstBot) {
                        io.to(roomId).emit('gameOver', { winner: firstBot.name });
                        io.to(roomId).emit('gameEvent', { text: `🤖 Бот ${firstBot.name} побеждает, остальные вышли.`, type: 'success' });
                        rooms.delete(roomId);
                    } else if (room.players.filter(p => p.diceCount > 0).length === 1) {
                         // Остался один победитель
                        const winner = room.players.find(p => p.diceCount > 0);
                        io.to(roomId).emit('gameOver', { winner: winner.name });
                        io.to(roomId).emit('gameEvent', { text: `👑 ${winner.name} побеждает!`, type: 'success' });
                        rooms.delete(roomId);
                    } else {
                         // Все выбыли
                        io.to(roomId).emit('gameOver', { winner: 'Никто' });
                        io.to(roomId).emit('gameEvent', { text: `🤝 Игра окончена ничьей.`, type: 'success' });
                        rooms.delete(roomId);
                    }
                } else if (room.state === 'game' && room.players[room.currentTurn].diceCount === 0) {
                     // Если отключившийся был текущим игроком и у него 0 кубиков
                    nextTurn(room);
                }
            }
        }
    });
});

// --- TELEGRAM BOT ---
if (token) {
    const bot = new TelegramBot(token, { polling: true });

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from.username || msg.from.first_name;
        
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ 
                        text: "🎲 Играть!", 
                        web_app: { url: process.env.WEB_APP_URL } 
                    }]
                ]
            }
        };
        bot.sendMessage(chatId, `Добро пожаловать, ${username}! Нажмите "Играть!", чтобы запустить Костяшки.`, opts);
    });

    // Слушатель для кнопки "Админ"
    bot.onText(/\/admin/, (msg) => {
        const chatId = msg.chat.id;
        if (chatId === ADMIN_ID) {
            const stats = `
                **Статистика сервера:**
                - Активных комнат: ${rooms.size}
                - Всего пользователей в DB: ${userDB.size}
            `;
            bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
        }
    });

    bot.on('message', (msg) => {
        // Логика для обработки других сообщений
    });
    
    console.log('Telegram Bot running...');
}


// --- SERVER START ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
