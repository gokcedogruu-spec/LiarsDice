// Глобальный перехватчик ошибок
window.onerror = function(message, source, lineno, colno, error) {
    console.error("Error: " + message);
};

const socket = io();
const tg = window.Telegram?.WebApp;

// --- SYSTEM UI HELPERS ---
const ui = {
    modal: document.getElementById('modal-system'),
    title: document.getElementById('sys-title'),
    text: document.getElementById('sys-text'),
    input: document.getElementById('sys-input'),
    btns: document.getElementById('sys-btns'),
    close: function() { this.modal.classList.remove('active'); },
    show: function(titleStr, textStr, hasInput = false, buttonsHTML = '') {
        this.title.textContent = titleStr;
        this.text.textContent = textStr;
        if (hasInput) { this.input.classList.remove('hidden'); this.input.value = ''; setTimeout(() => this.input.focus(), 100); } 
        else { this.input.classList.add('hidden'); }
        this.btns.innerHTML = buttonsHTML;
        this.modal.classList.add('active');
    }
};
window.uiAlert = (text, title = "ВНИМАНИЕ") => {
    ui.show(title, text, false, `<button class="btn btn-blue" onclick="ui.close()">ПОНЯЛ</button>`);
    if(tg) tg.HapticFeedback.notificationOccurred('warning');
};
window.uiConfirm = (text, onYes) => {
    ui.show("ПОДТВЕРДИТЕ", text, false, `<button id="sys-btn-no" class="btn btn-gray">НЕТ</button><button id="sys-btn-yes" class="btn btn-red">ДА</button>`);
    document.getElementById('sys-btn-no').onclick = () => ui.close();
    document.getElementById('sys-btn-yes').onclick = () => { ui.close(); onYes(); };
    if(tg) tg.HapticFeedback.impactOccurred('medium');
};
window.uiPrompt = (text, onSubmit) => {
    ui.show("ВВОД", text, true, `<button id="sys-btn-cancel" class="btn btn-gray">ОТМЕНА</button><button id="sys-btn-ok" class="btn btn-green">ОК</button>`);
    document.getElementById('sys-btn-cancel').onclick = () => ui.close();
    document.getElementById('sys-btn-ok').onclick = () => { const val = ui.input.value.trim(); if(val) { ui.close(); onSubmit(val); } };
};

let state = {
    username: null, roomId: null,
    bidQty: 1, bidVal: 2, timerFrame: null,
    createDice: 5, createPlayers: 10, createTime: 30,
    rules: { jokers: false, spot: false, strict: false },
    currentRoomBets: { coins: 0, xp: 0 },
    pve: { difficulty: 'easy', bots: 3, dice: 5, jokers: false, spot: false, strict: false },
    coins: 0, inventory: [], equipped: {}
};

const COIN_STEPS = [0, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];
const XP_STEPS = [0, 100, 250, 500, 1000];

if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor('#5D4037'); tg.setBackgroundColor('#5D4037'); }

const screens = ['loading', 'login', 'home', 'create-settings', 'pve-settings', 'lobby', 'game', 'result', 'shop', 'cabin'];

function showScreen(name) {
    screens.forEach(s => { const el = document.getElementById(`screen-${s}`); if(el) el.classList.remove('active'); });
    const target = document.getElementById(`screen-${name}`);
    if(target) target.classList.add('active');
}

window.addEventListener('load', () => {
    setTimeout(() => {
        const loading = document.getElementById('screen-loading');
        if (loading && loading.classList.contains('active')) { if (!tg?.initDataUnsafe?.user) showScreen('login'); }
    }, 3000);
    if (tg?.initDataUnsafe?.user) { state.username = tg.initDataUnsafe.user.first_name; loginSuccess(); }
});

socket.on('connect', () => { if (state.username) loginSuccess(); });

function bindClick(id, handler) { const el = document.getElementById(id); if (el) el.addEventListener('click', handler); }

bindClick('btn-login', () => {
    const val = document.getElementById('input-username').value.trim();
    if (val) { state.username = val; socket.tgUserId = 123; loginSuccess(); }
});

function loginSuccess() {
    const userPayload = tg?.initDataUnsafe?.user || { id: 123, first_name: state.username, username: 'browser' };
    if (tg && tg.CloudStorage) {
        tg.CloudStorage.getItem('liarsDiceHardcore', (err, val) => {
            let savedData = null; try { if (val) savedData = JSON.parse(val); } catch (e) {}
            socket.emit('login', { tgUser: userPayload, savedData });
        });
    } else { socket.emit('login', { tgUser: userPayload, savedData: null }); }
}

// --- HATS DATA ---
const HATS_META = {
    'hat_fallen': { name: 'Шляпа падшей легенды', price: 1000000, rarity: 'rare' },
    'hat_rich': { name: 'Шляпа богатого капитана', price: 1000000, rarity: 'rare' },
    'hat_underwater': { name: 'Шляпа измученного капитана', price: 1000000, rarity: 'rare' },
    'hat_voodoo': { name: 'Шляпа знатока вуду', price: 1000000, rarity: 'rare' },
    'hat_king_voodoo': { name: 'Шляпа короля вуду', price: 10000000, rarity: 'legendary' },
    'hat_cursed': { name: 'Шляпа проклятого капитана', price: 10000000, rarity: 'legendary' },
    'hat_flame': { name: 'Шляпа обожжённого капитана', price: 10000000, rarity: 'legendary' },
    'hat_frozen': { name: 'Шляпа замерзшего капитана', price: 10000000, rarity: 'legendary' },
    'hat_ghost': { name: 'Шляпа потустороннего капитана', price: 10000000, rarity: 'legendary' },
    'hat_lava': { name: 'Шляпа плавающего по лаве', price: 100000000, rarity: 'mythical' },
    'hat_deadlycursed': { name: 'Шляпа коммодора флотилии теней', price: 100000000, rarity: 'mythical' },
    'hat_antarctica': { name: 'Шляпа покорителя южных морей', price: 100000000, rarity: 'mythical' }
};

function getRankImage(rankName, hatId = null) {
    const baseHat = 'https://raw.githubusercontent.com/gokcedogruu-spec/LiarsDice/main/textures/hats/';
    if (hatId && HATS_META[hatId]) {
        const map = {
            'hat_fallen': 'common/lvl7_fallen.png',
            'hat_rich': 'common/lvl7_richcaptain.png',
            'hat_underwater': 'common/lvl7_underwaterclassic.png',
            'hat_voodoo': 'common/lvl7_vodoo.png',
            'hat_king_voodoo': 'legendary/lvl7_king_voodoo.png',
            'hat_cursed': 'legendary/lvl8_cursed.png',
            'hat_flame': 'legendary/lvl8_flame.png',
            'hat_frozen': 'legendary/lvl8_frozen.png',
            'hat_ghost': 'legendary/lvl8_ghost.png',
            'hat_lava': 'mythical/lvl9_cursedflame.png',
            'hat_deadlycursed': 'mythical/lvl9_deadlycursed.png',
            'hat_antarctica': 'mythical/lvl9_kingofantarctica.png'
        };
        if(map[hatId]) return baseHat + map[hatId];
    }
    const baseRank = 'https://raw.githubusercontent.com/gokcedogruu-spec/LiarsDice/main/rating/';
    if (rankName === 'Салага') return baseRank + 'lvl1_salaga.png';
    if (rankName === 'Юнга') return baseRank + 'lvl1_yunga.png';
    if (rankName === 'Матрос') return baseRank + 'lvl2_moryak.png';
    if (rankName === 'Старший матрос') return baseRank + 'lvl3_starmoryak.png';
    if (rankName === 'Боцман') return baseRank + 'lvl4_bocman.png';
    if (rankName === 'Первый помощник') return baseRank + 'lvl5_perpomos.png';
    if (rankName === 'Капитан') return baseRank + 'lvl6_captain.png';
    if (rankName === 'Легенда морей') return baseRank + 'lvl7_goldencaptain.png';
    return baseRank + 'lvl1_salaga.png';
}

socket.on('profileUpdate', (data) => {
    if(document.getElementById('screen-loading')?.classList.contains('active') || 
       document.getElementById('screen-login')?.classList.contains('active')) { showScreen('home'); }
    
    document.getElementById('user-display').textContent = data.name;
    document.getElementById('rank-display').textContent = data.rankName;
    document.getElementById('win-streak').textContent = `Серия: ${data.streak} 🔥`;
    document.getElementById('user-coins').textContent = data.coins;
    
    state.coins = data.coins;
    state.inventory = data.inventory || [];
    state.equipped = data.equipped || {};

    const btnCabin = document.getElementById('btn-to-cabin');
    const btnShop = document.getElementById('btn-shop');
    
    if (data.rankLevel >= 6) { 
        btnCabin.style.display = 'block'; 
        btnShop.style.gridColumn = 'auto';
    } else {
        btnCabin.style.display = 'none';
        btnShop.style.gridColumn = 'span 2';
    }

    if (!document.getElementById('screen-game').classList.contains('active')) {
        document.body.className = data.equipped.bg || 'bg_default';
    }

    const profileCard = document.querySelector('.profile-card');
    if (profileCard) {
        profileCard.className = 'profile-card pop-in clickable-card';
        if (data.equipped.frame && data.equipped.frame !== 'frame_default') profileCard.classList.add(data.equipped.frame);
    }

    const rankImg = document.getElementById('rank-badge-img');
    if(rankImg) {
        rankImg.src = getRankImage(data.rankName, data.equipped.hat);
        rankImg.className = 'rank-img'; // Сброс классов
        
        if (data.equipped.hat && HATS_META[data.equipped.hat]) {
            const r = HATS_META[data.equipped.hat].rarity;
            // Добавляем классы для размера (определены в CSS)
            if (r === 'legendary') rankImg.classList.add('hat-legendary');
            if (r === 'mythical') rankImg.classList.add('hat-mythical');
            
            // Анимация
            if (r === 'legendary' || r === 'mythical') rankImg.classList.add('pulse-mythic');
        }
    }

    const next = (data.nextRankXP === 'MAX') ? data.xp : data.nextRankXP;
    let pct = 0;
    const currentMin = data.currentRankMin || 0;
    if (data.nextRankXP === 'MAX') { pct = 100; } 
    else {
        const totalRange = next - currentMin;
        if (totalRange > 0) pct = ((data.xp - currentMin) / totalRange) * 100;
    }
    document.getElementById('xp-fill').style.width = `${Math.min(100, Math.max(0, pct))}%`;
    const txt = document.getElementById('xp-text'); 
    txt.textContent = (data.nextRankXP === 'MAX') ? 'MAX' : `${data.xp} / ${next} XP`;

    if (tg && tg.CloudStorage) {
        tg.CloudStorage.setItem('liarsDiceHardcore', JSON.stringify({ 
            xp: data.xp, streak: data.streak, coins: data.coins, 
            wins: data.wins, matches: data.matches, inventory: data.inventory, equipped: data.equipped 
        }));
    }

    if (document.getElementById('screen-shop').classList.contains('active')) {
        document.getElementById('shop-coins').textContent = state.coins;
        renderShop();
    }
    if (document.getElementById('screen-cabin').classList.contains('active')) {
        document.getElementById('cabin-coins').textContent = state.coins;
        renderCabin();
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
    'frame_abyss':   { name: 'Бездна', price: 7500, type: 'frames' },
    'bg_default': { name: 'Стандарт', price: 0, type: 'bg' },
    'bg_lvl1':    { name: 'Палуба фрегата', price: 150000, type: 'bg' },
    'bg_lvl2':    { name: 'Палуба Летучего Голландца', price: 150000, type: 'bg' },
    'bg_lvl3':    { name: 'Палуба Черной Жемчужины', price: 150000, type: 'bg' },
    'bg_lvl4':    { name: 'Палуба старой шлюпки', price: 150000, type: 'bg' },
    'bg_lvl5':    { name: 'Палуба корабля-призрака', price: 500000, type: 'bg' }
};

let currentShopTab = 'skins'; 
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
        if (meta.type !== currentShopTab) continue; 
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
    else uiAlert("Не хватает монет!", "УПС...");
};
window.equipItem = (id) => socket.emit('shopEquip', id);

// --- CABIN (HATS) ---
bindClick('btn-to-cabin', () => {
    showScreen('cabin');
    document.getElementById('cabin-coins').textContent = state.coins;
    renderCabin();
});
bindClick('btn-cabin-back', () => showScreen('home'));

function renderCabin() {
    const grid = document.getElementById('cabin-items');
    if(!grid) return;
    grid.innerHTML = '';

    const groups = {
        'rare': 'Редкие',
        'legendary': 'Легендарные',
        'mythical': 'Мифические'
    };

    for (const [rarityKey, label] of Object.entries(groups)) {
        const hatsInGroup = Object.entries(HATS_META).filter(([id, meta]) => meta.rarity === rarityKey);
        
        if (hatsInGroup.length > 0) {
            grid.innerHTML += `<div class="cabin-category-title">${label}</div>`;
            
            hatsInGroup.forEach(([id, meta]) => {
                const owned = state.inventory.includes(id);
                const equipped = state.equipped.hat === id;
                const cssClass = `rarity-${meta.rarity}`;
                let imgUrl = getRankImage(null, id);
                
                let btnHTML = '';
                if (equipped) btnHTML = `<button class="shop-btn equipped" onclick="equipHat(null)">СНЯТЬ</button>`;
                else if (owned) btnHTML = `<button class="shop-btn equip" onclick="equipHat('${id}')">НАДЕТЬ</button>`;
                else btnHTML = `<button class="shop-btn buy" onclick="buyHat('${id}', ${meta.price})">КУПИТЬ (${meta.price.toLocaleString()})</button>`;

                grid.innerHTML += `
                    <div class="shop-item ${owned ? 'owned' : ''} ${cssClass}">
                        <img src="${imgUrl}" style="width:60px; height:60px; object-fit:contain; margin-bottom:5px;" class="${(meta.rarity==='legendary'||meta.rarity==='mythical')?'pulse-mythic':''}">
                        <h4 style="font-size:0.8rem;">${meta.name}</h4>
                        ${btnHTML}
                    </div>`;
            });
        }
    }
}

window.buyHat = (id, price) => {
    if (state.coins >= price) socket.emit('hatBuy', id);
    else uiAlert("Не хватает золота!", "УПС...");
};
window.equipHat = (id) => socket.emit('hatEquip', id);

// --- PVE, SETTINGS, ETC (No changes below, keep existing logic) ---
bindClick('btn-to-pve', () => showScreen('pve-settings'));
bindClick('btn-pve-back', () => showScreen('home'));
window.setDiff = (diff) => {
    state.pve.difficulty = diff;
    document.querySelectorAll('.btn-time').forEach(b => b.classList.remove('active')); 
    const container = document.querySelector('#screen-pve-settings .time-selector');
    if(container) { Array.from(container.children).forEach(btn => { if(btn.getAttribute('onclick').includes(`'${diff}'`)) btn.classList.add('active'); }); }
    const desc = { 'easy': '0 XP / 0 монет', 'medium': '10 XP / 10 монет', 'pirate': '40 XP / 40 монет' };
    document.getElementById('diff-desc').textContent = desc[diff];
};
bindClick('btn-start-pve', () => {
    socket.emit('joinOrCreateRoom', { roomId: null, tgUser: tg?.initDataUnsafe?.user || {id:123, first_name:state.username}, mode: 'pve', options: { dice: state.pve.dice, players: state.pve.bots + 1, jokers: state.pve.jokers, spot: state.pve.spot, strict: state.pve.strict, difficulty: state.pve.difficulty } });
});
bindClick('btn-to-create', () => showScreen('create-settings'));
bindClick('btn-back-home', () => showScreen('home'));
window.setTime = (sec) => {
    state.createTime = sec;
    const container = document.querySelector('#screen-create-settings .time-selector');
    if (container) { Array.from(container.children).forEach(btn => { btn.classList.remove('active'); if (parseInt(btn.textContent) === sec) btn.classList.add('active'); }); }
};
window.adjSetting = (type, delta) => {
    if (type === 'dice') { state.createDice = Math.max(1, Math.min(10, state.createDice + delta)); state.pve.dice = state.createDice; document.querySelectorAll('#set-dice, #pve-dice').forEach(el => el.textContent = state.createDice); } 
    else if (type === 'players') { state.createPlayers = Math.max(2, Math.min(10, state.createPlayers + delta)); document.getElementById('set-players').textContent = state.createPlayers; }
    else if (type === 'bots') { state.pve.bots = Math.max(1, Math.min(9, state.pve.bots + delta)); document.getElementById('pve-bots').textContent = state.pve.bots; }
};
bindClick('btn-confirm-create', () => {
    const betCoins = COIN_STEPS[document.getElementById('range-bet-coins').value];
    const betXp = XP_STEPS[document.getElementById('range-bet-xp').value];
    if((betCoins > 0 && betCoins > state.coins) || (betXp > 0 && betXp > state.xp)) { document.getElementById('modal-res-alert').classList.add('active'); return; }
    socket.emit('joinOrCreateRoom', { roomId: null, tgUser: tg?.initDataUnsafe?.user || {id:123, first_name:state.username}, options: { dice: state.createDice, players: state.createPlayers, time: state.createTime, jokers: state.rules.jokers, spot: state.rules.spot, strict: state.rules.strict, betCoins: betCoins, betXp: betXp } });
});
window.toggleRule = (rule, isPve = false) => {
    const target = isPve ? state.pve : state.rules;
    target[rule] = !target[rule];
    const id = isPve ? (rule==='jokers'?'btn-rule-jokers-pve':`btn-rule-${rule}-pve`) : (rule==='jokers'?'btn-rule-jokers':`btn-rule-${rule}`);
    document.getElementById(id).classList.toggle('active', target[rule]);
};
window.updateBetVal = (type) => {
    const val = parseInt(document.getElementById(`range-bet-${type}`).value);
    document.getElementById(`val-bet-${type}`).textContent = (type === 'coins') ? COIN_STEPS[val] : XP_STEPS[val];
};
window.closeResAlert = () => { document.getElementById('modal-res-alert').classList.remove('active'); };
window.requestMyStats = () => { socket.emit('getPlayerStats', 'me'); };
window.requestPlayerStats = (socketId) => { if (socketId && (socketId.toString().startsWith('bot') || socketId.toString().startsWith('CPU'))) { uiAlert("Это бот. У него нет души."); return; } socket.emit('getPlayerStats', socketId); };
socket.on('showPlayerStats', (data) => {
    const modal = document.getElementById('modal-player'); if (!modal) return;
    const content = modal.querySelector('.modal-content'); content.className = 'modal-content pop-in'; if (data.equipped.frame && data.equipped.frame !== 'frame_default') content.classList.add(data.equipped.frame);
    document.getElementById('info-name').textContent = data.name;
    document.getElementById('info-rank-name').textContent = data.rankName;
    document.getElementById('info-matches').textContent = data.matches;
    document.getElementById('info-wins').textContent = data.wins;
    document.getElementById('info-wr').textContent = (data.matches > 0 ? Math.round((data.wins / data.matches) * 100) : 0) + '%';
    const rankImg = document.getElementById('info-rank-img'); if(rankImg) rankImg.src = getRankImage(data.rankName, data.equipped?.hat);
    const invGrid = document.getElementById('info-inventory'); invGrid.innerHTML = '';
    const categories = { 'hats': 'Шляпы', 'skins': 'Кости', 'frames': 'Рамки', 'bg': 'Палуба' };
    const getType = (id) => { if(HATS_META[id]) return 'hats'; if(ITEMS_META[id]) return ITEMS_META[id].type; return null; };
    if (data.inventory && data.inventory.length > 0) {
        for (const [catKey, label] of Object.entries(categories)) {
            const items = data.inventory.filter(id => getType(id) === catKey);
            if (items.length > 0) {
                const header = document.createElement('div'); header.className = 'inv-category-title'; header.textContent = label; invGrid.appendChild(header);
                items.forEach(itemId => {
                    let name = '???', preview = '';
                    if (catKey === 'hats') { name = HATS_META[itemId].name; const url = getRankImage(null, itemId); preview = `<img src="${url}" style="width:30px;height:30px;object-fit:contain;">`; } 
                    else { const meta = ITEMS_META[itemId]; name = meta.name; if (meta.type === 'skins') preview = `<div class="inv-preview die ${itemId} face-6" style="width:30px;height:30px;"></div>`; else if (meta.type === 'frames') preview = `<div class="inv-preview player-chip ${itemId}" style="width:30px; height:30px;"></div>`; else if (meta.type === 'bg') preview = `<div class="inv-preview" style="background: #5D4037; border: 1px solid #aaa;"></div>`; }
                    invGrid.insertAdjacentHTML('beforeend', `<div class="inv-item">${preview}<span>${name}</span></div>`);
                });
            }
        }
    } else { invGrid.innerHTML = '<div style="grid-column:1/-1; opacity:0.5; font-size:0.8rem;">Пусто</div>'; }
    modal.classList.add('active');
});
window.closePlayerModal = (e) => { if (!e || e.target.id === 'modal-player' || e.target.classList.contains('btn-close')) { document.getElementById('modal-player').classList.remove('active'); } };
window.openRules = () => { document.getElementById('modal-rules').classList.add('active'); };
window.closeRules = (e) => { if (!e || e.target.id === 'modal-rules' || e.target.classList.contains('btn-close')) { document.getElementById('modal-rules').classList.remove('active'); } };
window.leaveLobby = () => { socket.emit('leaveRoom'); setTimeout(() => location.reload(), 100); };
window.leaveGame = () => { uiConfirm("Сдаться и покинуть игру? Вы потеряете ставку.", () => { socket.emit('leaveRoom'); setTimeout(() => location.reload(), 100); }); };
bindClick('btn-join-room', () => { uiPrompt("Введи код комнаты:", (code) => { const userPayload = tg?.initDataUnsafe?.user || { id: 123, first_name: state.username }; if(code) socket.emit('joinOrCreateRoom', { roomId: code.toUpperCase().trim(), tgUser: userPayload }); }); });
bindClick('share-btn', () => { const code = state.roomId; navigator.clipboard.writeText(code).then(() => uiAlert('Код скопирован!')).catch(() => { uiPrompt("Код комнаты (скопируй вручную):", () => {}); document.getElementById('sys-input').value = code; }); });
bindClick('btn-ready', function() { const isReady = this.textContent === "Я ГОТОВ"; socket.emit('setReady', isReady); this.textContent = isReady ? "НЕ ГОТОВ" : "Я ГОТОВ"; this.className = isReady ? "btn btn-green" : "btn btn-blue"; });
bindClick('btn-start-game', () => socket.emit('startGame'));
window.adjBid = (type, delta) => { if (type === 'qty') { state.bidQty = Math.max(1, state.bidQty + delta); document.getElementById('display-qty').textContent = state.bidQty; } else { state.bidVal = Math.max(1, Math.min(6, state.bidVal + delta)); document.getElementById('display-val').textContent = state.bidVal; } };
bindClick('btn-make-bid', () => socket.emit('makeBid', { quantity: state.bidQty, faceValue: state.bidVal }));
bindClick('btn-call-bluff', () => socket.emit('callBluff'));
bindClick('btn-call-spot', () => socket.emit('callSpot'));
bindClick('btn-restart', () => socket.emit('requestRestart'));
bindClick('btn-home', () => location.reload());
window.sendEmote = (e) => { socket.emit('sendEmote', e); };
socket.on('emoteReceived', (data) => { const el = document.querySelector(`.player-chip[data-id='${data.id}']`); if (el) { const img = document.createElement('img'); img.className = 'emote-bubble-img'; img.src = `https://raw.githubusercontent.com/gokcedogruu-spec/LiarsDice/main/emotions/default_${data.emoji}.png`; el.appendChild(img); setTimeout(() => { if(img.parentNode) img.remove(); }, 3000); if(tg) tg.HapticFeedback.selectionChanged(); } });
socket.on('skillResult', (data) => { const modal = document.getElementById('modal-skill-alert'); const iconEl = document.getElementById('skill-alert-title'); let icon = '⚡'; if (data.type === 'ears') icon = '👂'; else if (data.type === 'lucky') icon = '🎲'; else if (data.type === 'kill') icon = '🔫'; iconEl.textContent = icon; document.getElementById('skill-alert-text').textContent = data.text; modal.classList.add('active'); });
window.closeSkillAlert = () => { document.getElementById('modal-skill-alert').classList.remove('active'); };
socket.on('errorMsg', (msg) => { if (msg === 'NO_FUNDS') { document.getElementById('modal-res-alert').classList.add('active'); } else { uiAlert(msg, "ОШИБКА"); } });
socket.on('roomUpdate', (room) => { state.roomId = room.roomId; if (room.status === 'LOBBY') { showScreen('lobby'); document.getElementById('lobby-room-id').textContent = room.roomId; if (room.config) { document.getElementById('lobby-rules').textContent = `🎲${room.config.dice} 👤${room.config.players} ⏱️${room.config.time}с`; state.currentRoomBets = { coins: room.config.betCoins, xp: room.config.betXp }; let betStr = ''; if(room.config.betCoins > 0) betStr += `💰 ${room.config.betCoins}  `; if(room.config.betXp > 0) betStr += `⭐ ${room.config.betXp}`; document.getElementById('lobby-bets').textContent = betStr; } const list = document.getElementById('lobby-players'); list.innerHTML = ''; room.players.forEach(p => { list.innerHTML += `<div class="player-item" onclick="requestPlayerStats('${p.id}')"><div><b>${p.name}</b><span class="rank-sub">${p.rank}</span></div><span>${p.ready?'✅':'⏳'}</span></div>`; }); const me = room.players.find(p => p.id === socket.id); const startBtn = document.getElementById('btn-start-game'); if (startBtn) startBtn.style.display = (me?.isCreator && room.players.length > 1) ? 'block' : 'none'; } });
socket.on('gameEvent', (evt) => { const log = document.getElementById('game-log'); if(log) log.innerHTML = `<div>${evt.text}</div>`; if(evt.type === 'alert' && tg) tg.HapticFeedback.notificationOccurred('warning'); });
socket.on('yourDice', (dice) => { const skin = state.equipped.skin || 'skin_white'; document.getElementById('my-dice').innerHTML = dice.map(d => `<div class="die ${skin} face-${d}"></div>`).join(''); });
socket.on('gameState', (gs) => { showScreen('game'); document.body.className = gs.activeBackground || 'bg_default'; let rulesText = ''; if (gs.activeRules.jokers) rulesText += '🃏 Джокеры  '; if (gs.activeRules.spot) rulesText += '🎯 В точку'; if (gs.activeRules.strict) rulesText += '🔒 Строго'; document.getElementById('active-rules-display').textContent = rulesText; const bar = document.getElementById('players-bar'); const activeIds = new Set(gs.players.map(p => p.id)); gs.players.forEach(p => { let chip = bar.querySelector(`.player-chip[data-id="${p.id}"]`); const frameClass = p.equipped && p.equipped.frame ? p.equipped.frame : 'frame_default'; const turnClass = p.isTurn ? 'turn' : ''; const deadClass = p.isEliminated ? 'dead' : ''; const finalClass = `player-chip ${turnClass} ${deadClass} ${frameClass}`; if (!chip) { chip = document.createElement('div'); chip.setAttribute('data-id', p.id); chip.setAttribute('onclick', `requestPlayerStats('${p.id}')`); bar.appendChild(chip); chip.innerHTML = `<b>${p.name}</b><span class="rank-game">${p.rank}</span><div class="dice-count">🎲 ${p.diceCount}</div>`; } chip.className = finalClass; chip.querySelector('b').textContent = p.name; chip.querySelector('.rank-game').textContent = p.rank; chip.querySelector('.dice-count').textContent = `🎲 ${p.diceCount}`; }); Array.from(bar.children).forEach(child => { if (!activeIds.has(child.getAttribute('data-id'))) child.remove(); }); const bid = document.getElementById('current-bid-display'); if (gs.currentBid) { const bidder = gs.players.find(p => p.id === gs.currentBid.playerId); const skin = bidder?.equipped?.skin || 'skin_white'; bid.innerHTML = `<div class="bid-container"><div class="bid-qty">${gs.currentBid.quantity}<span class="bid-x">x</span></div><div class="die ${skin} face-${gs.currentBid.faceValue} bid-die-icon"></div></div>`; state.bidQty = gs.currentBid.quantity; state.bidVal = gs.currentBid.faceValue; updateInputs(); } else { const me = gs.players.find(p => p.id === socket.id); if (me?.isTurn) { bid.innerHTML = `<div style="font-size:1.2rem; color:#ef233c; font-weight:bold;">Ваш ход! (Начните ставку)</div>`; } else { const turnPlayer = gs.players.find(p => p.isTurn); const name = turnPlayer ? turnPlayer.name : "Ожидание"; bid.innerHTML = `<div style="font-size:1.2rem; color:#2b2d42; font-weight:bold;">Ходит: ${name}</div>`; } state.bidQty = 1; state.bidVal = 2; updateInputs(); } const me = gs.players.find(p => p.id === socket.id); const myTurn = me?.isTurn; const controls = document.getElementById('game-controls'); const spotBtn = document.getElementById('btn-call-spot'); if (spotBtn) { if (gs.activeRules.spot) spotBtn.classList.remove('hidden-rule'); else spotBtn.classList.add('hidden-rule'); } const existingSkills = document.querySelector('.skills-bar'); if(existingSkills) existingSkills.remove(); if (me && me.availableSkills && me.availableSkills.length > 0 && !me.isEliminated) { const skillsDiv = document.createElement('div'); skillsDiv.className = 'skills-bar'; me.availableSkills.forEach(skill => { const btn = document.createElement('button'); btn.className = `btn-skill skill-${skill}`; btn.setAttribute('onclick', `useSkill('${skill}')`); skillsDiv.appendChild(btn); }); document.querySelector('.my-controls-area').insertBefore(skillsDiv, controls); } if(myTurn) { controls.classList.remove('hidden'); controls.classList.add('slide-up'); document.getElementById('btn-call-bluff').disabled = !gs.currentBid; if(spotBtn) spotBtn.disabled = !gs.currentBid; if(tg) tg.HapticFeedback.impactOccurred('medium'); } else { controls.classList.add('hidden'); } if (gs.remainingTime !== undefined && gs.totalDuration) { startVisualTimer(gs.remainingTime, gs.totalDuration); } });
window.useSkill = (skillType) => { socket.emit('useSkill', skillType); };
socket.on('roundResult', (data) => uiAlert(data.message, "ИТОГ"));
socket.on('gameOver', (data) => { showScreen('result'); document.getElementById('winner-name').textContent = data.winner; const isWinner = (data.winner === state.username); const profitEl = document.getElementById('result-profit'); if (state.currentRoomBets.coins > 0 || state.currentRoomBets.xp > 0) { if (isWinner) { let txt = 'Выигрыш: '; if(state.currentRoomBets.coins) txt += `+${state.currentRoomBets.coins}💰 `; if(state.currentRoomBets.xp) txt += `+${state.currentRoomBets.xp}⭐`; profitEl.textContent = txt; profitEl.style.color = '#06d6a0'; } else { let txt = 'Потеряно: '; if(state.currentRoomBets.coins) txt += `-${state.currentRoomBets.coins}💰 `; if(state.currentRoomBets.xp) txt += `-${state.currentRoomBets.xp}⭐`; profitEl.textContent = txt; profitEl.style.color = '#ef233c'; } } else { profitEl.textContent = ''; } if(tg) tg.HapticFeedback.notificationOccurred('success'); });
function updateInputs() { document.getElementById('display-qty').textContent = state.bidQty; document.getElementById('display-val').textContent = state.bidVal; }
function startVisualTimer(remaining, total) { if (state.timerFrame) cancelAnimationFrame(state.timerFrame); const bar = document.querySelector('.timer-progress'); if (!bar) return; if (remaining <= 0 || !total) { bar.style.width = '0%'; return; } const endTime = Date.now() + remaining; function tick() { const now = Date.now(); const left = endTime - now; if (left <= 0) { bar.style.width = '0%'; return; } const pct = (left / total) * 100; bar.style.width = `${Math.min(100, Math.max(0, pct))}%`; if (pct < 25) bar.style.backgroundColor = '#ef233c'; else if (pct < 50) bar.style.backgroundColor = '#ffb703'; else bar.style.backgroundColor = '#06d6a0'; state.timerFrame = requestAnimationFrame(tick); } tick(); }
