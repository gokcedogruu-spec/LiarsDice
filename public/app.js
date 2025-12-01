// Глобальный перехватчик ошибок
window.onerror = function(message, source, lineno, colno, error) {
    // alert("Error: " + message); 
};

// --- MOCK SOCKET & TG FOR PREVIEW ---
// Этот блок кода эмулирует сервер и Telegram, если они недоступны,
// чтобы интерфейс работал в браузере без реального бэкенда.

const isPreview = !window.Telegram?.WebApp?.initDataUnsafe?.user;

// Эмуляция Telegram WebApp
const tg = window.Telegram?.WebApp || {
    ready: () => {}, expand: () => {}, setHeaderColor: () => {}, setBackgroundColor: () => {},
    initDataUnsafe: { user: { id: 999, first_name: "PreviewUser", username: "tester" } },
    CloudStorage: {
        getItem: (k, cb) => cb(null, localStorage.getItem(k)),
        setItem: (k, v) => localStorage.setItem(k, v)
    },
    HapticFeedback: { notificationOccurred: () => {}, selectionChanged: () => {}, impactOccurred: () => {} },
    showAlert: (msg) => alert(msg)
};

// Эмуляция Socket.io
class MockSocket {
    constructor() {
        this.handlers = {};
        this.id = 'socket_' + Math.random();
        // Имитация задержки сервера
        setTimeout(() => this.trigger('connect'), 100);
    }
    on(event, callback) {
        this.handlers[event] = callback;
    }
    emit(event, data) {
        console.log('Socket emit:', event, data);
        // Простая эмуляция ответов сервера
        if (event === 'login') {
            setTimeout(() => {
                const saved = data.savedData || {};
                this.trigger('profileUpdate', {
                    name: data.tgUser.first_name,
                    rankName: 'Юнга', nextRankXP: 500,
                    xp: saved.xp || 100, streak: saved.streak || 0,
                    coins: saved.coins || 250,
                    inventory: saved.inventory || ['skin_white', 'bg_wood', 'frame_default'],
                    equipped: saved.equipped || { skin: 'skin_white', bg: 'bg_wood', frame: 'frame_default' }
                });
            }, 500);
        }
        if (event === 'shopBuy') {
            // Эмуляция покупки
            if(state.coins >= 100) { // Упрощенно
                state.coins -= 100;
                state.inventory.push(data);
                this.trigger('gameEvent', { text: 'Покупка успешна!', type: 'info' });
                // Обновляем профиль
                this.trigger('profileUpdate', {
                    name: state.username, rankName: 'Юнга', nextRankXP: 500,
                    xp: 100, streak: 0, coins: state.coins,
                    inventory: state.inventory, equipped: state.equipped
                });
            } else {
                tg.showAlert("Не хватает монет (эмуляция)!");
            }
        }
        if (event === 'shopEquip') {
            if(data.startsWith('skin_')) state.equipped.skin = data;
            if(data.startsWith('frame_')) state.equipped.frame = data;
            this.trigger('profileUpdate', {
                name: state.username, rankName: 'Юнга', nextRankXP: 500,
                xp: 100, streak: 0, coins: state.coins,
                inventory: state.inventory, equipped: state.equipped
            });
        }
        if (event === 'joinOrCreateRoom') {
            // Сразу кидаем в лобби
            setTimeout(() => {
                this.trigger('roomUpdate', {
                    roomId: 'TEST01', status: 'LOBBY',
                    config: data.options || {dice:5, players:2, time:30},
                    players: [{ id: this.id, name: state.username, rank: 'Юнга', ready: true, isCreator: true, diceCount: 5, equipped: state.equipped }]
                });
            }, 500);
        }
        if (event === 'getProfile') {
            // Эмуляция запроса профиля
            setTimeout(() => {
                this.trigger('userProfile', {
                    id: data,
                    name: "Пират (Тест)",
                    rank: "Старший матрос",
                    matches: 42,
                    wins: 12,
                    inventory: ['skin_red', 'frame_gold', 'skin_black', 'frame_fire']
                });
            }, 300);
        }
        if (event === 'startGame') {
            // Запуск игры (эмуляция)
            this.trigger('gameEvent', { text: '🎲 РАУНД!', type: 'info' });
            this.trigger('yourDice', [1, 3, 4, 6, 6]);
            this.trigger('gameState', {
                players: [
                    { id: this.id, name: state.username, rank: 'Юнга', diceCount: 5, isTurn: true, equipped: state.equipped },
                    { id: 'bot1', name: 'Bot', rank: 'Матрос', diceCount: 5, isTurn: false, equipped: {} }
                ],
                currentBid: null, totalDuration: 30000, remainingTime: 30000,
                activeRules: { jokers: false, spot: false, strict: false }
            });
        }
    }
    trigger(event, data) {
        if (this.handlers[event]) this.handlers[event](data);
    }
}

// Используем MockSocket если реальный io не определен (или для теста)
const socket = (typeof io !== 'undefined' && !isPreview) ? io() : new MockSocket();

let state = {
    username: null, roomId: null,
    bidQty: 1, bidVal: 2, timerFrame: null,
    createDice: 5, createPlayers: 10, createTime: 30,
    rules: { jokers: false, spot: false, strict: false },
    pve: { difficulty: 'easy', bots: 3, dice: 5, jokers: false, spot: false, strict: false },
    coins: 0, inventory: [], equipped: {}
};

if (tg) { 
    try { tg.ready(); tg.expand(); tg.setHeaderColor('#5D4037'); tg.setBackgroundColor('#5D4037'); } catch(e){} 
}

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
    // Если есть данные от TG (или мока), сразу логинимся
    if (tg?.initDataUnsafe?.user) {
        state.username = tg.initDataUnsafe.user.first_name;
        loginSuccess();
    } else {
        // Фолбек, если вдруг что-то пошло не так
        setTimeout(() => {
            const loading = document.getElementById('screen-loading');
            if (loading && loading.classList.contains('active')) {
                showScreen('login');
            }
        }, 3000);
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
        // socket.tgUserId = 123; // Убрал лишнее, это должно на сервере обрабатываться
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

    // Обновляем магазин если открыт
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
    'frame_ice':     { name: 'Лед', price: 1200, type: 'frames' },
    'frame_neon':    { name: 'Неон', price: 2000, type: 'frames' },
    'frame_royal':   { name: 'Король', price: 5000, type: 'frames' },
    'frame_ghost':   { name: 'Призрак', price: 3000, type: 'frames' },
    'frame_kraken':  { name: 'Кракен', price: 4000, type: 'frames' },
    'frame_captain': { name: 'Капитанская', price: 10000, type: 'frames' },

    'bg_wood':    { name: 'Таверна', price: 0, type: 'bg' },
    'bg_blue':    { name: 'Океан', price: 300, type: 'bg' }
};

let currentShopTab = 'all';
window.filterShop = (type) => {
    currentShopTab = type;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`tab-${type}`);
    if(btn) btn.classList.add('active');
    renderShop();
};

function renderShop() {
    const grid = document.getElementById('shop-items');
    if(!grid) return;
    grid.innerHTML = '';
    
    for (const [id, meta] of Object.entries(ITEMS_META)) {
        if (currentShopTab !== 'all' && meta.type !== currentShopTab) continue;
        const owned = state.inventory.includes(id);
        const equipped = state.equipped.skin === id || state.equipped.bg === id || state.equipped.frame === id;
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
bindClick('btn-to-pve', () => showScreen('pve-settings'));
bindClick('btn-pve-back', () => showScreen('home'));

window.setDiff = (diff) => {
    state.pve.difficulty = diff;
    document.querySelectorAll('.btn-time').forEach(b => b.classList.remove('active')); 
    const container = document.querySelector('#screen-pve-settings .time-selector');
    if(container) {
        Array.from(container.children).forEach(btn => {
            if(btn.getAttribute('onclick').includes(`'${diff}'`)) btn.classList.add('active');
        });
    }
    const desc = { 'easy': '0 XP / 0 монет', 'medium': '10 XP / 10 монет', 'pirate': '40 XP / 40 монет' };
    const descEl = document.getElementById('diff-desc');
    if(descEl) descEl.textContent = desc[diff];
};

bindClick('btn-start-pve', () => {
    const userPayload = tg?.initDataUnsafe?.user || { id: 123, first_name: state.username };
    socket.emit('joinOrCreateRoom', { 
        roomId: null, tgUser: userPayload, 
        mode: 'pve',
        options: { 
            dice: state.pve.dice, 
            players: state.pve.bots + 1,
            jokers: state.pve.jokers, spot: state.pve.spot, strict: state.pve.strict,
            difficulty: state.pve.difficulty
        } 
    });
});

// --- SETTINGS ---
bindClick('btn-to-create', () => showScreen('create-settings'));
bindClick('btn-back-home', () => showScreen('home'));

window.setTime = (sec) => {
    state.createTime = sec;
    const container = document.querySelector('#screen-create-settings .time-selector');
    if (container) {
        Array.from(container.children).forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.textContent) === sec) btn.classList.add('active');
        });
    }
};

window.adjSetting = (type, delta) => {
    if (type === 'dice') {
        state.createDice = Math.max(1, Math.min(10, state.createDice + delta));
        state.pve.dice = state.createDice; 
        document.querySelectorAll('#set-dice, #pve-dice').forEach(el => el.textContent = state.createDice);
    } 
    else if (type === 'players') {
        state.createPlayers = Math.max(2, Math.min(10, state.createPlayers + delta));
        const el = document.getElementById('set-players'); if(el) el.textContent = state.createPlayers;
    }
    else if (type === 'bots') {
        state.pve.bots = Math.max(1, Math.min(9, state.pve.bots + delta));
        const el = document.getElementById('pve-bots'); if(el) el.textContent = state.pve.bots;
    }
};

bindClick('btn-confirm-create', () => {
    const userPayload = tg?.initDataUnsafe?.user || { id: 123, first_name: state.username };
    socket.emit('joinOrCreateRoom', { 
        roomId: null, tgUser: userPayload, 
        options: { 
            dice: state.createDice, players: state.createPlayers, time: state.createTime,
            jokers: state.rules.jokers, spot: state.rules.spot, strict: state.rules.strict
        } 
    });
});

window.toggleRule = (rule, isPve = false) => {
    const target = isPve ? state.pve : state.rules;
    target[rule] = !target[rule];
    const id = isPve ? (rule==='jokers'?'btn-rule-jokers-pve':`btn-rule-${rule}-pve`) : (rule==='jokers'?'btn-rule-jokers':`btn-rule-${rule}`);
    const btn = document.getElementById(id);
    if(btn) btn.classList.toggle('active', target[rule]);
};

// --- GAME ---
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

window.adjBid = (type, delta) => {
    if (type === 'qty') { state.bidQty = Math.max(1, state.bidQty + delta); document.getElementById('display-qty').textContent = state.bidQty; }
    else { state.bidVal = Math.max(1, Math.min(6, state.bidVal + delta)); document.getElementById('display-val').textContent = state.bidVal; }
};
bindClick('btn-make-bid', () => socket.emit('makeBid', { quantity: state.bidQty, faceValue: state.bidVal }));
bindClick('btn-call-bluff', () => socket.emit('callBluff'));
bindClick('btn-call-spot', () => socket.emit('callSpot'));
bindClick('btn-restart', () => socket.emit('requestRestart'));
bindClick('btn-home', () => location.reload());

// --- SOCKETS ---
window.sendEmote = (e) => { socket.emit('sendEmote', e); };
socket.on('emoteReceived', (data) => {
    const el = document.querySelector(`.player-chip[data-id='${data.id}']`);
    if (el) {
        const b = document.createElement('div');
        b.className = 'emote-bubble';
        b.textContent = data.emoji;
        
        const rect = el.getBoundingClientRect();
        b.style.left = (rect.left + rect.width / 2) + 'px';
        b.style.top = (rect.top - 20) + 'px';
        
        document.body.appendChild(b);
        setTimeout(() => b.remove(), 2000);
        if(tg) tg.HapticFeedback.selectionChanged();
    }
});

socket.on('errorMsg', (msg) => tg ? tg.showAlert(msg) : alert(msg));
socket.on('roomUpdate', (room) => {
    state.roomId = room.roomId;
    if (room.status === 'LOBBY') {
        showScreen('lobby');
        document.getElementById('lobby-room-id').textContent = room.roomId;
        if (room.config) document.getElementById('lobby-rules').textContent = `🎲${room.config.dice} 👤${room.config.players} ⏱️${room.config.time}с`;
        const list = document.getElementById('lobby-players'); list.innerHTML = '';
        room.players.forEach(p => {
            list.innerHTML += `<div class="player-item" data-id="${p.id}">
                <div><b>${p.name}</b><span class="rank-sub">${p.rank}</span></div>
                <span>${p.ready?'✅':'⏳'}</span>
            </div>`;
        });
        const me = room.players.find(p => p.id === socket.id);
        const startBtn = document.getElementById('btn-start-game');
        if (startBtn) startBtn.style.display = (me?.isCreator && room.players.length > 1) ? 'block' : 'none';
    }
});
socket.on('gameEvent', (evt) => {
    const log = document.getElementById('game-log');
    if(log) log.innerHTML = `<div>${evt.text}</div>`;
    if(evt.type === 'alert' && tg) tg.HapticFeedback.notificationOccurred('warning');
});
socket.on('yourDice', (dice) => {
    const skin = state.equipped.skin || 'skin_white';
    document.getElementById('my-dice').innerHTML = dice.map(d => `<div class="die ${skin}">${d}</div>`).join('');
});

socket.on('gameState', (gs) => {
    showScreen('game');
    let rulesText = '';
    if (gs.activeRules.jokers) rulesText += '🃏 Джокеры  ';
    if (gs.activeRules.spot) rulesText += '🎯 В точку';
    if (gs.activeRules.strict) rulesText += '🔒 Строго';
    document.getElementById('active-rules-display').textContent = rulesText;

    const bar = document.getElementById('players-bar');
    bar.innerHTML = gs.players.map(p => {
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
        const me = gs.players.find(p => p.id === socket.id);
        const myTurn = me?.isTurn;
        if (myTurn) {
            bid.innerHTML = `<div style="font-size:1.2rem; color:#ef233c; font-weight:bold;">Ваш ход! (Начните ставку)</div>`;
        } else {
            const turnPlayer = gs.players.find(p => p.isTurn);
            const name = turnPlayer ? turnPlayer.name : "Ожидание";
            bid.innerHTML = `<div style="font-size:1.2rem; color:#2b2d42; font-weight:bold;">Ходит: ${name}</div>`;
        }
        state.bidQty = 1; state.bidVal = 2; updateInputs();
    }

    const me = gs.players.find(p => p.id === socket.id);
    const myTurn = me?.isTurn;
    const controls = document.getElementById('game-controls');
    
    const spotBtn = document.getElementById('btn-call-spot');
    if (spotBtn) {
        if (gs.activeRules.spot) spotBtn.classList.remove('hidden-rule');
        else spotBtn.classList.add('hidden-rule');
    }

    if(myTurn) { 
        controls.classList.remove('hidden'); controls.classList.add('slide-up');
        document.getElementById('btn-call-bluff').disabled = !gs.currentBid; 
        if(spotBtn) spotBtn.disabled = !gs.currentBid;
        if(tg) tg.HapticFeedback.impactOccurred('medium'); 
    } else {
        controls.classList.add('hidden');
    }
    
    // ЗАПУСК ТАЙМЕРА (СИНХРОНИЗИРОВАННОГО)
    if (gs.remainingTime !== undefined && gs.totalDuration) {
        startVisualTimer(gs.remainingTime, gs.totalDuration);
    }
});

socket.on('roundResult', (data) => tg ? tg.showAlert(data.message) : alert(data.message));
socket.on('gameOver', (data) => {
    showScreen('result'); document.getElementById('winner-name').textContent = data.winner;
    if(tg) tg.HapticFeedback.notificationOccurred('success');
});

function updateInputs() { document.getElementById('display-qty').textContent = state.bidQty; document.getElementById('display-val').textContent = state.bidVal; }

function startVisualTimer(remaining, total) {
    if (state.timerFrame) cancelAnimationFrame(state.timerFrame);
    const bar = document.querySelector('.timer-progress'); if (!bar) return;
    
    const endTime = Date.now() + remaining; 

    function tick() {
        const now = Date.now(); 
        const left = endTime - now;
        
        if (left <= 0) { bar.style.width = '0%'; return; }
        
        const pct = (left / total) * 100; 
        bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
        bar.style.backgroundColor = pct < 30 ? '#ef233c' : '#06d6a0';
        
        state.timerFrame = requestAnimationFrame(tick);
    }
    tick();
}

// --- PROFILE MODAL ---
window.closeProfile = () => {
    document.getElementById('modal-profile').classList.remove('active');
};

document.body.addEventListener('click', (e) => {
    const chip = e.target.closest('.player-chip, .player-item');
    if (!chip) return;
    
    const id = chip.getAttribute('data-id');
    // Игнорируем ботов (обычно их ID начинаются с bot) и если нет ID
    if (!id || id.startsWith('bot') || id.startsWith('CPU_')) return;
    
    // Запрашиваем профиль
    socket.emit('getProfile', id);
});

socket.on('userProfile', (data) => {
    const m = document.getElementById('modal-profile');
    if (!m) return;
    
    document.getElementById('pub-name').textContent = data.name;
    document.getElementById('pub-rank-text').textContent = data.rank;
    document.getElementById('pub-matches').textContent = data.matches;
    document.getElementById('pub-wins').textContent = data.wins;
    
    const rate = data.matches > 0 ? Math.round((data.wins / data.matches) * 100) : 0;
    document.getElementById('pub-rate').textContent = rate + '%';
    
    let icon = '🧹';
    if (data.rank === 'Юнга') icon = '⚓';
    if (data.rank === 'Матрос') icon = '🌊';
    if (data.rank === 'Старший матрос') icon = '🎖️';
    if (data.rank === 'Боцман') icon = '💪';
    if (data.rank === 'Первый помощник') icon = '⚔️';
    if (data.rank === 'Капитан') icon = '☠️';
    if (data.rank === 'Легенда морей') icon = '🔱';
    document.getElementById('pub-rank-emoji').textContent = icon;
    
    const grid = document.getElementById('pub-inventory');
    grid.innerHTML = '';
    if (data.inventory && data.inventory.length > 0) {
        data.inventory.forEach(item => {
            let char = '?';
            // Упрощенная логика иконок для инвентаря
            if (item.startsWith('skin_')) char = '🎲';
            if (item.startsWith('frame_')) char = '🖼️';
            if (item.startsWith('bg_')) char = '🌄';
            grid.innerHTML += `<div class="mini-item">${char}</div>`;
        });
    } else {
        grid.innerHTML = '<div style="grid-column:1/-1; opacity:0.5; font-size:0.8rem; text-align: center;">Пусто</div>';
    }
    
    m.classList.add('active');
});
