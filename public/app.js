// Глобальный перехватчик ошибок
window.onerror = function(message, source, lineno, colno, error) {
    // alert("Error: " + message); 
};

const socket = io();
const tg = window.Telegram?.WebApp;

let state = {
    username: null, roomId: null,
    bidQty: 1, bidVal: 2, timerFrame: null,
    createDice: 5, createPlayers: 10, createTime: 30,
    rules: { jokers: false, spot: false, strict: false },
    pve: { difficulty: 'easy', bots: 3, dice: 5, jokers: false, spot: false, strict: false },
    coins: 0, inventory: [], equipped: {},
    myDice: [], // Храним свои кубики
    currentBid: null // Текущая ставка
};

if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor('#5D4037'); tg.setBackgroundColor('#5D4037'); }

const screens = ['loading', 'login', 'home', 'create-settings', 'pve-settings', 'lobby', 'game', 'result', 'shop'];

function showScreen(name) {
    screens.forEach(s => {
        const el = document.getElementById(`screen-${s}`);
        if(el) el.classList.remove('active');
    });
    const target = document.getElementById(`screen-${name}`);
    if(target) target.classList.add('active');
    else console.error(`Screen not found: ${name}`);
}

function getDiceFace(val) {
    // 1: ⚀, 2: ⚁, 3: ⚂, 4: ⚃, 5: ⚄, 6: ⚅
    const faces = ['?', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    return faces[val] || '?';
}

function updateInputs() { 
    document.getElementById('display-qty').textContent = state.bidQty; 
    document.getElementById('display-val').textContent = getDiceFace(state.bidVal); 
}

// --- CONNECTION & AUTH ---
socket.on('connect', () => {
    if (tg && tg.initDataUnsafe.user) {
        state.username = tg.initDataUnsafe.user.first_name || 'Игрок';
        socket.emit('login', { 
            username: state.username, 
            userId: tg.initDataUnsafe.user.id, 
            coins: state.coins, 
            inventory: state.inventory,
            equipped: state.equipped
        });
    } else {
        showScreen('login');
    }
});

socket.on('loginSuccess', (data) => {
    state.username = data.name;
    state.coins = data.coins;
    state.inventory = data.inventory;
    state.equipped = data.equipped;
    
    document.getElementById('player-name-home').textContent = data.name;
    document.getElementById('player-rank-home').textContent = data.rank;
    document.getElementById('player-coins').textContent = data.coins;

    // Временное отображение экипировки (первый символ)
    const equippedEl = document.getElementById('player-equipped');
    if (equippedEl && data.equipped.avatar) {
        equippedEl.textContent = data.equipped.avatar.charAt(0);
    } else if (equippedEl) {
        equippedEl.textContent = '👤';
    }
    
    showScreen('home');
});

// --- NAVIGATION ---
document.getElementById('btn-login-play').addEventListener('click', () => {
    state.username = document.getElementById('username-input').value || 'Игрок';
    socket.emit('login', { username: state.username, userId: Date.now() }); // Для тестового входа
});

document.getElementById('btn-start-game').addEventListener('click', () => showScreen('create-settings'));
document.getElementById('btn-start-pve').addEventListener('click', () => showScreen('pve-settings'));
document.getElementById('btn-home').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-restart').addEventListener('click', () => showScreen('home'));
document.getElementById('btn-shop').addEventListener('click', () => showScreen('shop'));
document.getElementById('btn-shop-back').addEventListener('click', () => showScreen('home'));


// --- ROOM AND LOBBY ---
document.getElementById('btn-create-room').addEventListener('click', () => {
    const settings = {
        dice: state.createDice,
        time: state.createTime,
        rules: state.rules
    };
    socket.emit('createRoom', { settings });
});

document.getElementById('btn-create-pve').addEventListener('click', () => {
    const settings = {
        pve: state.pve
    };
    socket.emit('createRoom', { settings });
});

document.getElementById('btn-lobby-start').addEventListener('click', () => {
    socket.emit('startGame');
});

// Обновление настроек создания комнаты
document.querySelectorAll('#create-settings input[type="range"]').forEach(input => {
    input.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        const displayId = e.target.getAttribute('data-display');
        document.getElementById(displayId).textContent = value;
        state[e.target.id.replace('slider-', '')] = value;
    });
});
// Обновление правил (toggle switches)
document.querySelectorAll('#create-settings input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', (e) => {
        state.rules[e.target.id.replace('toggle-', '')] = e.target.checked;
    });
});
document.querySelectorAll('#pve-settings input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', (e) => {
        state.pve[e.target.id.replace('pve-toggle-', '')] = e.target.checked;
    });
});

socket.on('joinedRoom', (data) => {
    state.roomId = data.roomId;
    state.rules = data.settings;
    document.getElementById('room-id-display').textContent = data.roomId;
    
    // Скрытие/показ кнопки "В ТОЧКУ"
    const spotBtn = document.getElementById('btn-call-spot');
    if (spotBtn) {
        if (state.rules.spot) {
            spotBtn.classList.remove('hidden-rule');
        } else {
            spotBtn.classList.add('hidden-rule');
        }
    }
    
    showScreen('lobby');
});

socket.on('roomUpdate', (data) => {
    const lobbyPlayers = document.getElementById('lobby-players');
    if (!lobbyPlayers) return;
    
    lobbyPlayers.innerHTML = data.players.map(p => `
        <div class="lobby-player-card">
            <span class="lobby-player-name">${p.name} ${p.isBot ? '🤖' : '👤'}</span>
            <span class="lobby-player-rank">${p.rank}</span>
            <span class="equipped-icon">${p.equipped.avatar ? p.equipped.avatar.charAt(0) : '👤'}</span>
        </div>
    `).join('');
    
    // Кнопка Старт доступна, только если вы хост и игроков >= 2 или это PvE с ботами
    const isHost = data.players[0].id === socket.id;
    const isPve = data.settings.bots > 0;
    const btnStart = document.getElementById('btn-lobby-start');
    if (btnStart) {
        btnStart.style.display = isHost ? 'block' : 'none';
        btnStart.disabled = (!isPve && data.players.length < 2);
    }
});

// --- GAME ACTIONS ---
document.getElementById('btn-qty-minus').addEventListener('click', () => { state.bidQty = Math.max(1, state.bidQty - 1); updateInputs(); if(tg) tg.HapticFeedback.impactOccurred('light'); });
document.getElementById('btn-qty-plus').addEventListener('click', () => { state.bidQty++; updateInputs(); if(tg) tg.HapticFeedback.impactOccurred('light'); });
document.getElementById('btn-val-minus').addEventListener('click', () => { 
    state.bidVal = Math.max(2, state.bidVal - 1); 
    if (state.bidVal < 2) { state.bidVal = 6; state.bidQty = Math.max(1, state.bidQty - 1); } // Переход вниз
    updateInputs(); 
    if(tg) tg.HapticFeedback.impactOccurred('light'); 
});
document.getElementById('btn-val-plus').addEventListener('click', () => { 
    state.bidVal = Math.min(6, state.bidVal + 1); 
    if (state.bidVal > 6) { state.bidVal = 2; state.bidQty++; } // Переход вверх
    updateInputs(); 
    if(tg) tg.HapticFeedback.impactOccurred('light'); 
});

document.getElementById('btn-make-bid').addEventListener('click', () => {
    socket.emit('makeBid', { qty: state.bidQty, val: state.bidVal });
});
document.getElementById('btn-call-bluff').addEventListener('click', () => {
    socket.emit('callBluff');
});
document.getElementById('btn-call-spot').addEventListener('click', () => {
    socket.emit('callSpot');
});

socket.on('yourDice', (dice) => {
    state.myDice = dice;
    // Обновление ваших кубиков будет происходить в gameState
});

socket.on('gameEvent', (data) => {
    const eventLog = document.getElementById('game-event-log');
    if (!eventLog) return;
    
    const item = document.createElement('div');
    item.className = `log-item log-${data.type}`;
    item.textContent = data.text;
    eventLog.appendChild(item);
    eventLog.scrollTop = eventLog.scrollHeight;
    
    if (tg && data.type === 'error') tg.HapticFeedback.notificationOccurred('error');
    if (tg && data.type === 'alert') tg.HapticFeedback.notificationOccurred('warning');
});

socket.on('gameState', (gs) => {
    showScreen('game');
    state.currentBid = gs.currentBid;
    
    // --- ИЗМЕНЕНИЕ: ОБНОВЛЕНИЕ СПИСКА ИГРОКОВ (включая смайлики и кубики) ---
    const playerList = document.getElementById('player-list');
    if (!playerList) return;
    playerList.innerHTML = gs.players.map(p => `
        <div class="player-card ${p.isTurn ? 'is-turn' : ''} ${p.isEliminated ? 'eliminated' : ''}" data-player-id="${p.id}">
            <div class="player-info">
                <span class="equipped-icon">${p.equipped.avatar ? p.equipped.avatar.charAt(0) : '👤'}</span>
                <span class="player-name">${p.name} ${p.isEliminated ? '❌' : p.isTurn ? '➡️' : ''}</span>
                <span class="player-rank">${p.rank}</span>
            </div>
            <div class="player-dice">
                ${p.isEliminated ? '—' : (p.diceCount > 0 ? (p.isTurn ? `(${p.diceCount} 🎲)` : `(${p.diceCount} 🎲)`) : '—')}
            </div>
        </div>
    `).join('');
    
    // Обновление текущей ставки
    const bidDisplay = document.getElementById('current-bid');
    if (bidDisplay) {
        if (gs.currentBid) {
            bidDisplay.textContent = `${gs.currentBid.qty} x ${getDiceFace(gs.currentBid.val)}`;
            bidDisplay.classList.add('active');
            
            // Сброс и установка текущей ставки для нового хода
            state.bidQty = gs.currentBid.qty;
            state.bidVal = gs.currentBid.val;
            
            // Автоматическое повышение минимальной ставки на +1
            state.bidVal++;
            if (state.bidVal > 6) {
                state.bidVal = 2;
                state.bidQty++;
            }
            // Гарантируем, что новая ставка выше
            if (state.bidQty * 10 + state.bidVal <= gs.currentBid.qty * 10 + gs.currentBid.val) {
                state.bidQty = gs.currentBid.qty + 1;
                state.bidVal = gs.currentBid.val;
            }

            updateInputs();

        } else {
            bidDisplay.textContent = 'Нет ставок';
            bidDisplay.classList.remove('active');
            
            // Сброс до минимальной ставки 1x2
            state.bidQty = 1;
            state.bidVal = 2;
            updateInputs();
        }
    }
    
    // --- ИЗМЕНЕНИЕ: Обновление Ваших кубиков ---
    const yourDiceContainer = document.getElementById('your-dice');
    if (yourDiceContainer) {
        const myPlayer = gs.players.find(p => p.id === socket.id);
        if (myPlayer && myPlayer.diceCount > 0 && state.myDice) {
            yourDiceContainer.innerHTML = state.myDice.map(d => `<span class="dice-face">${getDiceFace(d)}</span>`).join('');
        } else if (myPlayer && myPlayer.diceCount === 0) {
            // Если игрок выбыл, очищаем контейнер
            yourDiceContainer.innerHTML = 'Вы выбыли';
        } else {
            yourDiceContainer.innerHTML = '';
        }
    }

    // --- ИЗМЕНЕНИЕ: Управление кнопками и controls ---
    const controls = document.getElementById('game-controls');
    const isMyTurn = gs.players[gs.currentTurn]?.id === socket.id;

    if (isMyTurn) {
        controls.classList.remove('hidden');
        
        const bidBtn = document.getElementById('btn-make-bid');
        const bluffBtn = document.getElementById('btn-call-bluff');
        const spotBtn = document.getElementById('btn-call-spot');

        if(bidBtn) bidBtn.disabled = false; // Можно всегда делать ставку
        if(bluffBtn) bluffBtn.disabled = !gs.currentBid; 
        if(spotBtn) spotBtn.disabled = !gs.currentBid;
        if(tg) tg.HapticFeedback.impactOccurred('medium'); 
    } else {
        controls.classList.add('hidden');
    }
    
    if (gs.remainingTime !== undefined && gs.totalDuration) {
        startVisualTimer(gs.remainingTime, gs.totalDuration);
    }
});

socket.on('roundResult', (data) => {
    // Показываем кубики для всех
    const allDiceDisplay = document.getElementById('all-dice-display');
    if (allDiceDisplay && data.allDice) {
        allDiceDisplay.innerHTML = data.allDice.map(d => `<span class="dice-face">${getDiceFace(d)}</span>`).join('');
        allDiceDisplay.classList.add('active');
        setTimeout(() => allDiceDisplay.classList.remove('active'), 5000);
    }
    tg ? tg.showAlert(data.message) : alert(data.message);
});

socket.on('gameOver', (data) => {
    showScreen('result'); document.getElementById('winner-name').textContent = data.winner;
    if(tg) tg.HapticFeedback.notificationOccurred('success');
});

function startVisualTimer(remaining, total) {
    if (state.timerFrame) cancelAnimationFrame(state.timerFrame);
    const bar = document.querySelector('.timer-progress'); if (!bar) return;
    
    const endTime = Date.now() + remaining; 

    function tick() {
        const now = Date.now(); 
        const left = endTime - now;
        
        if (left <= 0) { bar.style.width = '0%'; state.timerFrame = null; return; }
        
        const pct = (left / total) * 100;
        bar.style.width = `${pct}%`;
        
        state.timerFrame = requestAnimationFrame(tick);
    }
    
    state.timerFrame = requestAnimationFrame(tick);
}
