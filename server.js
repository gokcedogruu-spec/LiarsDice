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
// Мы не используем webAppUrl из env, чтобы избежать ошибки, впишем его ниже вручную

// --- Telegram Bot Setup ---
const bot = token ? new TelegramBot(token, { polling: true }) : null;

if (bot) {
    console.log('Bot is running...');

    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = (msg.text || '').trim();

        // --- ВАЖНО: ВПИШИ СЮДА СВОЮ ССЫЛКУ С RENDER ---
        // Например: const MY_URL = 'https://game-name.onrender.com';
        const MY_URL = 'https://google.com'; 
        // ----------------------------------------------

        console.log(`[MSG] From: ${chatId}, Text: "${text}"`);

        // Реагируем на /start в любом виде (в личке или группе)
        if (text.toLowerCase().includes('/start')) {
            const introText = `☠️ Добро пожаловать в «Кости Лжеца»! ☠️\n\nСоберите друзей и узнайте, кто из вас лучший блефующий пират.\n\nЖми кнопку ниже!`;
            
            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🎲 Играть в кости", web_app: { url: MY_URL } }]
                    ]
                }
            };
            
            bot.sendMessage(chatId, introText, opts)
                .then(() => console.log(`[SUCCESS] Ответ отправлен в ${chatId}`))
                .catch((err) => console.error(`[ERROR] Ошибка отправки:`, err.message));
        }
    });
} else {
    console.log('Bot token not provided, running without bot features.');
}

// --- Express Setup ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Game State & Logic ---
const rooms = new Map(); 

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function rollDice(count) {
    const dice = [];
    for (let i = 0; i < count; i++) {
        dice.push(Math.floor(Math.random() * 6) + 1);
    }
    return dice.sort((a, b) => a - b);
}

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

    // 1. Join or Create Room
    socket.on('joinOrCreateRoom', ({ roomId, username }) => {
        const oldRoom = getRoomBySocketId(socket.id);
        if (oldRoom) leaveRoom(socket, oldRoom);

        let room;
        let isCreator = false;

        if (roomId) {
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

        io.to(roomId).emit('roomUpdate', {
            roomId: room.id,
            players: room.players.map(p => ({ name: p.name, ready: p.ready, isCreator: p.isCreator, diceCount: p.diceCount, id: p.id })),
            status: room.status
        });
    });

    // 2. Toggle Ready
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

    // 3. Start Game
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

    // 4. Make Bid
    socket.on('makeBid', ({ quantity, faceValue }) => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'PLAYING') return;

        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== room.currentTurn) return;

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

    // 5. Call Bluff
    socket.on('callBluff', () => {
        const room = getRoomBySocketId(socket.id);
        if (!room || room.status !== 'PLAYING' || !room.currentBid) return;

        const challengerIndex = room.players.findIndex(p => p.id === socket.id);
        if (challengerIndex !== room.currentTurn) return;

        const challenger = room.players[challengerIndex];
        const bidderId = room.currentBid.playerId;
        const bidder = room.players.find(p => p.id === bidderId);

        io.to(room.id).emit('gameEvent', { text: `${challenger.name} кричит «НЕ ВЕРЮ!» игроку ${bidder.name}` });

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

        io.to(room.id).emit('revealDice', allDice);

        let loser;
        let message = `На столе ${totalCount} кубиков с числом ${room.currentBid.faceValue}. Ставка была ${room.currentBid.quantity}. `;

        if (totalCount < room.currentBid.quantity) {
            message += `Блеф раскрыт! ${bidder.name} теряет кубик.`;
            loser = bidder;
        } else {
            message += `Ставка сыграла! ${challenger.name} ошибся и теряет кубик.`;
            loser = challenger;
        }

        io.to(room.id).emit('roundResult', { message });

        loser.diceCount--;
        
        setTimeout(() => {
            if (loser.diceCount === 0) {
                io.to(room.id).emit('gameEvent', { text: `☠️ ${loser.name} выбывает из игры!` });
            }

            const activePlayers = room.players.filter(p => p.diceCount > 0);
            if (activePlayers.length === 1) {
                const winner = activePlayers[0];
                room.status = 'FINISHED';
                io.to(room.id).emit('gameOver', { winner: winner.name });
            } else {
                startNewRound(room, false, loser.diceCount > 0 ? room.players.indexOf(loser) : null);
            }
        }, 5000);
    });

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
            if (wasCreator) {
                room.players[0].isCreator = true;
            }
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

    while (room.players[room.currentTurn].diceCount === 0) {
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
    }

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
        history: room.history,
        round: 1
    });
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

