const socket = io();
const tg = window.Telegram?.WebApp;

let state = {
    username: null, roomId: null,
    bidQty: 1, bidVal: 2, timerFrame: null,
    createDice: 5, createPlayers: 10, createTime: 30,
    rules: { jokers: false, spot: false },
    pve: { difficulty: 'easy', bots: 3, dice: 5, jokers: false, spot: false },
    coins: 0, inventory: [], equipped: {}
};

if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor('#5D4037'); tg.setBackgroundColor('#5D4037'); }

const screens = ['login', 'home', 'create-settings', 'pve-settings', 'lobby', 'game', 'result', 'shop'];
function showScreen(name) {
    screens.forEach(s => document.getElementById(`screen-${s}`).classList.remove('active'));
    document.getElementById(`screen-${name}`).classList.add('active');
}

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
    if(document.getElementById('screen-home').classList.contains('active') || document.getElementById('screen-login').classList.contains('active')) showScreen('home');
    document.getElementById('user-display').textContent = data.name;
    document.getElementById('rank-display').textContent = data.rankName;
    document.getElementById('win-streak').textContent = `Серия: ${data.streak} 🔥`;
    document.getElementById('user-coins').textContent = data.coins;
    state.coins = data.coins;
    state.inventory = data.inventory;
    state.equipped = data.equipped;

    let rankIcon = '🧹';
    if (data.rankName === 'Юнга') rankIcon = '⚓';
    if (data.rankName === 'Матрос') rankIcon = '🌊';
    if (data.rankName === 'Старший матрос') rankIcon = '🎖️';
    if (data.rankName === 'Боцман') rankIcon = '💪';
    if (data.rankName === 'Первый помощник') rankIcon = '⚔️';
    if (data.rankName === 'Капитан') rankIcon = '☠️';
    if (data.rankName === 'Легенда морей') rankIcon = '🔱';
    document.getElementById('rank-badge').textContent = rankIcon;

    const next = data.nextRankXP === 'MAX' ? data.xp : data.nextRankXP;
    const pct = Math.min(100, (data.xp / next) * 100);
    document.getElementById('xp-fill').style.width = `${pct}%`;
    document.getElementById('xp-text').textContent = `${data.xp} / ${next} XP`;

    if (tg && tg.CloudStorage) tg.CloudStorage.setItem('liarsDiceHardcore', JSON.stringify({ xp: data.xp, streak: data.streak, coins: data.coins, inventory: data.inventory, equipped: data.equipped }));
});

// --- SHOP ---
const ITEMS_META = {
    'skin_white': { name: 'Классика', price: 0, type: 'skins' },
    'skin_red':   { name: 'Рубин', price: 200, type: 'skins' },
    'skin_gold':  { name: 'Золото', price: 1000, type: 'skins' },
    'frame_default': { name: 'Нет рамки', price: 0, type: 'frames' },
    'frame_gold': { name: 'Золотая рамка', price: 500, type: 'frames' },
    'frame_fire': { name: 'Огненная рамка', price: 1500, type: 'frames' },
    'bg_wood':    { name: 'Таверна', price: 0, type: 'bg' },
    'bg_blue':    { name: 'Океан', price: 300, type: 'bg' }
};

let currentShopTab = 'all';
window.filterShop = (type) => {
    currentShopTab = type;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    // Simple active logic needed here if buttons have IDs
    renderShop();
};

function renderShop() {
    const grid = document.getElementById('shop-items');
    grid.innerHTML = '';
    
    for (const [id, meta] of Object.entries(ITEMS_META)) {
        if (currentShopTab !== 'all' && meta.type !== currentShopTab) continue;

        const owned = state.inventory.includes(id);
        const equipped = state.equipped.skin === id || state.equipped.bg === id || state.equipped.frame === id;
        
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
}

document.getElementById('btn-shop').addEventListener('click', () => {
    showScreen('shop');
    document.getElementById('shop-coins').textContent = state.coins;
    renderShop();
});

window.buyItem = (id, price) => {
    if (state.coins >= price) socket.emit('shopBuy', id);
    else tg ? tg.showAlert("Не хватает монет!") : alert("Мало денег!");
};
window.equipItem = (id) => socket.emit('shopEquip', id);

// --- PvE SETUP ---
document.getElementById('btn-to-pve').addEventListener('click', () => showScreen('pve-settings'));

window.setDiff = (diff) => {
    state.pve.difficulty = diff;
    document.querySelectorAll('.btn-time').forEach(b => b.classList.remove('active')); // Reusing class
    // Update text desc
    const desc = { 'easy': '0 XP / 0 монет', 'medium': '10 XP / 10 монет', 'pirate': '40 XP / 40 монет' };
    document.getElementById('diff-desc').textContent = desc[diff];
};

document.getElementById('btn-start-pve').addEventListener('click', () => {
    socket.emit('joinOrCreateRoom', { 
        roomId: null, tgUser: tg?.initDataUnsafe?.user || {id:123}, 
        mode: 'pve',
        options: { 
            dice: state.pve.dice, 
            players: state.pve.bots + 1, // bots + me
            jokers: state.pve.jokers, spot: state.pve.spot,
            difficulty: state.pve.difficulty
        } 
    });
});

// --- EMOTES & RULES ---
window.sendEmote = (e) => { socket.emit('sendEmote', e); };
socket.on('emoteReceived', (data) => {
    const el = document.querySelector(`.player-chip[data-id="${data.id}"]`);
    if (el) {
        const b = document.createElement('div'); b.className = 'emote-bubble'; b.textContent = data.emoji;
        el.appendChild(b); setTimeout(()=>b.remove(), 2000);
        if(tg) tg.HapticFeedback.selectionChanged();
    }
});

window.toggleRule = (rule, isPve = false) => {
    const target = isPve ? state.pve : state.rules;
    target[rule] = !target[rule];
    const id = isPve ? (rule==='jokers'?'btn-rule-joker-pve':'btn-rule-spot-pve') : (rule==='jokers'?'btn-rule-joker':'btn-rule-spot');
    document.getElementById(id).classList.toggle('active', target[rule]);
};

// ... (Rest of navigation & game logic similar to before) ...
// IMPORTANT: Add 'frame_class' to player rendering

socket.on('gameState', (gs) => {
    showScreen('game');
    
    let rulesText = '';
    if (gs.activeRules.jokers) rulesText += '🃏 Джокеры  ';
    if (gs.activeRules.spot) rulesText += '🎯 В точку';
    document.getElementById('active-rules-display').textContent = rulesText;

    const bar = document.getElementById('players-bar');
    bar.innerHTML = gs.players.map(p => {
        // Определяем рамку
        const frameClass = p.equipped && p.equipped.frame ? p.equipped.frame : 'frame_default';
        
        return `
        <div class="player-chip ${p.isTurn ? 'turn' : ''} ${p.isEliminated ? 'dead' : ''} ${frameClass}" data-id="${p.id}">
            <b>${p.name}</b>
            <span class="rank-game">${p.rank}</span>
            <div class="dice-count">🎲 ${p.diceCount}</div>
        </div>
    `}).join('');

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
        document.getElementById('btn-call-spot').disabled = !gs.currentBid || !gs.activeRules.spot;
        if(tg) tg.HapticFeedback.impactOccurred('medium'); 
    } else {
        controls.classList.add('hidden');
    }
    startVisualTimer(gs.turnDeadline);
});

// ... (Existing functions: updateInputs, startVisualTimer, adjBid, adjSetting, etc.) ...
// Ensure to include adjSetting logic for 'bots' in PvE settings
window.adjSetting = (type, delta) => {
    if (type === 'dice') {
        // Update both PvP and PvE displays just in case
        state.createDice = Math.max(1, Math.min(10, state.createDice + delta));
        state.pve.dice = state.createDice; // Sync
        document.querySelectorAll('#set-dice, #pve-dice').forEach(el => el.textContent = state.createDice);
    } 
    else if (type === 'players') {
        state.createPlayers = Math.max(2, Math.min(10, state.createPlayers + delta));
        document.getElementById('set-players').textContent = state.createPlayers;
    }
    else if (type === 'bots') {
        state.pve.bots = Math.max(1, Math.min(9, state.pve.bots + delta));
        document.getElementById('pve-bots').textContent = state.pve.bots;
    }
};

// Add missing event listeners for normal create
document.getElementById('btn-confirm-create').addEventListener('click', () => {
    socket.emit('joinOrCreateRoom', { 
        roomId: null, tgUser: tg?.initDataUnsafe?.user || {id:123}, 
        options: { 
            dice: state.createDice, players: state.createPlayers, time: state.createTime,
            jokers: state.rules.jokers, spot: state.rules.spot
        } 
    });
});

// Dice Skin
socket.on('yourDice', (dice) => {
    const skin = state.equipped.skin || 'skin_white';
    document.getElementById('my-dice').innerHTML = dice.map(d => `<div class="die ${skin}">${d}</div>`).join('');
});
