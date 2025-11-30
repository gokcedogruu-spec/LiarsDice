const socket = io();
const tg = window.Telegram?.WebApp;

let state = {
    username: null, roomId: null,
    bidQty: 1, bidVal: 2, timerFrame: null,
    createDice: 5, createPlayers: 10, createTime: 30,
    rules: { jokers: false, spot: false }, // Новые правила
    coins: 0, inventory: [], equipped: {}
};

if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor('#5D4037'); tg.setBackgroundColor('#5D4037'); }

const screens = ['login', 'home', 'create-settings', 'lobby', 'game', 'result', 'shop'];
function showScreen(name) {
    screens.forEach(s => document.getElementById(`screen-${s}`).classList.remove('active'));
    document.getElementById(`screen-${name}`).classList.add('active');
}

// Login (Auto)
window.addEventListener('load', () => {
    if (tg?.initDataUnsafe?.user) {
        state.username = tg.initDataUnsafe.user.first_name;
        document.getElementById('screen-login').classList.remove('active');
        loginSuccess();
    } else {
        document.getElementById('screen-login').classList.add('active');
    }
});
document.getElementById('btn-login').addEventListener('click', () => {
    const val = document.getElementById('input-username').value.trim();
    if (val) { state.username = val; loginSuccess(); }
});

function loginSuccess() {
    if (tg && tg.CloudStorage) {
        tg.CloudStorage.getItem('liarsDiceHardcore', (err, val) => {
            let savedData = null; try { if (val) savedData = JSON.parse(val); } catch (e) {}
            socket.emit('login', { tgUser: tg?.initDataUnsafe?.user || { id: 123, first_name: state.username }, savedData });
        });
    } else {
        socket.emit('login', { tgUser: { id: 123, first_name: state.username }, savedData: null });
    }
}

socket.on('profileUpdate', (data) => {
    // Show Home
    if(document.getElementById('screen-home').classList.contains('active') || document.getElementById('screen-login').classList.contains('active')) showScreen('home');
    
    document.getElementById('user-display').textContent = data.name;
    document.getElementById('rank-display').textContent = data.rankName;
    document.getElementById('win-streak').textContent = `Серия: ${data.streak} 🔥`;
    document.getElementById('user-coins').textContent = data.coins;
    state.coins = data.coins;
    state.inventory = data.inventory;
    state.equipped = data.equipped;

    // Badges logic... (same as before)
    // XP logic... (same as before)
    
    // Save to Cloud
    if (tg && tg.CloudStorage) tg.CloudStorage.setItem('liarsDiceHardcore', JSON.stringify({ xp: data.xp, streak: data.streak, coins: data.coins, inventory: data.inventory, equipped: data.equipped }));
});

// --- SHOP ---
const ITEMS_META = {
    'skin_white': { name: 'Классика', price: 0 },
    'skin_red':   { name: 'Рубин', price: 200 },
    'skin_gold':  { name: 'Золото', price: 1000 },
    'bg_wood':    { name: 'Таверна', price: 0 },
    'bg_blue':    { name: 'Океан', price: 300 }
};

document.getElementById('btn-shop').addEventListener('click', () => {
    showScreen('shop');
    document.getElementById('shop-coins').textContent = state.coins;
    const grid = document.getElementById('shop-items');
    grid.innerHTML = '';
    
    for (const [id, meta] of Object.entries(ITEMS_META)) {
        const owned = state.inventory.includes(id);
        const equipped = state.equipped.skin === id || state.equipped.bg === id;
        
        let btnHTML = '';
        if (equipped) btnHTML = `<button class="shop-btn equipped">НАДЕТО</button>`;
        else if (owned) btnHTML = `<button class="shop-btn equip" onclick="equipItem('${id}')">НАДЕТЬ</button>`;
        else btnHTML = `<button class="shop-btn buy" onclick="buyItem('${id}', ${meta.price})">КУПИТЬ (${meta.price})</button>`;

        grid.innerHTML += `
            <div class="shop-item ${owned ? 'owned' : ''}">
                <h4>${meta.name}</h4>
                ${btnHTML}
            </div>
        `;
    }
});

window.buyItem = (id, price) => {
    if (state.coins >= price) socket.emit('shopBuy', id);
    else tg ? tg.showAlert("Не хватает монет!") : alert("Мало денег!");
};
window.equipItem = (id) => socket.emit('shopEquip', id);

// --- EMOTES ---
window.sendEmote = (e) => { socket.emit('sendEmote', e); };
socket.on('emoteReceived', (data) => {
    const el = document.querySelector(`.player-chip[data-id="${data.id}"]`);
    if (el) {
        const b = document.createElement('div'); b.className = 'emote-bubble'; b.textContent = data.emoji;
        el.appendChild(b); setTimeout(()=>b.remove(), 2000);
        if(tg) tg.HapticFeedback.selectionChanged();
    }
});

// --- SETTINGS & RULES ---
window.toggleRule = (rule) => {
    state.rules[rule] = !state.rules[rule];
    const btn = document.getElementById(rule === 'jokers' ? 'btn-rule-joker' : 'btn-rule-spot');
    btn.classList.toggle('active', state.rules[rule]);
};

document.getElementById('btn-confirm-create').addEventListener('click', () => {
    socket.emit('joinOrCreateRoom', { 
        roomId: null, tgUser: tg?.initDataUnsafe?.user || {id:123}, 
        options: { 
            dice: state.createDice, players: state.createPlayers, time: state.createTime,
            jokers: state.rules.jokers, spot: state.rules.spot
        } 
    });
});

// ... (Existing JOIN, SHARE, READY logic) ...

// GAME
document.getElementById('btn-call-spot').addEventListener('click', () => socket.emit('callSpot'));

socket.on('gameState', (gs) => {
    showScreen('game');
    
    // Render rules indicators
    let rulesText = '';
    if (gs.activeRules.jokers) rulesText += '🃏 Джокеры  ';
    if (gs.activeRules.spot) rulesText += '🎯 В точку';
    document.getElementById('active-rules-display').textContent = rulesText;

    const bar = document.getElementById('players-bar');
    bar.innerHTML = gs.players.map(p => `
        <div class="player-chip ${p.isTurn ? 'turn' : ''} ${p.isEliminated ? 'dead' : ''}" data-id="${p.id}">
            <b>${p.name}</b>
            <span class="rank-game">${p.rank}</span>
            <div class="dice-count">🎲 ${p.diceCount}</div>
        </div>
    `).join('');

    const bid = document.getElementById('current-bid-display');
    if (gs.currentBid) {
        bid.innerHTML = `<div class="bid-qty">${gs.currentBid.quantity}<span class="bid-x">x</span><span class="bid-face">${gs.currentBid.faceValue}</span></div>`;
        state.bidQty = gs.currentBid.quantity; state.bidVal = gs.currentBid.faceValue; updateInputs();
    } else {
        bid.innerHTML = `<div style="font-size:1.2rem; color:#2b2d42; font-weight:bold;">Ваш ход!</div>`;
        state.bidQty = 1; state.bidVal = 2; updateInputs();
    }

    const me = gs.players.find(p => p.id === socket.id);
    const myTurn = me?.isTurn;
    const controls = document.getElementById('game-controls');
    
    if(myTurn) { 
        controls.classList.remove('hidden'); controls.classList.add('slide-up');
        document.getElementById('btn-call-bluff').disabled = !gs.currentBid; 
        document.getElementById('btn-call-spot').disabled = !gs.currentBid || !gs.activeRules.spot; // Only if rule active
        if(tg) tg.HapticFeedback.impactOccurred('medium'); 
    } else {
        controls.classList.add('hidden');
    }
    startVisualTimer(gs.turnDeadline);
});

// Dice Skin Rendering
socket.on('yourDice', (dice) => {
    const skin = state.equipped.skin || 'skin_white';
    document.getElementById('my-dice').innerHTML = dice.map(d => `<div class="die ${skin}">${d}</div>`).join('');
});

// ... (Existing helper functions) ...
