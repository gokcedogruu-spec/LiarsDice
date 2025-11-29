const socket = io();
const tg = window.Telegram?.WebApp;

let state = {
    username: null,
    roomId: null,
    bidQty: 1, bidVal: 2, timerInterval: null, createDice: 5, createPlayers: 10
};

if (tg) {
    tg.ready(); tg.expand(); tg.setHeaderColor('#2D3250'); tg.setBackgroundColor('#2D3250');
}

const screens = ['login', 'home', 'create-settings', 'lobby', 'game', 'result'];
function showScreen(name) {
    screens.forEach(s => document.getElementById(`screen-${s}`).classList.remove('active'));
    document.getElementById(`screen-${name}`).classList.add('active');
}

window.addEventListener('load', () => {
    if (tg?.initDataUnsafe?.user) {
        state.username = tg.initDataUnsafe.user.first_name;
        loginSuccess();
    }
});

document.getElementById('btn-login').addEventListener('click', () => {
    const val = document.getElementById('input-username').value.trim();
    if (val) { state.username = val; loginSuccess(); }
});

function loginSuccess() {
    showScreen('home');
    document.getElementById('user-display').textContent = state.username;
    
    // ЗАГРУЗКА ИЗ CLOUD STORAGE
    if (tg && tg.CloudStorage) {
        tg.CloudStorage.getItem('liarsDiceHardcore', (err, val) => {
            let savedData = null;
            if (!err && val) {
                try { savedData = JSON.parse(val); } catch (e) {}
            }
            socket.emit('login', { username: state.username, savedData: savedData });
        });
    } else {
        socket.emit('login', { username: state.username, savedData: null });
    }
}

// ОБНОВЛЕНИЕ И СОХРАНЕНИЕ
socket.on('profileUpdate', (data) => {
    document.getElementById('rank-display').textContent = data.rankName;
    document.getElementById('win-streak').textContent = `Серия побед: ${data.streak} 🔥`;
    
    let rankIcon = '🦠';
    if (data.rankName === 'Юнга') rankIcon = '⚓';
    if (data.rankName === 'Матрос') rankIcon = '🌊';
    if (data.rankName === 'Старший матрос') rankIcon = '🎖️';
    if (data.rankName === 'Боцман') rankIcon = '💪';
    if (data.rankName === 'Первый помощник') rankIcon = '⚔️';
    if (data.rankName === 'Капитан') rankIcon = '☠️';
    document.getElementById('rank-badge').textContent = rankIcon;

    const next = data.nextRankXP === 'MAX' ? data.xp : data.nextRankXP;
    const percent = Math.min(100, (data.xp / next) * 100);
    document.getElementById('xp-fill').style.width = `${percent}%`;
    document.getElementById('xp-text').textContent = `${data.xp} / ${next} XP`;

    // СОХРАНЕНИЕ В ОБЛАКО
    if (tg && tg.CloudStorage) {
        const saveObj = { xp: data.xp, streak: data.streak };
        tg.CloudStorage.setItem('liarsDiceHardcore', JSON.stringify(saveObj), (err, stored) => {
            if (err) console.error('Save error:', err);
        });
    }
});

document.getElementById('btn-to-create').addEventListener('click', () => showScreen('create-settings'));
document.getElementById('btn-back-home').addEventListener('click', () => showScreen('home'));

window.adjSetting = (type, delta) => {
    if (type === 'dice') {
        state.createDice = Math.max(1, Math.min(10, state.createDice + delta));
        document.getElementById('set-dice').textContent = state.createDice;
    } else if (type === 'players') {
        state.createPlayers = Math.max(2, Math.min(10, state.createPlayers + delta));
        document.getElementById('set-players').textContent = state.createPlayers;
    }
};

document.getElementById('btn-confirm-create').addEventListener('click', () => {
    socket.emit('joinOrCreateRoom', { roomId: null, username: state.username, options: { dice: state.createDice, players: state.createPlayers } });
});
document.getElementById('btn-join-room').addEventListener('click', () => {
    const code = prompt("Код комнаты:");
    if(code) socket.emit('joinOrCreateRoom', { roomId: code.toUpperCase().trim(), username: state.username });
});
document.getElementById('share-btn').addEventListener('click', () => {
    const code = state.roomId;
    navigator.clipboard.writeText(code).then(() => tg ? tg.showAlert(`Код "${code}" скопирован!`) : alert(`Код "${code}" скопирован!`))
        .catch(()=>prompt("Код:", code));
});
document.getElementById('btn-ready').addEventListener('click', function() {
    const isReady = this.textContent === "Я ГОТОВ";
    socket.emit('setReady', isReady);
    this.textContent = isReady ? "НЕ ГОТОВ" : "Я ГОТОВ";
    this.className = isReady ? "btn btn-success" : "btn btn-secondary";
});
document.getElementById('btn-start-game').addEventListener('click', () => socket.emit('startGame'));

window.adjBid = (type, delta) => {
    if (type === 'qty') { state.bidQty = Math.max(1, state.bidQty + delta); document.getElementById('display-qty').textContent = state.bidQty; } 
    else { state.bidVal = Math.max(1, Math.min(6, state.bidVal + delta)); document.getElementById('display-val').textContent = state.bidVal; }
};
document.getElementById('btn-make-bid').addEventListener('click', () => socket.emit('makeBid', { quantity: state.bidQty, faceValue: state.bidVal }));
document.getElementById('btn-call-bluff').addEventListener('click', () => socket.emit('callBluff'));
document.getElementById('btn-restart').addEventListener('click', () => socket.emit('requestRestart'));
document.getElementById('btn-home').addEventListener('click', () => location.reload());

socket.on('errorMsg', (msg) => tg ? tg.showAlert(msg) : alert(msg));
socket.on('roomUpdate', (room) => {
    state.roomId = room.roomId;
    if (room.status === 'LOBBY') {
        showScreen('lobby');
        document.getElementById('lobby-room-id').textContent = room.roomId;
        if (room.config) document.getElementById('lobby-rules').textContent = `🎲: ${room.config.dice} | 👤: ${room.config.players}`;
        const list = document.getElementById('lobby-players');
        list.innerHTML = '';
        room.players.forEach(p => {
            list.innerHTML += `<div class="player-item">
                <div class="player-info"><b>${p.name}</b><span class="rank-sub">${p.rank}</span></div>
                <span>${p.ready?'✅':'⏳'}</span>
            </div>`;
        });
        const me = room.players.find(p => p.name === state.username);
        document.getElementById('btn-start-game').style.display = (me?.isCreator && room.players.length > 1) ? 'block' : 'none';
    }
});
socket.on('gameEvent', (evt) => {
    document.getElementById('game-log').innerHTML = `<div>${evt.text}</div>`;
    if(evt.type === 'alert' && tg) tg.HapticFeedback.notificationOccurred('warning');
});
socket.on('yourDice', (dice) => document.getElementById('my-dice').innerHTML = dice.map(d => `<div class="die">${d}</div>`).join(''));
socket.on('gameState', (gs) => {
    showScreen('game');
    const bar = document.getElementById('players-bar');
    bar.innerHTML = gs.players.map(p => `
        <div class="player-chip ${p.isTurn ? 'turn' : ''} ${p.isEliminated ? 'dead' : ''}">
            <b>${p.name}</b>
            <span class="rank-game">${p.rank}</span>
            🎲 ${p.diceCount}
        </div>
    `).join('');
    const bid = document.getElementById('current-bid-display');
    if (gs.currentBid) {
        bid.innerHTML = `<div>Ставка:</div><div style="font-size:1.5rem; font-weight:bold; margin-top:5px;">${gs.currentBid.quantity} x <span style="background:white; color:black; padding:2px 6px; border-radius:4px;">${gs.currentBid.faceValue}</span></div>`;
        state.bidQty = gs.currentBid.quantity; state.bidVal = gs.currentBid.faceValue; updateInputs();
    } else {
        bid.innerHTML = `Новый раунд!<br>Делайте ставку`;
        state.bidQty = 1; state.bidVal = 2; updateInputs();
    }
    const myTurn = gs.players.find(p => p.isTurn)?.name === state.username;
    document.getElementById('game-controls').classList.toggle('hidden', !myTurn);
    if(myTurn) { 
        document.getElementById('btn-call-bluff').disabled = !gs.currentBid; 
        if(tg) tg.HapticFeedback.impactOccurred('medium'); 
    }
    startVisualTimer(gs.turnDeadline);
});
socket.on('roundResult', (data) => tg ? tg.showAlert(data.message) : alert(data.message));
socket.on('gameOver', (data) => {
    showScreen('result');
    document.getElementById('winner-name').textContent = data.winner;
    if(tg) tg.HapticFeedback.notificationOccurred('success');
});
function updateInputs() { document.getElementById('display-qty').textContent = state.bidQty; document.getElementById('display-val').textContent = state.bidVal; }
function startVisualTimer(deadline) {
    clearInterval(state.timerInterval);
    const bar = document.querySelector('.timer-fill'); if(!bar) return;
    state.timerInterval = setInterval(() => {
        const left = deadline - Date.now();
        if (left <= 0) { bar.style.width = '0%'; clearInterval(state.timerInterval); }
        else {
            const pct = (left / 30000) * 100; bar.style.width = `${pct}%`;
            bar.style.background = pct < 30 ? '#FF6B6B' : '#F6B17A';
        }
    }, 100);
}
