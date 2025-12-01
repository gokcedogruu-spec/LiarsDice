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
    coins: 0, inventory: [], equipped: {}
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

// --- INIT ---
window.addEventListener('load', () => {
    setTimeout(() => {
        const loading = document.getElementById('screen-loading');
        if (loading && loading.classList.contains('active')) {
            if (!tg?.initDataUnsafe?.user) showScreen('login');
        }
    }, 3000);

    if (tg?.initDataUnsafe?.user) {
        state.username = tg.initDataUnsafe.user.first_name;
        loginSuccess();
    }
});

function bindClick(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
}

bindClick('btn-login', () => {
    const val = document.getElementById('input-username').value.trim();
    if (val) { 
        state.username = val; 
        socket.tgUserId = 123; 
        loginSuccess(); 
    }
});

function loginSuccess() {
    const userPayload = tg?.initDataUnsafe?.user || { id: 123, first_name: state.username, username: 'browser' };
    
    if (tg && tg.CloudStorage) {
        tg.CloudStorage.getItem('liarsDiceHardcore', (err, val) => {
            let savedData = null; try { if (val) savedData = JSON.parse(val); } catch (e) {}
            socket.emit('login', { tgUser: userPayload, savedData });
        });
    } else {
        socket.emit('login', { tgUser: userPayload, savedData: null });
    }
}

socket.on('profileUpdate', (data) => {
    if(document.getElementById('screen-loading')?.classList.contains('active') || 
       document.getElementById('screen-login')?.classList.contains('active')) {
        showScreen('home');
    }
    
    const disp = document.getElementById('user-display'); if(disp) disp.textContent = data.name;
    const rankD = document.getElementById('rank-display'); if(rankD) rankD.textContent = data.rankName;
    const streak = document.getElementById('win-streak'); if(streak) streak.textContent = `Серия: ${data.streak} 🔥`;
    const coins = document.getElementById('user-coins'); if(coins) coins.textContent = data.coins;
    
    state.coins = data.coins;
    state.inventory = data.inventory || [];
    state.equipped = data.equipped || {};

    let rankIcon = '🧹';
    if (data.rankName === 'Юнга') rankIcon = '⚓';
    if (data.rankName === 'Матрос') rankIcon = '🌊';
    if (data.rankName === 'Старший матрос') rankIcon = '🎖️';
    if (data.rankName === 'Боцман') rankIcon = '💪';
    if (data.rankName === 'Первый помощник') rankIcon = '⚔️';
    if (data.rankName === 'Капитан') rankIcon = '☠️';
    if (data.rankName === 'Легенда морей') rankIcon = '🔱';
    const badge = document.getElementById('rank-badge'); if(badge) badge.textContent = rankIcon;

    const next = data.nextRankXP === 'MAX' ? data.xp : data.nextRankXP;
    const pct = Math.min(100, (data.xp / next) * 100);
    const fill = document.getElementById('xp-fill'); if(fill) fill.style.width = `${pct}%`;
    const txt = document.getElementById('xp-text'); if(txt) txt.textContent = `${data.xp} / ${next} XP`;

    if (tg && tg.CloudStorage) {
        tg.CloudStorage.setItem('liarsDiceHardcore', JSON.stringify({ 
            xp: data.xp, streak: data.streak, coins: data.coins, 
            inventory: data.inventory, equipped: data.equipped 
        }));
    }

    // Обновляем магазин
    if (document.getElementById('screen-shop').classList.contains('active')) {
        document.getElementById('shop-coins').textContent = state.coins;
        renderShop();
    }
});

// --- SHOP ---
const ITEMS_META = {
    'skin_white': { name: 'Классика', price: 0, type: 'skins' },
    'skin_red':   { name: 'Рубин', price: 200, type: 'skins' },
    'skin_gold':  { name: 'Золото', price: 1000, type: 'skins' },
    'skin_black': { name: 'Черная метка', price: 500, type: 'skins' },
    'skin_blue':  { name: 'Морской', price: 300, type: 'skins' },
    'skin_green': { name: 'Яд', price: 400, type: 'skins' },
    'skin_purple':{ name: 'Магия вуду', price: 800, type: 'skins' },
    'skin_cyber': { name: 'Кибер', price: 1500, type: 'skins' },
    'skin_bone':  { name: 'Костяной', price: 2500, type: 'skins' },

    'frame_default': { name: 'Нет рамки', price: 0, type: 'frames' },
    'frame_wood':    { name: 'Дерево', price: 100, type: 'frames' },
    'frame_silver':  { name: 'Серебро', price: 300, type: 'frames' },
    'frame_gold':    { name: 'Золото', price: 500, type: 'frames' },
    'frame_fire':    { name: 'Огонь', price: 1500, type: 'frames' },
    
    'bg_wood':       { name: 'Стол', price: 0, type: 'bg' }
};

let shopFilter = 'all';

window.filterShop = (filter) => {
    shopFilter = filter;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${filter}`).classList.add('active');
    renderShop();
}

function renderShop() {
    const grid = document.getElementById('shop-items');
    if (!grid) return;
    grid.innerHTML = '';
    
    for (const [id, meta] of Object.entries(ITEMS_META)) {
        if (shopFilter !== 'all' && meta.type !== shopFilter) continue;
        
        const owned = state.inventory.includes(id);
        const equipped = (state.equipped[meta.type] === id);
        
        let btnHTML = '';
        if (equipped) btnHTML = `<button class="shop-btn equipped">НАДЕТО</button>`;
        else if (owned) btnHTML = `<button class="shop-btn equip" onclick="equipItem('${id}')">НАДЕТЬ</button>`;
        else btnHTML = `<button class="shop-btn buy" onclick="buyItem('${id}', ${meta.price})">КУПИТЬ (${meta.price})</button>`;
        
        grid.innerHTML += `<div class="shop-item ${owned ? 'owned' : ''}"><h4>${meta.name}</h4>${btnHTML}</div>`;
    }
}

bindClick('btn-shop', () => { 
    showScreen('shop'); 
    const coinEl = document.getElementById('shop-coins'); 
    if(coinEl) coinEl.textContent = state.coins; 
    renderShop();
});
bindClick('btn-shop-back', () => showScreen('home'));

window.buyItem = (id, price) => {
    if (state.coins >= price) socket.emit('shopBuy', id);
    else tg ? tg.showAlert("Не хватает монет!") : alert("Мало денег!");
};
window.equipItem = (id) => socket.emit('shopEquip', id);


// --- PVE ---
bindClick('btn-to-pve', () => { showScreen('pve-settings'); window.setDiff(state.pve.difficulty); });
bindClick('btn-pve-back', () => showScreen('home'));

window.setDiff = (diff) => { 
    state.pve.difficulty = diff; 
    
    document.querySelectorAll('#pve-difficulty-selector .btn-time').forEach(b => b.classList.remove('active'));
    const container = document.querySelector('#screen-pve-settings .time-selector');
    if(container) { Array.from(container.children).forEach(btn => { if(btn.getAttribute('onclick').includes(`'${diff}'`)) btn.classList.add('active'); }); } 
    
    const desc = {
        'easy': 'Противники делают ставки, близкие к истине. Легко блефовать.',
        'medium': 'Противники считают шансы. Рискуют, если шансы выше 50%.',
        'pirate': 'Противники блефуют агрессивно. Ставки могут быть сильно завышены.'
    };
    const descEl = document.getElementById('pve-difficulty-desc');
    if(descEl) descEl.textContent = desc[diff];
};

window.adjPveSettings = (type, delta) => {
    let min, max;
    if (type === 'dice') { min = 3; max = 6; }
    if (type === 'bots') { min = 1; max = 9; }
    
    let current = state.pve[type];
    let newVal = Math.max(min, Math.min(max, current + delta));
    state.pve[type] = newVal;
    
    if (type === 'dice') document.getElementById('pve-dice-count').textContent = newVal;
    if (type === 'bots') document.getElementById('pve-bot-count').textContent = newVal;
};

window.startPveGame = () => {
    const totalPlayers = state.pve.bots + 1;
    socket.emit('joinOrCreateRoom', { 
        roomId: 'CPU_' + Math.random().toString(36).substring(2,6), 
        tgUser: tg?.initDataUnsafe?.user,
        options: {
            dice: state.pve.dice,
            players: totalPlayers,
            time: 30, // PVE time is fixed
            jokers: state.pve.jokers,
            spot: state.pve.spot,
            difficulty: state.pve.difficulty
        }
    });
};

// --- CREATE ROOM ---
bindClick('btn-to-create', () => showScreen('create-settings'));
bindClick('btn-create-back', () => showScreen('home'));
bindClick('btn-confirm-create', () => {
    socket.emit('joinOrCreateRoom', { 
        roomId: null, 
        tgUser: tg?.initDataUnsafe?.user, 
        options: {
            dice: state.createDice,
            players: state.createPlayers,
            time: state.createTime,
            jokers: state.rules.jokers,
            spot: state.rules.spot,
            strict: state.rules.strict
        }
    });
});

window.adjCreateSettings = (type, delta) => {
    let min, max, target;
    if (type === 'dice') { min = 3; max = 6; target = 'createDice'; }
    if (type === 'players') { min = 2; max = 10; target = 'createPlayers'; }
    
    let current = state[target];
    let newVal = Math.max(min, Math.min(max, current + delta));
    state[target] = newVal;
    
    if (type === 'dice') document.getElementById('create-dice-count').textContent = newVal;
    if (type === 'players') document.getElementById('create-player-count').textContent = newVal;
};

window.setTime = (time) => {
    state.createTime = time;
    document.querySelectorAll('.time-selector .btn-time').forEach(b => b.classList.remove('active'));
    document.querySelector(`.time-selector button[onclick="setTime(${time})"]`).classList.add('active');
};

window.toggleRule = (rule, isPve = false) => {
    const target = isPve ? state.pve : state.rules;
    target[rule] = !target[rule];
    
    const id = isPve ? (rule==='jokers'?'btn-rule-jokers-pve':`btn-rule-${rule}-pve`) : (rule==='jokers'?'btn-rule-jokers':`btn-rule-${rule}`);
    const btn = document.getElementById(id);
    if(btn) btn.classList.toggle('active', target[rule]);
};

// --- ROOM / LOBBY ---
socket.on('joinedRoom', (data) => {
    state.roomId = data.roomId;
    showScreen('lobby');
    
    const startBtn = document.getElementById('btn-start-game');
    if(startBtn) data.isCreator ? startBtn.classList.remove('hidden') : startBtn.classList.add('hidden');
    
    document.getElementById('lobby-code').textContent = data.roomId;
    document.getElementById('btn-ready').textContent = "Я ГОТОВ";
    document.getElementById('btn-ready').className = "btn btn-blue";
});

socket.on('roomUpdate', (room) => {
    const list = document.getElementById('player-list');
    if (!list) return;
    
    document.getElementById('lobby-code').textContent = room.roomId;
    state.roomId = room.roomId;
    
    list.innerHTML = '';
    room.players.forEach(p => {
        // Добавляем onclick и класс clickable-player
        const isBot = p.id.toString().startsWith('bot');
        const clickAttr = isBot ? '' : `onclick="openProfile('${p.id}')"`;
        const cursorClass = isBot ? '' : 'clickable-player';

        list.innerHTML += `<div class="player-item ${cursorClass}" ${clickAttr}>
            <div><b>${p.name}</b><span class="rank-sub">${p.rank}</span></div>
            <span>${p.ready?'✅':'⏳'}</span>
        </div>`;
    });
    
    const isCreator = room.players.find(p => p.id === socket.id)?.isCreator;
    const allReady = room.players.length > 1 && room.players.every(p => p.ready);
    const startBtn = document.getElementById('btn-start-game');
    if (startBtn && isCreator) {
        allReady ? startBtn.classList.remove('hidden') : startBtn.classList.add('hidden');
    }
});

bindClick('btn-join-room', () => {
    const code = prompt("Код:");
    const userPayload = tg?.initDataUnsafe?.user || { id: 123, first_name: state.username };
    if(code) socket.emit('joinOrCreateRoom', { roomId: code.toUpperCase().trim(), tgUser: userPayload });
});

bindClick('share-btn', () => {
    const code = state.roomId;
    navigator.clipboard.writeText(code).then(() => tg ? tg.showAlert('Скопировано!') : alert('Скопировано!')).catch(()=>prompt("Код:", code));
});

bindClick('btn-ready', function() {
    const isReady = this.textContent === "Я ГОТОВ";
    socket.emit('setReady', isReady);
    this.textContent = isReady ? "НЕ ГОТОВ" : "Я ГОТОВ";
    this.className = isReady ? "btn btn-green" : "btn btn-blue";
});

bindClick('btn-start-game', () => socket.emit('startGame'));


// --- GAME ---
window.adjBid = (type, delta) => {
    if (type === 'qty') {
        state.bidQty = Math.max(1, state.bidQty + delta);
    } else if (type === 'val') {
        state.bidVal = Math.max(1, Math.min(6, state.bidVal + delta));
    }
    updateInputs();
};

bindClick('btn-make-bid', () => {
    socket.emit('makeBid', { quantity: state.bidQty, faceValue: state.bidVal });
    if(tg) tg.HapticFeedback.impactOccurred('light');
});
bindClick('btn-call-bluff', () => socket.emit('callBluff'));
bindClick('btn-call-spot', () => socket.emit('callSpot'));


socket.on('yourDice', (dice) => {
    showScreen('game');
    const row = document.getElementById('my-dice-row');
    row.innerHTML = dice.map(d => `<div class="die ${state.equipped.skin}">${d}</div>`).join('');
    
    // Сброс ставки для следующего хода
    state.bidQty = 1;
    state.bidVal = 2;
    updateInputs();

    // Обновление фона стола
    document.body.className = state.equipped.bg;
});

socket.on('currentBid', (bid) => {
    const display = document.getElementById('current-bid-display');
    if (!bid) {
        display.innerHTML = `<h3>Первая ставка!</h3>`;
    } else {
        display.innerHTML = `
            <h3>Текущая ставка:</h3>
            <span style="font-size: 2rem;">${bid.quantity}x <span class="dice-face">${bid.faceValue}</span></span>
        `;
    }
});

socket.on('gameEvent', (data) => {
    if (tg) tg.showAlert(data.text);
    // Более заметные нотификации
    if (data.type === 'error') tg?.HapticFeedback.notificationOccurred('error');
    if (data.type === 'bid') tg?.HapticFeedback.notificationOccurred('success');
});

socket.on('revealDice', (allDice) => {
    // Временно не отображаем анимацию раскрытия, чтобы не загромождать
    // В будущих версиях тут может быть красивая анимация
});

socket.on('gameState', (gs) => {
    const currentBidDisplay = document.getElementById('current-bid-display');
    if (!gs.currentBid) {
         currentBidDisplay.innerHTML = `<h3>Первая ставка!</h3>`;
    }
    
    // Обновление правил
    let rulesText = '';
    if (gs.activeRules.jokers) rulesText += '🃏 Джокеры ';
    if (gs.activeRules.spot) rulesText += '🎯 В точку ';
    if (gs.activeRules.strict) rulesText += '🔒 Строго';
    document.getElementById('active-rules-display').textContent = rulesText;
    
    // Кнопка В ТОЧКУ
    const spotBtn = document.getElementById('btn-call-spot');
    if (spotBtn) {
        gs.activeRules.spot ? spotBtn.classList.remove('hidden-rule') : spotBtn.classList.add('hidden-rule');
    }

    // Рендер игроков (обновляем кликабельность)
    const bar = document.getElementById('players-bar');
    bar.innerHTML = gs.players.map(p => {
        const frameClass = p.equipped && p.equipped.frame ? p.equipped.frame : 'frame_default';
        const isBot = p.id.toString().startsWith('bot');
        const clickAttr = isBot ? '' : `onclick="openProfile('${p.id}')"`;
        const cursorClass = isBot ? '' : 'clickable-player';

        return `
        <div class="player-chip ${p.isTurn ? 'turn' : ''} ${p.isEliminated ? 'dead' : ''} ${frameClass} ${cursorClass}" 
             data-id="${p.id}" ${clickAttr}>
            <b>${p.name}</b>
            <span class="rank-game">${p.rank}</span>
            <div class="dice-count">🎲 ${p.diceCount}</div>
        </div>
    `}).join('');
    
    // Управление контролами
    const controls = document.getElementById('game-controls');
    const isMyTurn = gs.players[gs.currentTurn]?.id === socket.id;
    const bluffBtn = document.getElementById('btn-call-bluff');
    
    if (isMyTurn) {
        controls.classList.remove('hidden');
        if(bluffBtn) bluffBtn.disabled = !gs.currentBid;
        if(spotBtn) spotBtn.disabled = !gs.currentBid;
        if(tg) tg.HapticFeedback.impactOccurred('medium'); 
    } else {
        controls.classList.add('hidden');
    }
    
    // Обновление таймера
    if (gs.remainingTime !== undefined && gs.totalDuration) {
        startVisualTimer(gs.remainingTime, gs.totalDuration);
    }
});

socket.on('roundResult', (data) => tg ? tg.showAlert(data.message) : alert(data.message));

bindClick('btn-home', () => {
    state.roomId = null;
    document.body.className = '';
    showScreen('home');
    if(state.timerFrame) cancelAnimationFrame(state.timerFrame);
});
bindClick('btn-restart', () => socket.emit('requestRestart'));

socket.on('gameOver', (data) => {
    showScreen('result'); document.getElementById('winner-name').textContent = data.winner;
    if(tg) tg.HapticFeedback.notificationOccurred('success');
    if(state.timerFrame) cancelAnimationFrame(state.timerFrame);
});

function updateInputs() { document.getElementById('display-qty').textContent = state.bidQty; document.getElementById('display-val').textContent = state.bidVal; }


// --- FIX: VISUAL TIMER LOGIC ---
function startVisualTimer(remaining, total) {
    if (state.timerFrame) cancelAnimationFrame(state.timerFrame);
    
    const bar = document.querySelector('.timer-progress'); 
    if (!bar) return;

    const endTime = Date.now() + remaining; 

    function tick() {
        const now = Date.now(); 
        const left = endTime - now;
        
        if (left <= 0) { 
            bar.style.width = '0%'; 
            return; 
        }
        
        const pct = (left / total) * 100; 
        bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
        
        // Цвет меняется от зеленого к красному
        if (pct < 30) bar.style.backgroundColor = '#ef233c'; // Красный
        else if (pct < 60) bar.style.backgroundColor = '#ffb703'; // Желтый
        else bar.style.backgroundColor = '#06d6a0'; // Зеленый
        
        state.timerFrame = requestAnimationFrame(tick);
    }
    tick();
}

// --- NEW: PROFILE VIEW SYSTEM ---
const modal = document.getElementById('modal-profile');

window.showMyProfile = () => {
    socket.emit('getUserProfile', socket.id);
};

window.openProfile = (targetSocketId) => {
    // Не открываем профиль ботов (у них id начинается на bot_)
    if (targetSocketId.toString().startsWith('bot')) {
        if(tg) tg.HapticFeedback.notificationOccurred('error');
        return;
    }
    // Если кликнули на себя
    if (targetSocketId === socket.id) {
        showMyProfile();
    } else {
        socket.emit('getUserProfile', targetSocketId);
    }
};

window.closeProfile = (e) => {
    if (!e || e.target === modal || e.target.classList.contains('btn-close')) {
        modal.classList.add('hidden');
    }
};

socket.on('showUserProfile', (data) => {
    document.getElementById('view-username').textContent = data.name;
    document.getElementById('view-rank-name').textContent = data.rankName;
    document.getElementById('view-matches').textContent = data.matches;
    document.getElementById('view-wins').textContent = data.wins;
    
    // Расчет винрейта
    const wr = data.matches > 0 ? Math.round((data.wins / data.matches) * 100) : 0;
    document.getElementById('view-winrate').textContent = `${wr}%`;

    // Иконка ранга
    let rankIcon = '🧹';
    if (data.rankName === 'Юнга') rankIcon = '⚓';
    if (data.rankName === 'Матрос') rankIcon = '🌊';
    if (data.rankName === 'Старший матрос') rankIcon = '🎖️';
    if (data.rankName === 'Боцман') rankIcon = '💪';
    if (data.rankName === 'Первый помощник') rankIcon = '⚔️';
    if (data.rankName === 'Капитан') rankIcon = '☠️';
    if (data.rankName === 'Легенда морей') rankIcon = '🔱';
    document.getElementById('view-rank-badge').textContent = rankIcon;

    // Рендер инвентаря с подписями
    const grid = document.getElementById('view-inventory');
    grid.innerHTML = '';
    
    if (!data.inventory || data.inventory.length === 0) {
        grid.innerHTML = '<div style="grid-column: span 3; opacity: 0.5; font-size: 0.8rem;">Пусто...</div>';
    } else {
        data.inventory.forEach(itemId => {
            const meta = ITEMS_META[itemId];
            if (!meta) return;
            
            let preview = '📦';
            if (meta.type === 'skins') preview = '🎲';
            if (meta.type === 'frames') preview = '🖼️';
            if (meta.type === 'bg') preview = '🌄';

            grid.innerHTML += `
                <div class="inv-item">
                    <div class="inv-preview">${preview}</div>
                    <div class="inv-item-name">${meta.name}</div>
                </div>
            `;
        });
    }

    modal.classList.remove('hidden');
});
