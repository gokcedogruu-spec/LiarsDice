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
const webAppUrl = process.env.WEBAPP_URL;

// --- Telegram Bot Setup ---
const bot = token ? new TelegramBot(token, { polling: true }) : null;

if (bot) {
    // Слушаем ВСЕ сообщения (bot.on вместо bot.onText)
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text || '';
        
        console.log(`[MSG] From: ${chatId}, Text: ${text}`); // Лог для проверки

        // Проверка: сообщение начинается с /start
        // Сработает на: "/start", "/start@BotName", "/start 123"
if (bot) {
    // Слушаем ВСЕ сообщения
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = (msg.text || '').trim();
        
        console.log(`[MSG] From: ${chatId}, Text: ${text}`);

        // Проверяем, содержит ли текст /start
        if (text.toLowerCase().includes('/start')) {
            
            // --- ВАЖНО: ВПИШИ СЮДА СВОЮ ССЫЛКУ С RENDER (ОБЯЗАТЕЛЬНО HTTPS) ---
            const MY_URL = 'https://liarsdicezmss.onrender.com/'; 
            // -------------------------------------------------------------------

            const introText = `☠️ Добро пожаловать в «Кости Лжеца»! ☠️\n\nЖми кнопку ниже!`;
            
            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🎲 Играть в кости", web_app: { url: MY_URL } }]
                    ]
                }
            };
            
            bot.sendMessage(chatId, introText, opts)
                .then(() => console.log(`[SUCCESS] Ответ отправлен в чат ${chatId}`))
                .catch((err) => console.error(`[ERROR] Ошибка отправки:`, err.message));
        }
    });
    console.log('Bot started (Hardcoded URL Mode)...');
} else {
    console.log('Bot token not provided.');
}

// --- Express Setup ---
// Раздаем файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// --- Game State ---
const rooms = new Map(); 

// Генерация ID комнаты
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Бросок костей (случайные числа 1-6)
function rollDice(count) {
    const dice = [];
    for (let i = 0; i < count; i++) {
        dice.push(Math.floor(Math.random() * 6) + 1);
    }
    return dice.sort((a, b) => a - b);
}

// Поиск комнаты по socket.id игрока
function getRoomBySocketId(socketId) {
    for (const [roomId, room] of rooms) {
        if (room.players.find(p => p.id === socketId)) {
            return room;
        }
    }
    return null;
}

// --- Socket.IO Logic ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Присоединение или создание комнаты
    socket.on('joinOrCreateRoom', ({ roomId, username }) => {
        // Если игрок уже где-то был - удаляем
        const oldRoom = getRoomBySocketId(socket.id);
        if (oldRoom) leaveRoom(socket, oldRoom);

        let room;
        let isCreator = false;

        if (roomId) {
            // Вход в существующую
            room = rooms.get(roomId);
            if (!room) {
                socket.emit('errorMsg', 'Комната не найдена');
                return;
            }
            if (room.status !== 'LOBBY') {
                socket.emit('errorMsg', 'Игра уже идет');
                return;
            }
            if (room.players.length >= 10) {
                socket.emit('errorMsg', 'Комната переполнена');
                return;
            }
        } else {
            // Создание новой
            const newId = generateRoomId();
            room = {
                id: newId,
                players: [],
                status: 'LOBBY',
                currentTurn: 0,
                currentBid: null,
                history: []
            };
            rooms.set(newId, room);
            roomId = newId;
            isCreator = true;
        }

        // Добавляем игрока
        const player = {
            id: socket.id,
            name: username || `Пират ${room.players.length + 1}`,
            dice: [],
            diceCount: 5,
            ready: false,
            isCreator: isCreator
        };
        room.players.push(player);
        socket.join(roomId);

        // Обновляем всех в комнате
        io.to(roomId).emit('roomUpdate', {
            roomId: room.id,
            players: room.players.map(p => ({ name: p.name, ready: p.ready, isCreator: p.isCreator, diceCount: p.diceCount, id: p.id })),
            status: room.status
        });
    });

    // 2. Статус "Готов"
    socket.on('setReady', (isReady) => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'LOBBY') return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.ready = isReady;
            io.to(room.id).emit('roomUpdate', {
                roomId: room.id,
                players: room.players.map(p => ({ name: p.name, ready: p.ready, isCreator: p.isCreator, diceCount: p.diceCount, id: p.id })),
                status: room.status
            });
        }
    });

    // 3. Старт игры (только создатель)
    socket.on('startGame', () => {
        const room = getRoomBySocketId(socket.id);
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isCreator) return;

        if (room.players.length < 2) {
            socket.emit('errorMsg', 'Нужно минимум 2 игрока!');
            return;
        }
        if (room.players.some(p => !p.ready)) {
            socket.emit('errorMsg', 'Все игроки должны быть готовы!');
            return;
        }

        startNewRound(room, true);
    });

    // 4. Сделать ставку
    socket.on('makeBid', ({ quantity, faceValue }) => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'PLAYING') return;

        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== room.currentTurn) return; // Не ваш ход

        quantity = parseInt(quantity);
        faceValue = parseInt(faceValue);

        // Проверка правил повышения ставки
        let isValid = false;
        if (!room.currentBid) {
            // Первая ставка
            isValid = quantity > 0 && faceValue >= 1 && faceValue <= 6;
        } else {
            // Повышение
            if (quantity > room.currentBid.quantity) isValid = true;
            else if (quantity === room.currentBid.quantity && faceValue > room.currentBid.faceValue) isValid = true;
        }

        if (!isValid) {
            socket.emit('errorMsg', 'Некорректная ставка! Нужно повысить количество или номинал.');
            return;
        }

        room.currentBid = { quantity, faceValue, playerId: socket.id };
        const playerName = room.players[playerIndex].name;
        
        room.history.push(`${playerName} ставит: ${quantity} куб. на ${faceValue}`);
        io.to(room.id).emit('gameEvent', { text: `${playerName} сделал ставку: ${quantity}x[${faceValue}]` });

        nextTurn(room);
        broadcastGameState(room);
    });

    // 5. "Не верю" (Call Bluff)
    socket.on('callBluff', () => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'PLAYING' || !room.currentBid) return;

        const challengerIndex = room.players.findIndex(p => p.id === socket.id);
        if (challengerIndex !== room.currentTurn) return;

        const challenger = room.players[challengerIndex];
        const bidderId = room.currentBid.playerId;
        const bidder = room.players.find(p => p.id === bidderId);

        io.to(room.id).emit('gameEvent', { text: `${challenger.name} кричит «НЕ ВЕРЮ!» игроку ${bidder.name}` });

        // Подсчет реальных кубиков
        let totalCount = 0;
        const allDice = {};
        
        room.players.forEach(p => {
            if (p.diceCount > 0) {
                p.dice.forEach(d => {
                    if (d === room.currentBid.faceValue) totalCount++;
                });
                allDice[p.name] = p.dice;
            }
        });

        // Вскрываем карты всем
        io.to(room.id).emit('revealDice', allDice);

        let loser;
        let message = `На столе ${totalCount} кубиков с числом ${room.currentBid.faceValue}. Ставка была ${room.currentBid.quantity}. `;

        if (totalCount < room.currentBid.quantity) {
            // Тот, кто ставил - соврал
            message += `Блеф раскрыт! ${bidder.name} теряет кубик.`;
            loser = bidder;
        } else {
            // Тот, кто не верил - ошибся
            message += `Ставка сыграла! ${challenger.name} ошибся и теряет кубик.`;
            loser = challenger;
        }

        io.to(room.id).emit('roundResult', { message });

        // Отнимаем кубик
        loser.diceCount--;
        
        // Пауза перед следующим действием
        setTimeout(() => {
            if (loser.diceCount === 0) {
                io.to(room.id).emit('gameEvent', { text: `☠️ ${loser.name} выбывает из игры!` });
            }

            // Проверка на победителя
            const activePlayers = room.players.filter(p => p.diceCount > 0);
            if (activePlayers.length === 1) {
                const winner = activePlayers[0];
                room.status = 'FINISHED';
                io.to(room.id).emit('gameOver', { winner: winner.name });
            } else {
                // Следующий раунд. Ходит тот, кто проиграл (если жив), иначе следующий.
                startNewRound(room, false, loser.diceCount > 0 ? room.players.indexOf(loser) : null);
            }
        }, 4000);
    });

    // Рестарт в той же комнате
    socket.on('requestRestart', () => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'FINISHED') return;
        
        room.status = 'LOBBY';
        room.players.forEach(p => {
            p.diceCount = 5;
            p.ready = false;
            p.dice = [];
        });
        room.currentBid = null;
        room.history = [];
        
        io.to(room.id).emit('roomUpdate', {
            roomId: room.id,
            players: room.players.map(p => ({ name: p.name, ready: p.ready, isCreator: p.isCreator, diceCount: p.diceCount, id: p.id })),
            status: room.status
        });
    });

    socket.on('disconnect', () => {
        const room = getRoomBySocketId(socket.id);
        if (room) leaveRoom(socket, room);
    });
});

function leaveRoom(socket, room) {
    const index = room.players.findIndex(p => p.id === socket.id);
    if (index !== -1) {
        const wasCreator = room.players[index].isCreator;
        room.players.splice(index, 1);
        
        if (room.players.length === 0) {
            rooms.delete(room.id);
        } else {
            if (wasCreator) room.players[0].isCreator = true;
            io.to(room.id).emit('roomUpdate', {
                roomId: room.id,
                players: room.players.map(p => ({ name: p.name, ready: p.ready, isCreator: p.isCreator, diceCount: p.diceCount, id: p.id })),
                status: room.status
            });
        }
    }
}

function startNewRound(room, isFirstRound = false, startingPlayerIndex = null) {
    room.status = 'PLAYING';
    room.currentBid = null;
    
    // Бросаем кости только живым
    room.players.forEach(p => {
        if (p.diceCount > 0) {
            p.dice = rollDice(p.diceCount);
        } else {
            p.dice = [];
        }
    });

    if (startingPlayerIndex !== null) {
        room.currentTurn = startingPlayerIndex;
    } else if (isFirstRound) {
        room.currentTurn = 0;
    } else {
        nextTurn(room);
    }

    // Пропуск выбывших
    while (room.players[room.currentTurn].diceCount === 0) {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
    }

    // Отправляем каждому его кости ЛИЧНО
    room.players.forEach(p => {
        if (p.diceCount > 0) {
            io.to(p.id).emit('yourDice', p.dice);
        }
    });

    io.to(room.id).emit('gameEvent', { text: `--- НОВЫЙ РАУНД ---` });
    broadcastGameState(room);
}

function nextTurn(room) {
    do {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
    } while (room.players[room.currentTurn].diceCount === 0);
}

function broadcastGameState(room) {
    const publicPlayers = room.players.map((p, index) => ({
        name: p.name,
        diceCount: p.diceCount,
        isTurn: index === room.currentTurn,
        isEliminated: p.diceCount === 0
    }));

    io.to(room.id).emit('gameState', {
        players: publicPlayers,
        currentBid: room.currentBid,
        history: room.history
    });
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

});
