require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const token = process.env.TELEGRAM_BOT_TOKEN;
const TURN_DURATION_MS = 30000; 

// --- Telegram Bot ---
const bot = token ? new TelegramBot(token, { polling: true }) : null;

if (bot) {
    console.log('Bot started...');
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = (msg.text || '').trim();
        // Реагируем на любые вариации /start
        if (text.toLowerCase().includes('/start')) {
             const message = `🏴‍☠️ **Кости Лжеца** 🏴‍☠️\n\nЖми кнопку «Меню» (слева) или кнопку ниже!`;
             
             // Пытаемся отправить кнопку, но если не выйдет - пользователь увидит текст
             const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🎲 ИГРАТЬ", web_app: { url: 'https://liarsdicezmss.onrender.com/' } }]
                    ]
                }
            };
            bot.sendMessage(chatId, message, opts).catch(e => console.log('Error sending msg:', e.message));
        }
    });
}

app.use(express.static(path.join(__dirname, 'public')));

// --- Game Logic ---
const rooms = new Map(); 

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function rollDice(count) {
    return Array.from({length: count}, () => Math.floor(Math.random() * 6) + 1).sort((a,b)=>a-b);
}

function getRoomBySocketId(socketId) {
    for (const [roomId, room] of rooms) {
        if (room.players.find(p => p.id === socketId)) return room;
    }
    return null;
}

// --- Timer ---
function resetTurnTimer(room) {
    if (room.timerId) clearTimeout(room.timerId);
    room.turnDeadline = Date.now() + TURN_DURATION_MS;
    room.timerId = setTimeout(() => handleTimeout(room), TURN_DURATION_MS);
}

function handleTimeout(room) {
    if (room.status !== 'PLAYING') return;
    const loser = room.players[room.currentTurn];
    
    io.to(room.id).emit('gameEvent', { text: `⏰ ВРЕМЯ ВЫШЛО! ${loser.name} уснул и теряет кубик!`, type: 'error' });
    
    loser.diceCount--;
    checkEliminationAndContinue(room, loser);
}

// --- Socket.IO ---
io.on('connection', (socket) => {
    
    // Вход / Создание
    socket.on('joinOrCreateRoom', ({ roomId, username, options }) => {
        const oldRoom = getRoomBySocketId(socket.id);
        if (oldRoom) leaveRoom(socket, oldRoom);

        let room;
        let isCreator = false;

        if (roomId) {
            // ПРИСОЕДИНЕНИЕ
            room = rooms.get(roomId);
            if (!room) {
                socket.emit('errorMsg', 'Комната не найдена');
                return;
            }
            if (room.status !== 'LOBBY') {
                socket.emit('errorMsg', 'Игра уже идет');
                return;
            }
            if (room.players.length >= room.maxPlayers) {
                socket.emit('errorMsg', 'Комната переполнена');
                return;
            }
        } else {
            // СОЗДАНИЕ НОВОЙ
            const newId = generateRoomId();
            
            // Настройки по умолчанию или от пользователя
            const settings = options || { dice: 5, players: 10 };
            
            room = {
                id: newId,
                players: [],
                status: 'LOBBY',
                currentTurn: 0,
                currentBid: null,
                history: [],
                timerId: null,
                turnDeadline: 0,
                // Сохраняем настройки комнаты
                maxPlayers: settings.players,
                initialDice: settings.dice
            };
            rooms.set(newId, room);
            roomId = newId;
            isCreator = true;
        }

        room.players.push({
            id: socket.id,
            name: username || `Пират ${room.players.length + 1}`,
            dice: [],
            diceCount: isCreator ? room.initialDice : room.initialDice, // Пока просто сохраняем, выдадим при старте
            ready: false,
            isCreator: isCreator
        });
        socket.join(roomId);
        broadcastRoomUpdate(room);
    });

    socket.on('setReady', (isReady) => {
        const room = getRoomBySocketId(socket.id);
        if (room && room.status === 'LOBBY') {
            const p = room.players.find(p => p.id === socket.id);
            if (p) {
                p.ready = isReady;
                broadcastRoomUpdate(room);
            }
        }
    });

    socket.on('startGame', () => {
        const room = getRoomBySocketId(socket.id);
        if (!room) return;
        const p = room.players.find(p => p.id === socket.id);
        
        // Проверка: минимум 2 игрока
        if (p && p.isCreator && room.players.length >= 2 && room.players.every(pl => pl.ready)) {
            startNewRound(room, true);
        } else if (room.players.length < 2) {
            socket.emit('errorMsg', 'Нужно минимум 2 игрока!');
        } else {
            socket.emit('errorMsg', 'Все должны быть готовы!');
        }
    });

    socket.on('makeBid', ({ quantity, faceValue }) => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'PLAYING') return;
        if (room.players[room.currentTurn].id !== socket.id) return;

        quantity = parseInt(quantity);
        faceValue = parseInt(faceValue);

        let isValid = false;
        if (!room.currentBid) {
            isValid = quantity > 0 && faceValue >= 1 && faceValue <= 6;
        } else {
            if (quantity > room.currentBid.quantity) isValid = true;
            else if (quantity === room.currentBid.quantity && faceValue > room.currentBid.faceValue) isValid = true;
        }

        if (!isValid) {
            socket.emit('errorMsg', 'Нужно повысить ставку!');
            return;
        }

        room.currentBid = { quantity, faceValue, playerId: socket.id };
        const pName = room.players[room.currentTurn].name;
        
        io.to(room.id).emit('gameEvent', { text: `${pName} ставит: ${quantity}x[${faceValue}]`, type: 'info' });
        nextTurn(room);
    });

    socket.on('callBluff', () => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'PLAYING' || !room.currentBid) return;
        if (room.players[room.currentTurn].id !== socket.id) return;

        if (room.timerId) clearTimeout(room.timerId);

        const challenger = room.players[room.currentTurn];
        const bidder = room.players.find(p => p.id === room.currentBid.playerId);

        io.to(room.id).emit('gameEvent', { text: `🔥 ${challenger.name} ВСКРЫВАЕТ ${bidder.name}!`, type: 'alert' });

        let total = 0;
        const allDice = {};
        room.players.forEach(p => {
            if (p.diceCount > 0) {
                p.dice.forEach(d => { if (d === room.currentBid.faceValue) total++; });
                allDice[p.name] = p.dice;
            }
        });

        io.to(room.id).emit('revealDice', allDice);

        let loser;
        let msg = `На столе ${total} кубиков [${room.currentBid.faceValue}]. Ставка: ${room.currentBid.quantity}. `;

        if (total < room.currentBid.quantity) {
            msg += `Блеф! ${bidder.name} теряет кубик.`;
            loser = bidder;
        } else {
            msg += `Правда! ${challenger.name} зря не поверил и теряет кубик.`;
            loser = challenger;
        }

        io.to(room.id).emit('roundResult', { message: msg });
        
        loser.diceCount--;
        
        setTimeout(() => {
            checkEliminationAndContinue(room, loser);
        }, 5000);
    });

    socket.on('requestRestart', () => {
        const room = getRoomBySocketId(socket.id);
        if (room && room.status === 'FINISHED') {
            room.status = 'LOBBY';
            room.players.forEach(p => {
                // Возвращаем исходное кол-во кубиков
                p.diceCount = room.initialDice;
                p.ready = false;
                p.dice = [];
            });
            room.currentBid = null;
            broadcastRoomUpdate(room);
        }
    });

    socket.on('disconnect', () => {
        const room = getRoomBySocketId(socket.id);
        if (room) leaveRoom(socket, room);
    });
});

// --- Helpers ---

function checkEliminationAndContinue(room, loser) {
    if (loser.diceCount === 0) {
        io.to(room.id).emit('gameEvent', { text: `💀 ${loser.name} выбывает из игры!`, type: 'error' });
    }

    const active = room.players.filter(p => p.diceCount > 0);
    if (active.length === 1) {
        room.status = 'FINISHED';
        if (room.timerId) clearTimeout(room.timerId);
        io.to(room.id).emit('gameOver', { winner: active[0].name });
    } else {
        let nextIdx = room.players.indexOf(loser);
        if (loser.diceCount === 0) {
            do {
                nextIdx = (nextIdx + 1) % room.players.length;
            } while (room.players[nextIdx].diceCount === 0);
        }
        startNewRound(room, false, nextIdx);
    }
}

function leaveRoom(socket, room) {
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
        const wasCreator = room.players[idx].isCreator;
        room.players.splice(idx, 1);
        if (room.players.length === 0) {
            if (room.timerId) clearTimeout(room.timerId);
            rooms.delete(room.id);
        } else {
            if (wasCreator) room.players[0].isCreator = true;
            if (room.status === 'PLAYING' && idx === room.currentTurn) {
               nextTurn(room); 
            }
            broadcastRoomUpdate(room);
        }
    }
}

function broadcastRoomUpdate(room) {
    io.to(room.id).emit('roomUpdate', {
        roomId: room.id,
        players: room.players.map(p => ({ name: p.name, ready: p.ready, isCreator: p.isCreator, diceCount: room.initialDice })), // Показываем макс кол-во
        status: room.status,
        config: { dice: room.initialDice, players: room.maxPlayers }
    });
}

function startNewRound(room, isFirst = false, startIdx = null) {
    room.status = 'PLAYING';
    room.currentBid = null;
    
    room.players.forEach(p => {
        // Если первый раунд или рестарт - у всех должно быть корректное число.
        // Если игра идет - не трогаем diceCount, он уменьшается при проигрыше
        if (isFirst && p.diceCount === 0) p.diceCount = room.initialDice; // Страховка
        
        p.dice = p.diceCount > 0 ? rollDice(p.diceCount) : [];
    });

    if (startIdx !== null) room.currentTurn = startIdx;
    else if (isFirst) room.currentTurn = 0;
    else nextTurn(room);

    while (room.players[room.currentTurn].diceCount === 0) {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
    }

    room.players.forEach(p => {
        if (p.diceCount > 0) io.to(p.id).emit('yourDice', p.dice);
    });

    io.to(room.id).emit('gameEvent', { text: `🎲 РАУНД НАЧАЛСЯ!`, type: 'info' });
    broadcastGameState(room);
}

function nextTurn(room) {
    let loops = 0;
    do {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
        loops++;
        if (loops > 20) return; 
    } while (room.players[room.currentTurn].diceCount === 0);

    resetTurnTimer(room);
    broadcastGameState(room);
}

function broadcastGameState(room) {
    const publicPlayers = room.players.map((p, i) => ({
        name: p.name,
        diceCount: p.diceCount,
        isTurn: i === room.currentTurn,
        isEliminated: p.diceCount === 0
    }));

    io.to(room.id).emit('gameState', {
        players: publicPlayers,
        currentBid: room.currentBid,
        turnDeadline: room.turnDeadline
    });
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
