const socket = io();

let currentState = {
    username: null,
    roomId: null,
    isReady: false,
    myDice: [],
    isCreator: false
};

const screens = {
    login: document.getElementById('screen-login'),
    home: document.getElementById('screen-home'),
    lobby: document.getElementById('screen-lobby'),
    game: document.getElementById('screen-game'),
    result: document.getElementById('screen-result')
};

// Инициализация Telegram WebApp
const tg = window.Telegram?.WebApp;

window.addEventListener('load', () => {
    if (tg) {
        tg.ready();
        tg.expand();
    }
    // Если открыто в телеграме - берем имя оттуда
    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
        const user = tg.initDataUnsafe.user;
        currentState.username = user.username || user.first_name;
        showScreen('home');
        document.getElementById('user-display').textContent = `Привет, ${currentState.username}!`;
    } else {
        showScreen('login');
    }
});

function showScreen(name) {
    Object.values(screens).forEach(el => el.classList.remove('active'));
    screens[name].classList.add('active');
}

// --- Обработчики кнопок ---

document.getElementById('btn-login').addEventListener('click', () => {
    const name = document.getElementById('input-username').value.trim();
    if (name) {
        currentState.username = name;
        showScreen('home');
        document.getElementById('user-display').textContent = `Привет, ${name}!`;
    } else alert('Введите имя!');
});

document.getElementById('btn-create-room').addEventListener('click', () => {
    socket.emit('joinOrCreateRoom', { roomId: null, username: currentState.username });
});

document.getElementById('btn-join-room').addEventListener('click', () => {
    const roomId = prompt("Введите код комнаты:");
    if (roomId) {
        socket.emit('joinOrCreateRoom', { roomId: roomId.toUpperCase(), username: currentState.username });
    }
});

document.getElementById('btn-ready').addEventListener('click', () => {
    currentState.isReady = !currentState.isReady;
    socket.emit('setReady', currentState.isReady);
    const btn = document.getElementById('btn-ready');
    btn.textContent = currentState.isReady ? "Я не готов" : "Я готов";
    btn.classList.toggle('secondary');
});

document.getElementById('btn-start-game').addEventListener('click', () => {
    socket.emit('startGame');
});

document.getElementById('btn-make-bid').addEventListener('click', () => {
    const qty = document.getElementById('input-bid-qty').value;
    const val = document.getElementById('input-bid-val').value;
    socket.emit('makeBid', { quantity: qty, faceValue: val });
});

document.getElementById('btn-call-bluff').addEventListener('click', () => {
    socket.emit('callBluff');
});

document.getElementById('btn-restart').addEventListener('click', () => {
    socket.emit('requestRestart');
});

document.getElementById('btn-home').addEventListener('click', () => location.reload());

// --- Socket Events ---

socket.on('errorMsg', (msg) => tg ? tg.showAlert(msg) : alert(msg));

socket.on('roomUpdate', (room) => {
    currentState.roomId = room.roomId;
    currentState.isCreator = room.players.find(p => p.id === socket.id)?.isCreator || false;

    if (room.status === 'LOBBY') {
        showScreen('lobby');
        document.getElementById('lobby-room-id').textContent = room.roomId;
        
        const list = document.getElementById('lobby-players');
        list.innerHTML = '';
        room.players.forEach(p => {
            const div = document.createElement('div');
            div.className = 'player-item';
            div.innerHTML = `<span>${p.name}</span><span class="status ${p.ready ? 'ready' : ''}">${p.ready ? 'Готов' : 'Ожидает'}</span>`;
            list.appendChild(div);
        });

        const startBtn = document.getElementById('btn-start-game');
        startBtn.style.display = (currentState.isCreator && room.players.length >= 2) ? 'block' : 'none';
    }
});

socket.on('gameEvent', (data) => {
    const log = document.getElementById('game-log');
    const div = document.createElement('div');
    div.textContent = data.text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
});

socket.on('yourDice', (dice) => {
    currentState.myDice = dice;
    const container = document.getElementById('my-dice');
    container.innerHTML = '';
    dice.forEach(val => {
        const d = document.createElement('div');
        d.className = 'die';
        d.textContent = val;
        container.appendChild(d);
    });
});

socket.on('gameState', (state) => {
    showScreen('game');
    
    const bar = document.getElementById('players-bar');
    bar.innerHTML = '';
    state.players.forEach(p => {
        const div = document.createElement('div');
        div.className = `player-chip ${p.isTurn ? 'turn' : ''} ${p.isEliminated ? 'dead' : ''}`;
        div.textContent = `${p.name} (${p.diceCount})`;
        bar.appendChild(div);
    });

    const bidDiv = document.getElementById('current-bid-display');
    if (state.currentBid) {
        bidDiv.innerHTML = `Ставка: <strong>${state.currentBid.quantity}</strong> шт. номиналом <strong>${state.currentBid.faceValue}</strong>`;
    } else {
        bidDiv.innerHTML = "Сделайте первую ставку!";
    }

    // Если сейчас мой ход
    const isMyTurn = state.players.find(p => p.isTurn)?.name === currentState.username;
    const controls = document.getElementById('game-controls');
    
    if (isMyTurn) {
        controls.style.display = 'block';
        if (state.currentBid) {
            document.getElementById('input-bid-qty').value = state.currentBid.quantity;
            document.getElementById('input-bid-val').value = state.currentBid.faceValue;
            document.getElementById('btn-call-bluff').disabled = false;
        } else {
             document.getElementById('btn-call-bluff').disabled = true;
        }
    } else {
        controls.style.display = 'none';
    }
});

socket.on('revealDice', (allDice) => {
    // Для простоты показываем алерт или лог
    // В полной версии можно красиво отрисовать на столе
});

socket.on('roundResult', (data) => {
    tg ? tg.showAlert(data.message) : alert(data.message);
});

socket.on('gameOver', (data) => {
    showScreen('result');
    document.getElementById('winner-name').textContent = data.winner;
});