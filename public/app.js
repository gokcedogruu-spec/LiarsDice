const socket = io();
const tg = window.Telegram?.WebApp;

let state = {
    username: null, roomId: null,
    bidQty: 1, bidVal: 2, timerFrame: null,
    createDice: 5, createPlayers: 10, createTime: 30
};

if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor('#2D3250'); tg.setBackgroundColor('#2D3250'); }
const screens = ['login', 'home', 'create-settings', 'lobby', 'game', 'result'];
function showScreen(name) {
    screens.forEach(s => document.getElementById(`screen-${s}`).classList.remove('active'));
    document.getElementById(`screen-${name}`).classList.add('active');
}

window.addEventListener('load', () => {
    if (tg?.initDataUnsafe?.user) { state.username = tg.initDataUnsafe.user.first_name; loginSuccess(); }
});
document.getElementById('btn-login').addEventListener('click', () => {
    const val = document.getElementById('input-username').value.trim();
    if (val) { state.username = val; loginSuccess(); }
});

function loginSuccess() {
    showScreen('home');
    document.getElementById('user-display').textContent = state.username;
    if (tg && tg.CloudStorage) {
        tg.CloudStorage.getItem('liarsDiceHardcore', (err, val) => {
            let savedData = null; try { savedData = JSON.parse(val); } catch (e) {}
            socket.emit('login', { username: state.username, savedData });
        });
    } else socket.emit('login', { username: state.username, savedData: null });
}

socket.on('profileUpdate', (data) => {
    document.getElementById('rank-display').textContent = data.rankName;
    document.getElementById('win-streak').textContent = `Серия: ${data.streak} 🔥`;
    let rankIcon = '🦠';
    if (data.rankName === 'Юнга') rankIcon = '⚓';
    if (data.rankName === 'Матрос') rankIcon = '🌊';
    if (data.rankName === 'Старший матрос') rankIcon = '🎖️';
    if (data.rankName === 'Боцман') rankIcon = '💪';
    if (data.rankName === 'Первый помощник') rankIcon = '⚔️';
    if (data.rankName === 'Капитан') rankIcon = '☠️';
    document.getElementById('rank-badge').textContent = rankIcon;
    const next = data.nextRankXP === 'MAX' ? data.xp : data.nextRankXP;
    document.getElementById('xp-fill').style.width = `${Math.min(100, (data.xp / next) * 100)}%`;
    document.getElementById('xp-text').textContent = `${data.xp} / ${next} XP`;
    if (tg && tg.CloudStorage) tg.CloudStorage.setItem('liarsDiceHardcore', JSON.stringify({ xp: data.xp, streak: data.streak }));
});

// Settings
document.getElementById('btn-to-create').addEventListener('click', () => showScreen('create-settings'));
document.getElementById('btn-back-home').addEventListener('click', () => showScreen('home'));

window.setTime = (sec) => {
    state.createTime = sec;
    document.querySelectorAll('.btn-time').forEach(b => b.classList.remove('active'));
    const target = Array.from(document.querySelectorAll('.btn-time')).find(b => b.textContent.includes(sec));
    if (target) target.classList.add('active');
};
window.adjSetting = (type, delta) => {
    if (type === 'dice') { state.createDice = Math.max(1, Math.min(10, state.createDice + delta)); document.getElementById('set-dice').textContent = state.createDice; }
    else if (type === 'players') { state.createPlayers = Math.max(2, Math.min(10, state.createPlayers + delta)); document.getElementById('set-players').textContent = state.createPlayers; }
};
document.getElementById('btn-confirm-create').addEventListener('click', () => {
    socket.emit('joinOrCreateRoom', { roomId: null, username: state.username, options: { dice: state.createDice, players: state.createPlayers, time: state.createTime } });
});

// Game
document.getElementById('btn-join-room').addEventListener('click', () => {
    const code = prompt("Код:"); if(code) socket.emit('joinOrCreateRoom', { roomId: code.toUpperCase().trim(), username: state.username });
});
document.getElementById('share-btn').addEventListener('click', () => {
    const code = state.roomId;
    navigator.clipboard.writeText(code).then(() => tg ? tg.showAlert('Скопировано!') : alert('Скопировано!')).catch(()=>prompt("Код:", code));
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
        if (room.config) document.getElementById('lobby-rules').textContent = `🎲 ${room.config.dice} | 👤 ${room.config.players} | ⏱️ ${room.config.time}с`;
        const list = document.getElementById('lobby-players'); list.innerHTML = '';
        room.players.forEach(p => {
            list.innerHTML += `<div class="player-item"><div><b>${p.name}</b><span class="rank-sub">${p.rank}</span></div><span>${p.ready?'✅':'⏳'}</span></div>`;
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
        bid.innerHTML = `Новый раунд!`; state.bidQty = 1; state.bidVal = 2; updateInputs();
    }
    const myTurn = gs.players.find(p => p.isTurn)?.name === state.username;
    document.getElementById('game-controls').classList.toggle('hidden', !myTurn);
    if(myTurn) { document.getElementById('btn-call-bluff').disabled = !gs.currentBid; if(tg) tg.HapticFeedback.impactOccurred('medium'); }
    startVisualTimer(gs.turnDeadline);
});
socket.on('roundResult', (data) => tg ? tg.showAlert(data.message) : alert(data.message));
socket.on('gameOver', (data) => {
    showScreen('result'); document.getElementById('winner-name').textContent = data.winner;
    if(tg) tg.HapticFeedback.notificationOccurred('success');
});
function updateInputs() { document.getElementById('display-qty').textContent = state.bidQty; document.getElementById('display-val').textContent = state.bidVal; }

// --- SMOOTH TIMER ---
function startVisualTimer(deadline) {
    if (state.timerFrame) cancelAnimationFrame(state.timerFrame);
    const bar = document.querySelector('.timer-fill');
    if (!bar) return;
    
    // Вычисляем общую длительность (дедлайн - сейчас, но грубо берем от 30/45/60, тут визуально)
    // Для точности лучше брать от state.createTime * 1000
    const totalDuration = state.createTime * 1000; 

    function tick() {
        const now = Date.now();
        const left = deadline - now;
        if (left <= 0) {
            bar.style.width = '0%';
            return;
        }
        const pct = (left / totalDuration) * 100; 
        // Ограничим 100%, если рассинхрон
        bar.style.width = `${Math.min(100, pct)}%`;
        bar.style.background = pct < 30 ? '#FF6B6B' : '#F6B17A';
        state.timerFrame = requestAnimationFrame(tick);
    }
    tick();
}
