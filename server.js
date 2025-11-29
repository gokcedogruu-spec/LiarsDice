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
const TURN_DURATION_MS = 30000; // 30 секунд на ход

// --- Telegram Bot ---
const bot = token ? new TelegramBot(token, { polling: true }) : null;

if (bot) {
    console.log('Bot started...');
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = (msg.text || '').trim();
        if (text.toLowerCase().includes('/start')) {
            const message = `🏴‍☠️ **Кости Лжеца: Мультяшная Версия!** 🏴‍☠️\n\nЖми кнопку «Меню» или кнопку ниже, чтобы играть!`;
            bot.sendMessage(chatId, message).catch(e => console.error(e.message));
        }
    });
}

// --- Express ---
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

// --- Timer Logic ---
function resetTurnTimer(room) {
    // Очищаем старый таймер
    if (room.timerId) clearTimeout(room.timerId);

    room.turnDeadline = Date.now() + TURN_DURATION_MS;

    // Ставим новый таймер
    room.timerId = setTimeout(() => {
        handleTimeout(room);
    }, TURN_DURATION_MS);
}

function handleTimeout(room) {
    if (room.status !== 'PLAYING') return;

    const loserIndex = room.currentTurn;
    const loser = room.players[loserIndex];

    io.to(room.id).emit('gameEvent', { 
        text: `⏰ ВРЕМЯ ВЫШЛО! ${loser.name} уснул и теряет кубик!`, 
        type: 'error' 
    });

    loser.diceCount--;
    checkEliminationAndContinue(room, loser);
}

// --- Socket.IO ---
io.on('connection', (socket) => {
    
    // 1. Вход / Создание
    socket.on('joinOrCreateRoom', ({ roomId, username }) => {
        const oldRoom = getRoomBySocketId(socket.id);
        if (oldRoom) leaveRoom(socket, oldRoom);

        let room;
        let isCreator = false;

        if (roomId) {
            room = rooms.get(roomId);
            if (!room || room.status !== 'LOBBY' || room.players.length >= 10) {
                socket.emit('errorMsg', 'Нельзя войти (комната полна, идет игра или не существует)');
                return;
            }
        } else {
            const newId = generateRoomId();
            room = {
                id: newId,
                players: [],
                status: 'LOBBY',
                currentTurn: 0,
                currentBid: null,
                history: [],
                timerId: null,
                turnDeadline: 0
            };
            rooms.set(newId, room);
            roomId = newId;
            isCreator = true;
        }

        room.players.push({
            id: socket.id,
            name: username || `Пират ${room.players.length + 1}`,
            dice: [],
            diceCount: 5,
            ready: false,
            isCreator: isCreator
        });
        socket.join(roomId);
        broadcastRoomUpdate(room);
    });

    // 2. Готовность
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

    // 3. Старт
    socket.on('startGame', () => {
        const room = getRoomBySocketId(socket.id);
        if (!room) return;
        const p = room.players.find(p => p.id === socket.id);
        if (p && p.isCreator && room.players.length >= 2 && room.players.every(pl => pl.ready)) {
            startNewRound(room, true);
        }
    });

    // 4. Ставка
    socket.on('makeBid', ({ quantity, faceValue }) => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'PLAYING') return;
        if (room.players[room.currentTurn].id !== socket.id) return;

        quantity = parseInt(quantity);
        faceValue = parseInt(faceValue);

        // Валидация
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

    // 5. Не верю
    socket.on('callBluff', () => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'PLAYING' || !room.currentBid) return;
        if (room.players[room.currentTurn].id !== socket.id) return;

        // Останавливаем таймер
        if (room.timerId) clearTimeout(room.timerId);

        const challenger = room.players[room.currentTurn];
        const bidder = room.players.find(p => p.id === room.currentBid.playerId);

        io.to(room.id).emit('gameEvent', { text: `🔥 ${challenger.name} ВСКРЫВАЕТ ${bidder.name}!`, type: 'alert' });

        // Считаем кости
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

        io.to(room.id).emit('roundResult', { message: msg, winner: loser === bidder ? challenger.name : bidder.name });
        
        loser.diceCount--;
        
        // Пауза перед новым раундом
        setTimeout(() => {
            checkEliminationAndContinue(room, loser);
        }, 5000);
    });

    // Рестарт
    socket.on('requestRestart', () => {
        const room = getRoomBySocketId(socket.id);
        if (room && room.status === 'FINISHED') {
            room.status = 'LOBBY';
            room.players.forEach(p => {
                p.diceCount = 5;
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
        // Начинаем следующий раунд. Ходит проигравший (если жив) или следующий за ним
        let nextIdx = room.players.indexOf(loser);
        if (loser.diceCount === 0) {
            // Если выбыл, ищем следующего живого
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
            // Если ушел тот, чей ход - передаем ход
            if (room.status === 'PLAYING' && idx === room.currentTurn) {
               nextTurn(room); // Переключит на следующего
            }
            broadcastRoomUpdate(room);
        }
    }
}

function broadcastRoomUpdate(room) {
    io.to(room.id).emit('roomUpdate', {
        roomId: room.id,
        players: room.players.map(p => ({ name: p.name, ready: p.ready, isCreator: p.isCreator, diceCount: p.diceCount })),
        status: room.status
    });
}

function startNewRound(room, isFirst = false, startIdx = null) {
    room.status = 'PLAYING';
    room.currentBid = null;
    
    room.players.forEach(p => {
        p.dice = p.diceCount > 0 ? rollDice(p.diceCount) : [];
    });

    if (startIdx !== null) room.currentTurn = startIdx;
    else if (isFirst) room.currentTurn = 0;
    else nextTurn(room);

    // Пропуск мертвых
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
    // Находим следующего живого
    let loops = 0;
    do {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
        loops++;
        if (loops > 20) return; // Защита от зависания
    } while (room.players[room.currentTurn].diceCount === 0);

    resetTurnTimer(room); // СБРОС ТАЙМЕРА
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
        turnDeadline: room.turnDeadline // Отправляем дедлайн клиенту
    });
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
