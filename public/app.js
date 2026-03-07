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
        this.text.innerHTML = textStr;
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

window.openHatInfo = (hatId, mode = 'both') => {
    const hatMeta = HATS_META[hatId];
    const skill = HAT_SKILLS[hatId];

    if (!skill) {
        uiAlert('Характеристики этой шляпы ещё не описаны.', 'ШЛЯПА');
        return;
    }

    let html = '';

    if (mode === 'both' || mode === 'passive') {
        html += `<b>${skill.passiveTitle || 'Пассивный эффект'}</b><br>${(skill.passiveDesc || '').replace(/\n/g,'<br>')}<br><br>`;
    }
    if (mode === 'both' || mode === 'active') {
        html += `<b>${skill.activeTitle || 'Активный навык'}</b><br>${(skill.activeDesc || '').replace(/\n/g,'<br>')}`;
    }

    ui.show(
        hatMeta ? hatMeta.name : 'Шляпа',
        html,
        false,
        `<button class="btn btn-blue" onclick="ui.close()">ПОНЯЛ</button>`
    );
};

// --- EMOJI LOGIC ---

// 1. Функция переключения (Открыть/Закрыть)
window.toggleEmojiPanel = () => {
    const panel = document.getElementById('emoji-panel');
    // Если есть класс hidden - убираем (показываем), если нет - добавляем (скрываем)
    if (panel.classList.contains('hidden')) {
        panel.classList.remove('hidden');
    } else {
        panel.classList.add('hidden');
    }
};

// 2. Отправить и закрыть
window.sendEmoteAndClose = (name) => {
    socket.emit('sendEmote', name); 
    document.getElementById('emoji-panel').classList.add('hidden'); 
    if(tg) tg.HapticFeedback.selectionChanged();
};

// 3. Закрыть при клике в пустоту (ИСПРАВЛЕНО)
document.addEventListener('click', (e) => {
    const panel = document.getElementById('emoji-panel');
    const btn = document.querySelector('.btn-emoji-toggle');

    // Если панели или кнопки нет - выходим
    if (!panel || !btn) return;

    // Проверяем:
    // 1. Панель открыта?
    // 2. Клик был НЕ внутри панели?
    // 3. Клик был НЕ по кнопке (и не по картинке внутри кнопки)?
    if (!panel.classList.contains('hidden') && 
        !panel.contains(e.target) && 
        !btn.contains(e.target)) {
        
        panel.classList.add('hidden');
    }
});

let state = {
    username: null, roomId: null, myId: null,
    bidQty: 1, bidVal: 2, timerFrame: null,
    createDice: 5, createPlayers: 10, createTime: 30,
    rules: { jokers: false, spot: false, strict: false, crazy: false },
    currentRoomBets: { coins: 0, xp: 0 },
    pve: { difficulty: 'medium', bots: 3, dice: 5, jokers: false, spot: false, strict: false, crazy: false },
    coins: 0, inventory: [], equipped: {}, // ДОБАВИЛ ЗАПЯТУЮ ТУТ
    lastRoomId: localStorage.getItem('lastRoomId') || null,
    tutorialStep: 0
};

// Добавил 'reconnect' в список
const screens = ['loading', 'login', 'home', 'create-settings', 'pve-settings', 'lobby', 'game', 'result', 'shop', 'cabin', 'reconnect', 'tutorial'];
const COIN_STEPS = [0, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];
const XP_STEPS = [0, 100, 250, 500, 1000];

if (tg) { tg.ready(); tg.expand(); tg.setHeaderColor('#5D4037'); tg.setBackgroundColor('#5D4037'); }

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

socket.on('connect', () => { 
    console.log("✅ Соединение установлено!");
    document.getElementById('screen-reconnect').classList.remove('active');
    
    if (state.username) {
        loginSuccess(); // Авто-логин при восстановлении связи
    }
});

socket.on('disconnect', () => {
    console.log("❌ Соединение потеряно...");
    // Показываем экран переподключения, если мы были в игре или лобби
    if (state.roomId) {
        document.getElementById('screen-reconnect').classList.add('active');
    }
});

function bindClick(id, handler) { const el = document.getElementById(id); if (el) el.addEventListener('click', handler); }

bindClick('btn-login', () => {
    const val = document.getElementById('input-username').value.trim();
    if (val) { state.username = val; socket.tgUserId = 123; loginSuccess(); }
});
function loginSuccess() {
    const userPayload = tg?.initDataUnsafe?.user || { id: 123, first_name: state.username, username: 'browser' };
    const startParam = tg?.initDataUnsafe?.start_param;
    const savedRoomId = localStorage.getItem('lastRoomId');

    const handleLogin = (savedData = null) => {
        socket.emit('login', { tgUser: userPayload, savedData });
        socket.emit('friendAction', { action: 'get' });

        // Если зашли по ссылке приглашения
        if (startParam && startParam !== "") {
            setTimeout(() => {
                uiConfirm(`Войти в комнату ${startParam}?`, () => {
                    socket.emit('joinOrCreateRoom', { roomId: startParam, tgUser: userPayload });
                });
            }, 800);
        } 
        // Если просто вернулись в приложение (после шаринга)
        else if (savedRoomId && savedRoomId !== "null" && savedRoomId !== "undefined") {
            console.log("🔄 Возвращаемся в комнату:", savedRoomId);
            // Добавляем задержку 500мс, чтобы сервер успел обработать логин
            setTimeout(() => {
                socket.emit('joinOrCreateRoom', { roomId: savedRoomId, tgUser: userPayload });
            }, 500);
        }
    };

    if (tg && tg.CloudStorage) {
        tg.CloudStorage.getItem('liarsDiceHardcore', (err, val) => {
            let savedData = null; 
            try { if (val) savedData = JSON.parse(val); } catch (e) {}
            handleLogin(savedData);
        });
    } else { 
        handleLogin(null);
    }
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
    'hat_poison': { name: 'Шляпа отравленного капитана', price: 10000000, rarity: 'legendary' },
    'hat_lava': { name: 'Шляпа плавающего по лаве', price: 100000000, rarity: 'mythical' },
    'hat_deadlycursed': { name: 'Шляпа коммодора флотилии теней', price: 100000000, rarity: 'mythical' },
    'hat_antarctica': { name: 'Шляпа покорителя южных морей', price: 100000000, rarity: 'mythical' },
    'hat_miasmas': { name: 'Шляпа дышащей миазмами', price: 100000000, rarity: 'mythical' }
};
    const HAT_SKILLS = {
    'hat_rich': {
        passiveTitle: 'Казначей',
        passiveDesc:
            'Первые несколько поражений по ставке забирают МЕНЬШЕ монет.\n' +
            'XP-штраф остаётся обычным.\n' +
            'Идеально для любителей крупных банков.',
        activeTitle: 'Золотой сундук',
        activeDesc:
            '1 раз за матч: объявить "Золотой сундук".\n' +
            'Если выиграешь матч — монетная награда за него увеличена.\n' +
            'Если проиграешь матч — монетный штраф сильнее обычного.'
    },

    'hat_fallen': {
        passiveTitle: 'Упавшая легенда',
        passiveDesc:
            'Стрик никогда не падает до нуля — вместо этого делится пополам.\n' +
            'Пример: было 23 → после поражения станет 11.',
        activeTitle: 'Второй шанс',
        activeDesc:
            '1 раз за матч: при вылете (0 кубов) не покидать игру,\n' +
            'а вернуться с 1 кубиком.\n' +
            'При этом награда XP за матч заметно уменьшается.'
    },

    'hat_underwater': {
        passiveTitle: 'Дыхание под водой',
        passiveDesc:
            'Твой первый таймаут за матч не выбрасывает тебя из игры.\n' +
            'Вместо вылета ты просто теряешь 1 куб и продолжаешь играть.',
        activeTitle: 'Глоток воздуха',
        activeDesc:
            '1 раз за матч: удвоить время хода только для себя.\n' +
            'Если даже с удвоенным таймером не успеваешь походить —\n' +
            'мгновенный вылет по таймауту без снижения штрафов.'
    },

    'hat_voodoo': {
        passiveTitle: 'Шёпот костей',
        passiveDesc:
            'При чужих ставках иногда слышен шёпот костей.\n' +
            'С небольшим шансом подсказывает, похожа ли ставка на правду\n' +
            'или тянет на блеф.\n' +
            'Подсказки могут быть неточными!',
        activeTitle: 'Проклятье языка',
        activeDesc:
            '1 раз за матч, при существующей ставке: наложить проклятье\n' +
            'на игрока, который сделал текущую ставку.\n' +
            'В этом раунде он НЕ может повышать ставку — только\n' +
            '"НЕ ВЕРЮ!" или "В ТОЧКУ" (если режим разрешает).'
    },

    'hat_king_voodoo': {
        passiveTitle: 'Король проклятий',
        passiveDesc:
            'Каждый успешный "НЕ ВЕРЮ!" (кем бы он ни был сказан)\n' +
            'питает твою магию и слегка повышает будущую монетную награду.\n' +
            'Бонус небольшой и накапливается ограниченно.',
        activeTitle: 'Кукла вуду',
        activeDesc:
            '1 раз за матч: выбрать жертву.\n' +
            'Один её куб в текущем раунде становится "связанным":\n' +
            'он не считается ни джокером, ни как любая грань при вскрытии.\n' +
            'Сильное и очень коварное искажение математики раунда.'
    },

    'hat_cursed': {
        passiveTitle: 'Живи опасно',
        passiveDesc:
            'Победы приносят больше XP, чем обычно.\n' +
            'Но любое поражение бьёт сильнее: штраф XP заметно выше.\n' +
            'Играешь на повышенных ставках опыта.',
        activeTitle: 'Проклятый банк',
        activeDesc:
            '1 раз за матч: проклясть общий банк.\n' +
            'Награды и штрафы этого матча становятся жёстче для всех.\n' +
            'Особенно больно будет тому, кто вылетит первым.'
    },

    'hat_flame': {
        passiveTitle: 'Горячий стиль',
        passiveDesc:
            'Если ты несколько раз подряд ходишь достаточно быстро\n' +
            'и при этом не теряешь кубы, в конце матча получаешь\n' +
            'небольшой монетный бонус.\n' +
            'Награда за уверенную и быструю игру.',
        activeTitle: 'Пылающий вызов',
        activeDesc:
            '1 раз за матч: разжечь страсти за столом.\n' +
            'В текущем раунде каждый, кто скажет "НЕ ВЕРЮ!" и ошибётся,\n' +
            'теряет дополнительный куб (если он есть).\n' +
            'Включая тебя, если риск не оправдался.'
    },

    'hat_frozen': {
        passiveTitle: 'Лёд в жилах',
        passiveDesc:
            'Один раз за матч, когда ты должен вылететь (0 кубов),\n' +
            'вместо вылета остаёшься в игре с 1 кубиком.\n' +
            'Следующий ход — только ставка, без навыков и фокусов.',
        activeTitle: 'Ледяной шок',
        activeDesc:
            '1 раз за матч: "охладить" противника.\n' +
            'В его следующий ход таймер уменьшается примерно вдвое.\n' +
            'Если он успеет походить — получает небольшой бонус XP.\n' +
            'Если нет — обычный вылет по таймауту.'
    },

    'hat_ghost': {
        passiveTitle: 'Призрачный взгляд',
        passiveDesc:
            'В начале каждого раунда ты краем глаза видишь\n' +
            'один случайный куб одного случайного противника.\n' +
            'Мелкая, но очень приятная подсказка.',
        activeTitle: 'Видение конца',
        activeDesc:
            '1 раз за матч: выбрать грань (2–6) и увидеть,\n' +
            'сколько таких костей прямо сейчас на столе (с учётом правил).\n' +
            'Очень сильная информация — используй с умом.'
    },

    'hat_poison': {
        passiveTitle: 'Токсичная аура',
        passiveDesc:
            'Если надет куб "Яд", максимум его стаков эффекта увеличен,\n' +
            'но штрафы за поражения начинают расти раньше.\n' +
            'Играть становится ещё более рискованно.',
        activeTitle: 'Отравленный куб',
        activeDesc:
            '1 раз за матч: отравить куб выбранного игрока на этот раунд.\n' +
            'Если он проиграет раунд — теряет дополнительно 1 куб.\n' +
            'Если выиграет — яд обращается против тебя, ты теряешь 1 куб.'
    },

    'hat_lava': {
        passiveTitle: 'Огненная выносливость',
        passiveDesc:
            'В первых партиях с этой шляпой ты немного защищён\n' +
            'от чересчур жёстких потерь кубов из-за ставок и блефа.\n' +
            'Не спасает от таймаута и самоубийственных навыков.',
        activeTitle: 'Огненный шторм',
        activeDesc:
            '1 раз за матч: вызвать огненный шторм.\n' +
            'У всех игроков случайным образом перебрасывается по одному кубу.\n' +
            'Твои новые значения чуть чаще оказываются выгодными.'
    },

    'hat_deadlycursed': {
        passiveTitle: 'Тень над столом',
        passiveDesc:
            'Каждый раз, когда кто-то вылетает из матча,\n' +
            'ты получаешь небольшой бонус XP.\n' +
            'Чем кровавее партия, тем приятнее тебе.',
        activeTitle: 'Теневой выстрел',
        activeDesc:
            '1 раз за матч: сделать "теневой выстрел".\n' +
            'У выбранного игрока один куб как бы исчезает на этот раунд,\n' +
            'а у тебя временно появляется дополнительный куб.\n' +
            'После раунда всё возвращается в норму.'
    },

    'hat_antarctica': {
        passiveTitle: 'Ледяной фронт',
        passiveDesc:
            'В играх против ботов первые раунды они чуть осторожнее\n' +
            'оценивают ставки и блеф.\n' +
            'Это упрощает агрессивную игру в начале.',
        activeTitle: 'Метель',
        activeDesc:
            '1 раз за матч: вызвать метель.\n' +
            'Все игроки перебрасывают все свои кубы целиком.\n' +
            'Ты же помнишь и старые, и новые значения своих костей.'
    },

    'hat_miasmas': {
        passiveTitle: 'Заражённый стол',
        passiveDesc:
            'Все игроки играют как будто в более жёстком режиме:\n' +
            'штрафы за поражения немного выше, награды за победы чуть больше.\n' +
            'Токсичная атмосфера всем, но тебе — в радость.',
        activeTitle: 'Туча миазм',
        activeDesc:
            '1 раз за матч: накрыть стол тучей миазм.\n' +
            'В этом раунде каждый проигравший раунд теряет\n' +
            'дополнительный куб (у ботов шанс смягчить удар).\n' +
            'Партия может резко ускориться.'
    }
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
            'hat_poison': 'legendary/lvl8_poison_.png',
            'hat_lava': 'mythical/lvl9_cursedflame.png',
            'hat_deadlycursed': 'mythical/lvl9_deadlycursed.png',
            'hat_antarctica': 'mythical/lvl9_kingofantarctica.png',
            'hat_miasmas': 'mythical/lvl9_snakehead.png'
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
    state.myId = data.id;
    if(document.getElementById('screen-loading')?.classList.contains('active') || 
       document.getElementById('screen-login')?.classList.contains('active')) { showScreen('home'); }
    
    document.getElementById('user-display').textContent = data.name;
    document.getElementById('rank-display').textContent = data.rankName;
    document.getElementById('win-streak').textContent = `Серия: ${data.streak} 🔥`;
    document.getElementById('user-coins').textContent = data.coins;
    
    state.coins = data.coins;
    state.xp = data.xp;
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
        rankImg.className = 'rank-img';
        
        if (data.equipped.hat && HATS_META[data.equipped.hat]) {
            const r = HATS_META[data.equipped.hat].rarity;
            if (r === 'legendary') rankImg.classList.add('hat-legendary');
            if (r === 'mythical') rankImg.classList.add('hat-mythical');
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
            wins: data.wins, matches: data.matches, inventory: data.inventory, equipped: data.equipped,
            friends: friendDataCache.friends.map(f => f.id),
            requests: friendDataCache.requests.map(r => r.id)
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
    'skin_red':   { name: 'Рубин', price: 5000, type: 'skins' },
    'skin_gold':  { name: 'Золото', price: 6500, type: 'skins' },
    'skin_black': { name: 'Черная метка', price: 6500, type: 'skins' },
    'skin_blue':  { name: 'Морской', price: 10000, type: 'skins' },
    'skin_green': { name: 'Яд', price: 15000, type: 'skins' },
    'skin_purple':{ name: 'Магия вуду', price: 25000, type: 'skins' },
    'skin_bone':  { name: 'Костяной', price: 25000, type: 'skins' },
    'frame_default': { name: 'Нет рамки', price: 0, type: 'frames' },
    'frame_wood':    { name: 'Дерево', price: 2500, type: 'frames' },
    'frame_silver':  { name: 'Серебро', price: 5000, type: 'frames' },
    'frame_gold':    { name: 'Золото', price: 5000, type: 'frames' },
    'frame_fire':    { name: 'Огонь', price: 7500, type: 'frames' },
    'frame_ice':     { name: 'Лед', price: 7500, type: 'frames' },
    'frame_neon':    { name: 'Неон', price: 7500, type: 'frames' },
    'frame_royal':   { name: 'Король', price: 10000, type: 'frames' },
    'frame_ghost':   { name: 'Призрак', price: 10000, type: 'frames' },
    'frame_kraken':  { name: 'Кракен', price: 15000, type: 'frames' },
    'frame_captain': { name: 'Капитанская', price: 20000, type: 'frames' },
    'frame_abyss':   { name: 'Бездна', price: 25000, type: 'frames' },
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
    if (!grid) return;

    grid.innerHTML = '';

    for (const [id, meta] of Object.entries(ITEMS_META)) {
        if (meta.type !== currentShopTab) continue;

        const owned = state.inventory.includes(id);
        const equipped =
            state.equipped.skin === id ||
            state.equipped.bg === id ||
            state.equipped.frame === id;

        let previewHTML = '';
        if (meta.type === 'skins') {
            previewHTML = `<div class="shop-preview-die die ${id} face-6"></div>`;
        } else if (meta.type === 'frames') {
            previewHTML = `<div class="shop-preview-frame ${id}">👤</div>`;
        } else if (meta.type === 'bg') {
            previewHTML = `<div class="shop-preview-bg ${id}"></div>`;
        }

        let btnHTML = '';
        if (equipped) {
            btnHTML = `<button class="shop-btn equipped">НАДЕТО</button>`;
        } else if (owned) {
            btnHTML = `<button class="shop-btn equip" onclick="equipItem('${id}')">НАДЕТЬ</button>`;
        } else {
            btnHTML = `<button class="shop-btn buy" onclick="buyItem('${id}', ${meta.price})">КУПИТЬ (${meta.price})</button>`;
        }

        grid.innerHTML += `
            <div class="shop-item ${owned ? 'owned' : ''}">
                <div class="shop-preview-box">${previewHTML}</div>
                <h4>${meta.name}</h4>
                ${btnHTML}
            </div>
        `;
    }
}

bindClick('btn-shop', () => { showScreen('shop'); document.getElementById('shop-coins').textContent = state.coins; renderShop(); });
bindClick('btn-shop-back', () => showScreen('home'));
window.buyItem = (id, price) => { if (state.coins >= price) socket.emit('shopBuy', id); else uiAlert("Не хватает монет!", "УПС..."); };
window.equipItem = (id) => socket.emit('shopEquip', id);

// --- LEADERBOARD ---
window.openLeaderboard = () => {
    document.getElementById('modal-leaderboard').classList.add('active');
    document.getElementById('leaderboard-list').innerHTML = '<div style="text-align:center; margin-top:20px;">Загрузка...</div>';
    socket.emit('getLeaderboard');
};

window.closeLeaderboard = (e) => {
    if (!e || e.target.id === 'modal-leaderboard' || e.target.classList.contains('btn-close')) {
        document.getElementById('modal-leaderboard').classList.remove('active');
    }
};

socket.on('leaderboardData', (list) => {
    const container = document.getElementById('leaderboard-list');
    container.innerHTML = '';
    
    if (!list || list.length === 0) {
        container.innerHTML = '<div style="text-align:center; opacity:0.5; margin-top:20px;">Пусто...</div>';
        return;
    }

    list.forEach(p => {
        let rankClass = '';
        if (p.rank === 1) rankClass = 'top-1';
        if (p.rank === 2) rankClass = 'top-2';
        if (p.rank === 3) rankClass = 'top-3';

        // Иконка ранга (не картинка, а просто текст или эмодзи, чтобы не грузить)
        // Но мы можем использовать класс p.rankName
        
        container.innerHTML += `
            <div class="lb-row" onclick="requestPlayerStats('${p.id}')">
                <div class="lb-rank ${rankClass}">${p.rank}</div>
                <div class="lb-name-box">
                    <span class="lb-name ${p.frame}">${p.name}</span>
                    <span class="lb-sub">${p.rankName}</span>
                </div>
                <div class="lb-stat lb-xp">${p.xp}</div>
                <div class="lb-stat lb-win">${p.wins}</div>
            </div>
        `;
    });
});

// --- SHARE FUNCTION ---
window.shareRoomNative = () => {
    // Проверяем, есть ли WebApp и ID комнаты
    if (window.Telegram?.WebApp && state.roomId) {
        // Открывает нативный выбор чата в Telegram
        // Вставляет текст: @bot_name ROOM_ID
        window.Telegram.WebApp.switchInlineQuery(state.roomId, ['users', 'groups']); 
    } else {
        // Если открыто в браузере — просто копируем код
        navigator.clipboard.writeText(state.roomId)
            .then(() => uiAlert('Код скопирован!'))
            .catch(() => uiAlert('Ошибка копирования'));
    }
};

// --- CABIN ---
bindClick('btn-to-cabin', () => { showScreen('cabin'); document.getElementById('cabin-coins').textContent = state.coins; renderCabin(); });
bindClick('btn-cabin-back', () => showScreen('home'));

function renderCabin() {
    const grid = document.getElementById('cabin-items');
    if(!grid) return;
    grid.innerHTML = '';
    const groups = { 'rare': 'Редкие', 'legendary': 'Легендарные', 'mythical': 'Мифические' };
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
        <img src="${imgUrl}"
             style="width:60px; height:60px; object-fit:contain; margin-bottom:5px; cursor:pointer;"
             class="${(meta.rarity==='legendary'||meta.rarity==='mythical')?'pulse-mythic':''}"
             onclick="openHatInfoFromCabin('${id}')">
        <h4 style="font-size:0.8rem;">${meta.name}</h4>
        ${btnHTML}
    </div>
`;
            });
        }
    }
}
window.buyHat = (id, price) => { if (state.coins >= price) socket.emit('hatBuy', id); else uiAlert("Не хватает золота!", "УПС..."); };
window.equipHat = (id) => socket.emit('hatEquip', id);
window.openHatInfoFromCabin = (hatId) => {
    const owned = state.inventory.includes(hatId);
    if (!owned) {
        uiAlert("Характеристики ещё не разблокированы", "ШЛЯПА");
        return;
    }
    openHatInfo(hatId, 'both'); // твоя уже существующая функция
};

// --- ENCYCLOPEDIA ---
const ENCYCLOPEDIA_DATA = {
    'skin_gold': { name: 'Золото', desc: '<b>+15% Монет</b> за победу.<br><b>-10% XP</b> за победу.' },
    'skin_black': { name: 'Черная метка', desc: '<b>-10% Монет</b> за победу.<br><b>+15% XP</b> за победу.' },
    'skin_red': { name: 'Рубин', desc: '<b>+4% от среднего заработка</b> за каждые 5 побед подряд.<br><b>-5% XP</b> дополнительно при проигрыше.' },
    'skin_blue': { name: 'Морской', desc: '<b>-20% штрафа</b> (XP и Монет) при проигрыше.<br>Нет бонуса за серию побед.' },
    'skin_green': { name: 'Яд', desc: '<b>+1%</b> к награде за каждую победу подряд (макс 20%).<br><b>+1%</b> к штрафу за каждое поражение подряд (макс 20%).<br>Нет глобального бонуса (10 побед) и утешения.' },
    'skin_purple': { name: 'Магия вуду', desc: '<b>10% шанс</b> удвоить выигрыш.<br><b>10% шанс</b> потерять весь выигрыш.' },
    'skin_bone': { name: 'Костяной', desc: '<b>20% шанс</b> вернуть 10% ставки при проигрыше.<br>Вход в игру на <b>5% дороже</b>.' }
};

window.openEncyclopedia = () => {
    const modal = document.getElementById('modal-encyclopedia');
    const content = document.getElementById('encyclopedia-content');
    content.innerHTML = '';
    let hasEntries = false;
    state.inventory.forEach(itemId => {
        if (ENCYCLOPEDIA_DATA[itemId]) {
            const data = ENCYCLOPEDIA_DATA[itemId];
            let previewHTML = `<div class="die ${itemId} face-6" style="width:40px !important; height:40px !important; min-width:40px; background-size:contain; display:inline-block; margin-right:10px; vertical-align:middle;"></div>`;
            content.innerHTML += `<div class="rules-section" style="margin-bottom:10px; display:flex; align-items:center;">${previewHTML}<div><h3 style="margin:0; font-size:1rem;">${data.name}</h3><p style="margin:5px 0 0 0; font-size:0.8rem;">${data.desc}</p></div></div>`;
            hasEntries = true;
        }
    });
    if (!hasEntries) content.innerHTML = '<div style="text-align:center; opacity:0.6; margin-top:20px;">Здесь пока пусто...<br>Купите особые предметы в Лавке!</div>';
    modal.classList.add('active');
};
window.closeEncyclopedia = (e) => { if (!e || e.target.id === 'modal-encyclopedia' || e.target.classList.contains('btn-close')) document.getElementById('modal-encyclopedia').classList.remove('active'); };

// --- PVE, SETTINGS ---
bindClick('btn-to-pve', () => showScreen('pve-settings'));
bindClick('btn-pve-back', () => showScreen('home'));
window.setDiff = (diff) => {
    state.pve.difficulty = diff;
    
    // 1. Сбрасываем активность только у кнопок СЛОЖНОСТИ (внутри time-selector)
    // Раньше тут был код, который сбрасывал вообще все кнопки, включая правила. Исправили.
    const container = document.querySelector('#screen-pve-settings .time-selector');
    if(container) { 
        Array.from(container.children).forEach(btn => { 
            btn.classList.remove('active'); // Снимаем актив со всех кнопок сложности
            if(btn.getAttribute('onclick').includes(`'${diff}'`)) {
                btn.classList.add('active'); // Ставим актив на выбранную
            }
        }); 
    }
    
    // 2. Обновляем текст наград
    const desc = { 
        'medium': '100 XP / 100 монет', 
        'pirate': '500 XP / 500 монет', 
        'legend': '🏆 1000 XP / 1000 монет (ХАРДКОР!)' 
    };
    document.getElementById('diff-desc').textContent = desc[diff] || '';
};
bindClick('btn-start-pve', () => {
    socket.emit('joinOrCreateRoom', { roomId: null, tgUser: tg?.initDataUnsafe?.user || {id:123, first_name:state.username}, mode: 'pve', options: { dice: state.pve.dice, players: state.pve.bots + 1, jokers: state.pve.jokers, spot: state.pve.spot, strict: state.pve.strict, difficulty: state.pve.difficulty, crazy: state.pve.crazy } });
});
bindClick('btn-to-create', () => showScreen('create-settings'));
bindClick('btn-back-home', () => showScreen('home'));
window.setTime = (sec) => {
    state.createTime = sec;
    const container = document.querySelector('#screen-create-settings .time-selector');
    if (container) { Array.from(container.children).forEach(btn => { btn.classList.remove('active'); if (parseInt(btn.textContent) === sec) btn.classList.add('active'); }); }
};
window.adjSetting = (type, delta) => {
    if (type === 'dice') { state.createDice = Math.max(3, Math.min(10, state.createDice + delta)); state.pve.dice = state.createDice; document.querySelectorAll('#set-dice, #pve-dice').forEach(el => el.textContent = state.createDice); } 
    else if (type === 'players') { state.createPlayers = Math.max(2, Math.min(10, state.createPlayers + delta)); document.getElementById('set-players').textContent = state.createPlayers; }
    else if (type === 'bots') { state.pve.bots = Math.max(1, Math.min(9, state.pve.bots + delta)); document.getElementById('pve-bots').textContent = state.pve.bots; }
};
bindClick('btn-confirm-create', () => {
    const betCoins = COIN_STEPS[document.getElementById('range-bet-coins').value];
    const betXp = XP_STEPS[document.getElementById('range-bet-xp').value];
    if((betCoins > 0 && betCoins > state.coins) || (betXp > 0 && betXp > state.xp)) { document.getElementById('modal-res-alert').classList.add('active'); return; }
    socket.emit('joinOrCreateRoom', { roomId: null, tgUser: tg?.initDataUnsafe?.user || {id:123, first_name:state.username}, options: { dice: state.createDice, players: state.createPlayers, time: state.createTime, jokers: state.rules.jokers, spot: state.rules.spot, strict: state.rules.strict, betCoins: betCoins, betXp: betXp, crazy: state.rules.crazy } });
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

// FRIEND LOGIC (SAVED ID)
let currentProfileId = null;
window.requestPlayerStats = (socketId) => { 
    const idStr = String(socketId);
    if (idStr.startsWith('bot') || idStr.startsWith('CPU')) { uiAlert("Это бот. У него нет души."); return; } 
    currentProfileId = socketId; socket.emit('getPlayerStats', socketId); 
};

socket.on('showPlayerStats', (data) => {
    const modal = document.getElementById('modal-player'); if (!modal) return;
    const content = modal.querySelector('.modal-content'); 
    
    // Рамка профиля
    content.className = 'modal-content pop-in'; 
    if (data.equipped.frame && data.equipped.frame !== 'frame_default') content.classList.add(data.equipped.frame);
    
    document.getElementById('info-name').textContent = data.name;
    document.getElementById('info-rank-name').textContent = data.rankName;
    document.getElementById('info-matches').textContent = data.matches;
    document.getElementById('info-wins').textContent = data.wins;
    document.getElementById('info-wr').textContent = (data.matches > 0 ? Math.round((data.wins / data.matches) * 100) : 0) + '%';
    
    // --- ОБНОВЛЕННАЯ ЛОГИКА ШЛЯП ---
    const rankImg = document.getElementById('info-rank-img'); 
    if(rankImg) {
        rankImg.src = getRankImage(data.rankName, data.equipped?.hat);
        
        // Сбрасываем классы
        rankImg.className = 'rank-img';
        
        // Добавляем классы редкости для анимации
        if (data.equipped?.hat && HATS_META[data.equipped.hat]) {
            const r = HATS_META[data.equipped.hat].rarity;
            if (r === 'legendary') rankImg.classList.add('hat-legendary');
            if (r === 'mythical') rankImg.classList.add('hat-mythical');
        }
    }
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
    
    // FRIEND BUTTON
    const btnAdd = document.getElementById('btn-add-friend');
    if (state.myId && data.id !== state.myId) {
        const isFriend = friendDataCache.friends.some(f => f.id == data.id);
        if (isFriend) {
            btnAdd.style.display = 'block'; btnAdd.textContent = 'ВЫ ДРУЗЬЯ 🤝'; btnAdd.disabled = true; btnAdd.style.background = '#06d6a0'; btnAdd.style.opacity = '1'; btnAdd.onclick = null;
        } else {
            btnAdd.style.display = 'block'; btnAdd.textContent = 'ДОБАВИТЬ В ДРУЗЬЯ'; btnAdd.disabled = false; btnAdd.style.background = ''; 
            btnAdd.onclick = () => { socket.emit('friendAction', { action: 'request', payload: data.id }); btnAdd.textContent = 'ЗАПРОС ОТПРАВЛЕН'; btnAdd.disabled = true; };
        }
    } else { btnAdd.style.display = 'none'; }
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
bindClick('btn-share-native', () => window.shareRoomNative());
window.adjBid = (type, delta) => { if (type === 'qty') { state.bidQty = Math.max(1, state.bidQty + delta); document.getElementById('display-qty').textContent = state.bidQty; } else { state.bidVal = Math.max(1, Math.min(6, state.bidVal + delta)); document.getElementById('display-val').textContent = state.bidVal; } };
bindClick('btn-make-bid', () => socket.emit('makeBid', { quantity: state.bidQty, faceValue: state.bidVal }));
bindClick('btn-call-bluff', () => socket.emit('callBluff'));
bindClick('btn-call-spot', () => socket.emit('callSpot'));
bindClick('btn-restart', () => socket.emit('requestRestart'));
bindClick('btn-home', () => location.reload());
window.sendEmote = (e) => { socket.emit('sendEmote', e); };
window.useSkill = (type) => { socket.emit('useSkill', type); }; // FIX: ADDED GLOBAL FUNCTION FOR SKILLS

socket.on('emoteReceived', (data) => { const el = document.querySelector(`.player-chip[data-id='${data.id}']`); if (el) { const img = document.createElement('img'); img.className = 'emote-bubble-img'; img.src = `https://raw.githubusercontent.com/gokcedogruu-spec/LiarsDice/main/emotions/default_${data.emoji}.png`; el.appendChild(img); setTimeout(() => { if(img.parentNode) img.remove(); }, 3000); if(tg) tg.HapticFeedback.selectionChanged(); } });
socket.on('skillResult', (data) => { const modal = document.getElementById('modal-skill-alert'); const iconEl = document.getElementById('skill-alert-title'); let icon = '⚡'; if (data.type === 'ears') icon = '👂'; else if (data.type === 'lucky') icon = '🎲'; else if (data.type === 'kill') icon = '🔫'; iconEl.textContent = icon; document.getElementById('skill-alert-text').textContent = data.text; modal.classList.add('active'); });
window.closeSkillAlert = () => { document.getElementById('modal-skill-alert').classList.remove('active'); };
socket.on('errorMsg', (msg) => { 
    if (msg === 'NO_FUNDS') { 
        document.getElementById('modal-res-alert').classList.add('active'); 
    } else { 
        uiAlert(msg, "ОШИБКА"); 
        
        // ЕСЛИ КОМНАТА НЕ НАЙДЕНА — СТИРАЕМ ЕЁ ИЗ ПАМЯТИ
        if (msg.includes('не найдена')) {
            localStorage.removeItem('lastRoomId');
            state.roomId = null;
        }
    } 
});
socket.on('roomUpdate', (room) => {
    // 1. Запоминаем ID комнаты в программе и в памяти телефона
    state.roomId = room.roomId;
    localStorage.setItem('lastRoomId', room.roomId); 

    if (room.status === 'LOBBY') {
        showScreen('lobby');
        document.getElementById('lobby-room-id').textContent = room.roomId;

        if (room.config) {
            document.getElementById('lobby-rules').textContent = `🎲${room.config.dice} 👤${room.config.players} ⏱️${room.config.time}с`;
            state.currentRoomBets = { coins: room.config.betCoins, xp: room.config.betXp };
            
            let betStr = '';
            if (room.config.betCoins > 0) betStr += `💰 ${room.config.betCoins}  `;
            if (room.config.betXp > 0) betStr += `⭐ ${room.config.betXp}`;
            document.getElementById('lobby-bets').textContent = betStr;
        }

        const list = document.getElementById('lobby-players');
        list.innerHTML = '';
        room.players.forEach(p => {
            list.innerHTML += `
                <div class="player-item" onclick="requestPlayerStats('${p.id}')">
                    <div><b>${p.name}</b><span class="rank-sub">${p.rank}</span></div>
                    <span>${p.ready ? '✅' : '⏳'}</span>
                </div>`;
        });

        const me = room.players.find(p => p.id === socket.id);
        const startBtn = document.getElementById('btn-start-game');
        if (startBtn) {
            startBtn.style.display = (me?.isCreator && room.players.length > 1) ? 'block' : 'none';
        }
    }
});
socket.on('gameEvent', (evt) => { const log = document.getElementById('game-log'); if(log) log.innerHTML = `<div>${evt.text}</div>`; if(evt.type === 'alert' && tg) tg.HapticFeedback.notificationOccurred('warning'); });
socket.on('yourDice', (dice) => { const skin = state.equipped.skin || 'skin_white'; document.getElementById('my-dice').innerHTML = dice.map(d => `<div class="die ${skin} face-${d}"></div>`).join(''); });

socket.on('gameOver', (data) => {
    showScreen('result');
    document.getElementById('winner-name').textContent = data.winner;
    if(tg) tg.HapticFeedback.notificationOccurred('success');
});

socket.on('gameState', (gs) => { 
    showScreen('game'); 
    document.body.className = gs.activeBackground || 'bg_default'; 
    let rulesText = ''; 
    if (gs.activeRules.jokers) rulesText += '🃏 Джокеры  '; 
    if (gs.activeRules.spot)   rulesText += '🎯 В точку  '; 
    if (gs.activeRules.strict) rulesText += '🔒 Строго  ';
    if (gs.activeRules.crazy)  rulesText += '🤪 Безумный стол';
    document.getElementById('active-rules-display').textContent = rulesText.trim(); 
    
    document.querySelectorAll('.revealed-dice-container').forEach(el => el.remove());

    const bar = document.getElementById('players-bar'); 
    const activeIds = new Set(gs.players.map(p => p.id)); 
    gs.players.forEach(p => { 
        let chip = bar.querySelector(`.player-chip[data-id="${p.id}"]`); 
        const frameClass = p.equipped && p.equipped.frame ? p.equipped.frame : 'frame_default'; 
        const turnClass = p.isTurn ? 'turn' : ''; 
        const deadClass = p.isEliminated ? 'dead' : ''; 
        const finalClass = `player-chip ${turnClass} ${deadClass} ${frameClass}`; 
        if (!chip) { 
            chip = document.createElement('div'); 
            chip.setAttribute('data-id', p.id); 
            chip.setAttribute('onclick', `requestPlayerStats('${p.id}')`); 
            bar.appendChild(chip); 
            chip.innerHTML = `<b>${p.name}</b><span class="rank-game">${p.rank}</span><div class="dice-count">🎲 ${p.diceCount}</div>`; 
        } 
        chip.className = finalClass; 
        chip.querySelector('b').textContent = p.name; 
        chip.querySelector('.rank-game').textContent = p.rank; 
        chip.querySelector('.dice-count').textContent = `🎲 ${p.diceCount}`; 
    }); 
    Array.from(bar.children).forEach(child => { if (!activeIds.has(child.getAttribute('data-id'))) child.remove(); }); 
    
    const bid = document.getElementById('current-bid-display');

if (gs.currentBid) {
    const bidder = gs.players.find(p => p.id === gs.currentBid.playerId);
    const skin = bidder?.equipped?.skin || 'skin_white';

    bid.innerHTML = `
        <div class="bid-container">
            <div class="bid-qty">
                ${gs.currentBid.quantity}<span class="bid-x">x</span>
            </div>
            <div class="die ${skin} face-${gs.currentBid.faceValue} bid-die-icon"></div>
        </div>
    `;

    // мини-пузырь: только если ставка изменилась
    const lb = state.lastBid;
    const cb = gs.currentBid;
    const isNewBid =
        !lb ||
        lb.playerId !== cb.playerId ||
        lb.quantity !== cb.quantity ||
        lb.faceValue !== cb.faceValue;

    if (isNewBid) {
        spawnRaiseBubble(gs);
        state.lastBid = { ...cb };
    }

    state.bidQty = cb.quantity;
    state.bidVal = cb.faceValue;
    updateInputs();
} else {
    state.lastBid = null;

    const me = gs.players.find(p => p.id === socket.id);
    if (me?.isTurn) {
        bid.innerHTML = `
            <div style="font-size:1.2rem; color:#ef233c; font-weight:bold;">
                Ваш ход!
            </div>
        `;
    } else {
        const turnPlayer = gs.players.find(p => p.isTurn);
        const name = turnPlayer ? turnPlayer.name : "Ожидание";
        bid.innerHTML = `
            <div style="font-size:1.2rem; color:#2b2d42; font-weight:bold;">
                Ходит: ${name}
            </div>
        `;
    }

    state.bidQty = 1;
    state.bidVal = 2;
    updateInputs();
}
    
    const me = gs.players.find(p => p.id === socket.id); 
    const myTurn = me?.isTurn; 
    const controls = document.getElementById('game-controls'); 
    const spotBtn = document.getElementById('btn-call-spot'); 
    if (spotBtn) { if (gs.activeRules.spot) spotBtn.classList.remove('hidden-rule'); else spotBtn.classList.add('hidden-rule'); } 
    // Удаляем старую панель навыков
    const existingSkills = document.querySelector('.skills-bar');
    if (existingSkills) existingSkills.remove();

    // Навыки показываем только живому игроку
    if (me && !me.isEliminated) {
    const skillsDiv = document.createElement('div');
    skillsDiv.className = 'skills-bar';

    const hasActiveRankSkills = me.availableSkills && me.availableSkills.length > 0;
    const currentHatId = me.equipped?.hat || null;
    const crazyMode = !!gs.activeRules.crazy;
    const hatSkill = crazyMode && currentHatId && HAT_SKILLS[currentHatId] ? HAT_SKILLS[currentHatId] : null;

    // --- АКТИВНЫЕ НАВЫКИ ---
    if (hasActiveRankSkills || (hatSkill && hatSkill.activeDesc)) {
        const activeSection = document.createElement('div');
        activeSection.className = 'skills-section';

        activeSection.innerHTML = `
            <div class="skills-title">АКТИВНЫЕ</div>
            <div class="skills-row"></div>
        `;
        const row = activeSection.querySelector('.skills-row');

        // Ранговые навыки (уши / счастливый / kill)
        if (hasActiveRankSkills) {
            me.availableSkills.forEach(skill => {
                const btn = document.createElement('button');
                btn.className = `btn-skill skill-${skill}`;
                btn.setAttribute('onclick', `useSkill('${skill}')`);
                row.appendChild(btn);
            });
        }

        // Активный навык шляпы (кнопка с иконкой шляпы) – только в Безумном столе
        if (hatSkill && hatSkill.activeDesc) {
            const hatBtn = document.createElement('button');
            hatBtn.className = 'btn-skill btn-skill-hat';
            // маленькая иконка шляпы – используем ту же картинку, что и для ранга
            const hatImgUrl = getRankImage(null, currentHatId);
            hatBtn.style.backgroundImage = `url('${hatImgUrl}')`;
            hatBtn.title = hatSkill.activeTitle || 'Навык шляпы';

            // Пока только показываем описание навыка, без логики useHatSkill
            hatBtn.onclick = () => openHatInfo(currentHatId, 'active');

            row.appendChild(hatBtn);
        }

        skillsDiv.appendChild(activeSection);
    }

    // --- ПАССИВНЫЕ НАВЫКИ ШЛЯПЫ ---
    if (hatSkill && hatSkill.passiveDesc) {
        const passiveSection = document.createElement('div');
        passiveSection.className = 'skills-section skills-passive';

        passiveSection.innerHTML = `
            <div class="skills-title">ПАССИВНЫЕ</div>
            <div class="skills-row"></div>
        `;
        const rowP = passiveSection.querySelector('.skills-row');

        const passBtn = document.createElement('button');
        passBtn.className = 'btn-skill btn-skill-passive';
        passBtn.textContent = 'i'; // маленькая инфо-кнопка
        passBtn.onclick = () => openHatInfo(currentHatId, 'passive');

        rowP.appendChild(passBtn);
        skillsDiv.appendChild(passiveSection);
    }

    if (skillsDiv.children.length > 0) {
    const dicePanel = document.querySelector('.my-dice-panel');
    const parent = dicePanel?.parentNode || document.querySelector('.my-controls-area');
    parent.insertBefore(skillsDiv, dicePanel || controls);
}
}
    
    if(myTurn) { 
        controls.classList.remove('hidden'); controls.classList.add('slide-up'); 
        document.getElementById('btn-call-bluff').disabled = !gs.currentBid; 
        if(spotBtn) spotBtn.disabled = !gs.currentBid; 
        if(tg) tg.HapticFeedback.impactOccurred('medium'); 
    } else { controls.classList.add('hidden'); } 
    
    if (gs.remainingTime !== undefined && gs.totalDuration) { startVisualTimer(gs.remainingTime, gs.totalDuration); } 
});

socket.on('bluffEffect', (data) => {
    if(tg) {
        tg.HapticFeedback.notificationOccurred('error');
        setTimeout(() => tg.HapticFeedback.impactOccurred('heavy'), 300);
        setTimeout(() => tg.HapticFeedback.impactOccurred('heavy'), 600);
        setTimeout(() => tg.HapticFeedback.impactOccurred('heavy'), 900);
    }
    const flash = document.getElementById('red-flash-overlay');
    flash.classList.add('red-flash-active');
    setTimeout(() => flash.classList.remove('red-flash-active'), 1000);

    const cloud = document.getElementById('bluff-cloud');
    const chip = document.querySelector(`.player-chip[data-id='${data.playerId}']`);
    cloud.classList.remove('hidden');
    cloud.classList.add('bluff-cloud-active');
    setTimeout(() => {
        cloud.classList.remove('bluff-cloud-active');
        cloud.classList.add('hidden');
    }, 2500);
});

socket.on('skillUsed', (data) => {
    const cloud = document.getElementById('skill-cloud');
    if (!cloud) return;

    let text = '';
    if (data.skill === 'ears')  text = `${data.name} подслушивает!`;
    if (data.skill === 'lucky') text = `${data.name} достаёт кубик!`;
    if (data.skill === 'kill')  text = `${data.name} достаёт ствол!`;

    cloud.textContent = text || `${data.name} использует навык!`;

    cloud.classList.remove('hidden');
    cloud.classList.remove('skill-cloud-active');
    // перезапуск анимации
    void cloud.offsetWidth;
    cloud.classList.add('skill-cloud-active');

    // Хаптик: для kill — пожёстче, для остальных — помягче
    if (tg && tg.HapticFeedback) {
        try {
            if (data.skill === 'kill') {
                tg.HapticFeedback.notificationOccurred('error');
                setTimeout(() => tg.HapticFeedback.impactOccurred('heavy'), 200);
            } else {
                tg.HapticFeedback.notificationOccurred('warning');
            }
        } catch (e) {}
    }

    // Для kill добавим ещё и вспышку (как при bluff), но короче
    if (data.skill === 'kill') {
        const flash = document.getElementById('red-flash-overlay');
        if (flash) {
            flash.classList.add('red-flash-active');
            setTimeout(() => flash.classList.remove('red-flash-active'), 800);
        }
    }

    setTimeout(() => {
        cloud.classList.add('hidden');
    }, 1900);
});

socket.on('revealPhase', (data) => {
    document.getElementById('game-controls').classList.add('hidden');
    document.getElementById('current-bid-display').innerHTML = 
        `<div style="font-size:1.2rem; color:#ef233c; font-weight:900;">ВСКРЫТИЕ!</div>
         <div style="font-size:0.9rem;">${data.message}</div>
         <button class="btn btn-green" style="margin-top:10px;" onclick="sendReadyNext()">ГОТОВО</button>`;

    document.querySelectorAll('.revealed-dice-container').forEach(el => el.remove());

    const delay = data.animate ? 2500 : 0;

    setTimeout(() => {
        Object.values(data.allDice).forEach(info => {
            const chip = document.querySelector(`.player-chip[data-id="${info.id}"]`);
            if (chip) {
                const container = document.createElement('div');
                container.className = 'revealed-dice-container';
                if (info.dice && info.dice.length > 0) {
                    info.dice.forEach(d => {
                        const die = document.createElement('div');
                        die.className = `mini-die ${info.skin || 'skin_white'} face-${d}`;
                        container.appendChild(die);
                    });
                } else { container.innerHTML = '<span style="font-size:0.6rem; opacity:0.7">Пусто</span>'; }
                chip.appendChild(container);
            }
        });
        if(data.timeLeft) startVisualTimer(data.timeLeft, data.timeLeft);
    }, delay);
});

window.sendReadyNext = () => {
    const bidDisplay = document.getElementById('current-bid-display');
    bidDisplay.innerHTML = `<div style="font-size:1.2rem; color:#06d6a0;">Ждем остальных...</div>`;
    socket.emit('playerReadyNext');
};

socket.on('matchResults', (res) => {
    const profitEl = document.getElementById('result-profit');
    profitEl.innerHTML = '';
    let html = '';
    if (res.coins !== 0 || res.xp !== 0) {
        const color = res.coins >= 0 ? '#06d6a0' : '#ef233c';
        html += `<div style="color:${color}; font-size:1.2rem; margin-bottom:10px;">`;
        if(res.coins !== 0) html += `${res.coins > 0 ? '+' : ''}${res.coins}💰 `;
        if(res.xp !== 0) html += `${res.xp > 0 ? '+' : ''}${res.xp}⭐`;
        html += `</div>`;
    }
    if (res.rankUp) {
        html += `<div style="color:#ffb703; font-weight:900; font-size:1.1rem; margin-bottom:5px; text-shadow:1px 1px 0 black;">🎉 ПОВЫШЕНИЕ: ${res.rankUp}!</div>`;
    }
    if (res.details && res.details.length > 0) {
        html += `<div style="font-size:0.8rem; opacity:0.8; margin-top:5px; line-height:1.4;">`;
        res.details.forEach(line => { html += `<div>${line}</div>`; });
        html += `</div>`;
    }
    profitEl.innerHTML = html;
});

function updateInputs() { document.getElementById('display-qty').textContent = state.bidQty; document.getElementById('display-val').textContent = state.bidVal; }
function startVisualTimer(remaining, total) { if (state.timerFrame) cancelAnimationFrame(state.timerFrame); const bar = document.querySelector('.timer-progress'); if (!bar) return; if (remaining <= 0 || !total) { bar.style.width = '0%'; return; } const endTime = Date.now() + remaining; function tick() { const now = Date.now(); const left = endTime - now; if (left <= 0) { bar.style.width = '0%'; return; } const pct = (left / total) * 100; bar.style.width = `${Math.min(100, Math.max(0, pct))}%`; if (pct < 25) bar.style.backgroundColor = '#ef233c'; else if (pct < 50) bar.style.backgroundColor = '#ffb703'; else bar.style.backgroundColor = '#06d6a0'; state.timerFrame = requestAnimationFrame(tick); } tick(); }
function spawnRaiseBubble(gs) {
    if (!gs.currentBid) return;

    const bid = gs.currentBid;
    const chip = document.querySelector(`.player-chip[data-id='${bid.playerId}']`);
    if (!chip) return;

    const player = gs.players.find(p => p.id === bid.playerId);
    const skin = player?.equipped?.skin || 'skin_white';

    const bubble = document.createElement('div');
    bubble.className = 'raise-bubble';
    bubble.innerHTML = `
        <span class="raise-qty">${bid.quantity}×</span>
        <div class="die ${skin} face-${bid.faceValue} bid-die-mini"></div>
    `;

    chip.appendChild(bubble);

    if (tg && tg.HapticFeedback) {
        try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
    }

    setTimeout(() => {
        if (bubble.parentNode) bubble.remove();
    }, 900);
}

// --- FRIEND SYSTEM CLIENT LOGIC ---
let currentFriendTab = 'list';
let friendDataCache = { friends: [], requests: [] };

window.openFriends = () => {
    document.getElementById('modal-friends').classList.add('active');
    document.getElementById('btn-friends-menu').classList.remove('blink-anim');
    socket.emit('friendAction', { action: 'get' });
};
window.closeFriends = (e) => {
    if (!e || e.target.id === 'modal-friends' || e.target.classList.contains('btn-close')) {
        document.getElementById('modal-friends').classList.remove('active');
    }
};
window.switchFriendTab = (tab) => {
    currentFriendTab = tab;
    document.querySelectorAll('.friend-tab').forEach(b => b.classList.remove('active'));
    document.getElementById(`tab-f-${tab}`).classList.add('active');
    document.getElementById('friend-content-list').classList.add('hidden');
    document.getElementById('friend-content-req').classList.add('hidden');
    document.getElementById('friend-content-find').classList.add('hidden');
    document.getElementById(`friend-content-${tab}`).classList.remove('hidden');
};
socket.on('friendUpdate', (data) => {
    friendDataCache = data;
    renderFriends();
    const btn = document.getElementById('btn-friends-menu');
    if (data.requests.length > 0) { btn.classList.add('blink-anim'); btn.textContent = `👥 ${data.requests.length}`; } 
    else { btn.classList.remove('blink-anim'); btn.textContent = `👥`; }
});
socket.on('forceFriendUpdate', () => { socket.emit('friendAction', { action: 'get' }); });

function renderFriends() {
    const listContainer = document.getElementById('friend-content-list');
    const reqContainer = document.getElementById('friend-content-req');
    listContainer.innerHTML = '';
    if (friendDataCache.friends.length === 0) { listContainer.innerHTML = '<div style="text-align:center; opacity:0.5; margin-top:20px;">Пока никого...</div>'; } 
    else {
        friendDataCache.friends.forEach(f => {
            let statusClass = 'status-offline';
            let inviteBtn = '';
            if (f.status === 'online') { statusClass = 'status-online'; } 
            else if (f.status === 'ingame') { statusClass = 'status-ingame'; }
            
            if (state.roomId) { inviteBtn = `<button class="btn-friend-action btn-invite" onclick="inviteFriend('${f.id}')">ЗОВИ</button>`; }

            listContainer.innerHTML += `<div class="friend-row"><div style="display:flex; align-items:center;"><div class="friend-status ${statusClass}"></div><span class="friend-name clickable" onclick="requestPlayerStats('${f.id}')">${f.name}</span></div><div class="friend-actions">${inviteBtn}<button class="btn-friend-action btn-decline" onclick="removeFriend('${f.id}')">X</button></div></div>`;
        });
    }
    reqContainer.innerHTML = '';
    if (friendDataCache.requests.length === 0) { reqContainer.innerHTML = '<div style="text-align:center; opacity:0.5; margin-top:20px;">Пусто</div>'; } 
    else {
        friendDataCache.requests.forEach(r => {
            reqContainer.innerHTML += `<div class="friend-row"><span class="friend-name clickable" onclick="requestPlayerStats('${r.id}')">${r.name}</span><div class="friend-actions"><button class="btn-friend-action btn-accept" onclick="acceptFriend('${r.id}')">ДА</button><button class="btn-friend-action btn-decline" onclick="declineFriend('${r.id}')">НЕТ</button></div></div>`;
        });
    }
}

window.searchFriend = () => { const val = document.getElementById('input-friend-search').value; if (val) socket.emit('friendAction', { action: 'search', payload: val }); };
window.inviteFriend = (id) => { socket.emit('inviteToRoom', id); };
window.removeFriend = (id) => { uiConfirm("Удалить из друзей?", () => { const btn = event.target; if(btn) { const row = btn.closest('.friend-row'); if(row) row.remove(); } socket.emit('friendAction', { action: 'decline', payload: id }); }); };
window.acceptFriend = (id) => { const btn = event.target; if(btn) { const row = btn.closest('.friend-row'); if(row) row.remove(); } socket.emit('friendAction', { action: 'accept', payload: id }); };
window.declineFriend = (id) => { const btn = event.target; if(btn) { const row = btn.closest('.friend-row'); if(row) row.remove(); } socket.emit('friendAction', { action: 'decline', payload: id }); };

socket.on('friendSearchResult', (res) => {
    const container = document.getElementById('search-result');
    container.classList.add('active');
    if (res) { container.innerHTML = `<div class="friend-row" style="border:none; padding:0;"><span class="friend-name">${res.name}</span><button class="btn-friend-action btn-invite" onclick="sendRequest('${res.id}')">ДРУЖИТЬ</button></div>`; } 
    else { container.innerHTML = '<span style="opacity:0.6">Не найден</span>'; }
});
window.sendRequest = (id) => { socket.emit('friendAction', { action: 'request', payload: id }); document.getElementById('search-result').innerHTML = 'Отправлено!'; };

socket.on('gameInvite', (data) => {
    let msg = `<b>${data.inviter}</b> зовет в игру!<br>Ставки: ${data.betCoins}💰 ${data.betXp}⭐`;
    if (state.roomId && document.getElementById('screen-game').classList.contains('active')) { msg += `<br><br><span style="color:#ef233c; font-weight:bold;">ВНИМАНИЕ: Вы покинете текущий бой и потеряете ставку!</span>`; }
    uiConfirm(msg, () => { const userPayload = tg?.initDataUnsafe?.user || { id: 123, first_name: state.username }; socket.emit('joinOrCreateRoom', { roomId: data.roomId, tgUser: userPayload }); });
});
socket.on('notification', (data) => { if (data.type === 'friend_req') { const btn = document.getElementById('btn-friends-menu'); btn.classList.add('blink-anim'); if(tg) tg.HapticFeedback.notificationOccurred('success'); } });
window.openInviteModal = () => { openFriends(); switchFriendTab('list'); };

// Глобальный "эффект нажатия" для кнопок .btn
function handleButtonDown(e) {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    btn.classList.add('btn-pressed');
}

function handleButtonUp() {
    document.querySelectorAll('.btn-pressed')
        .forEach(el => el.classList.remove('btn-pressed'));
}

// Навешиваем для мыши и тача
document.addEventListener('mousedown', handleButtonDown);
document.addEventListener('touchstart', handleButtonDown, { passive: true });

// Снимаем при отпускании/уходе
['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(ev => {
    document.addEventListener(ev, handleButtonUp, true);
});

// --- ЛОГИКА ОБУЧЕНИЯ ---
let tutStep = 0;
let tutQty = 1;
let tutVal = 4;

const tutScript = [
    // РАУНД 1
    { text: "Цель игры: угадать, сколько кубиков одного номинала лежит на столе у ВСЕХ игроков.", btn: "ДАЛЕЕ" },
    { text: "Посмотри на свои кости внизу. У тебя есть одна 'Четверка' и одна 'Двойка'.", btn: "ПОНЯЛ" },
    { text: "Ходит Бот Джек. Он делает ставку: думает, что на столе минимум ДВЕ 'Четверки'.", action: "jack_bid_1" },
    { text: "Ход переходит к Боту Биллу. Он должен либо повысить ставку, либо сказать 'Не верю'.", action: "bill_turn_1" },
    { text: "Билл повышает ставку! Он ставит ТРИ 'Четверки'.", action: "bill_bid_1" },
    { text: "Твой ход! У тебя есть одна четверка, давай повысим ставку до ЧЕТЫРЕХ.<br><br><b>Нажимай на '+' пока не станет 4.</b>", action: "my_turn_qty_1" },
    { text: "Отлично! Теперь нажми кнопку <b>'СТАВКА'</b>, чтобы подтвердить ход.", action: "my_turn_bid_1" },
    { text: "Снова ходит Джек. Он нервничает... и ставит ПЯТЬ 'Четверок'. Это явный блеф! На столе всего 6 кубов.", action: "jack_bluff_1" },
    { text: "Твой ход! Нажми <b>'НЕ ВЕРЮ!'</b>, чтобы проверить его!", action: "my_turn_bluff_1" },
    { text: "Вскрытие! На столе оказалось всего три четверки. Джек проиграл раунд и теряет кубик!", action: "reveal_1" },
    
    // РАУНД 2
    { text: "Начинается новый раунд! Кости перемешались. Теперь у Джека остался только 1 кубик.", action: "start_round_2" },
    { text: "Твой ход первый. У тебя выпали две 'Пятерки'. Давай начнем агрессивно!<br><br><b>Сделай ставку: 3x[5]</b><br>Используй плюсы.", action: "my_turn_qty_2" },
    { text: "Отлично! Жми <b>'СТАВКА'</b>.", action: "my_turn_bid_2" },
    { text: "Джек в панике! У него всего 1 куб, и он не верит тебе.", action: "jack_bluff_2" },
    { text: "Вскрытие! У тебя две пятерки, у Билла одна. Ставка сыграла! Джек теряет последний куб и выбывает!", action: "reveal_2" },
    
    // РАУНД 3 (Финал)
    { text: "Остались только ты и Билл. У него 2 куба, у тебя 2. Финальная дуэль!", action: "start_round_3" },
    { text: "Билл ставит ДВЕ 'Тройки'.", action: "bill_bid_3" },
    { text: "У тебя нет троек вообще. Скорее всего он блефует. Жми <b>'НЕ ВЕРЮ!'</b>", action: "my_turn_bluff_3" },
    { text: "Вскрытие! У Билла нет троек, он блефовал! Билл теряет куб.", action: "reveal_3" },
    
    // РАУНД 4 (Добивание)
    { text: "У Билла остался 1 куб. Добиваем!", action: "start_round_4" },
    { text: "Билл ставит ОДНУ 'Шестерку'.", action: "bill_bid_4" },
    { text: "У тебя есть шестерка. Повышай до ДВУХ 'Шестерок'!<br><br><b>Нажми '+' на количестве.</b>", action: "my_turn_qty_4" },
    { text: "Жми <b>'СТАВКА'</b>.", action: "my_turn_bid_4" },
    { text: "Билл не верит!", action: "bill_bluff_4" },
    { text: "Вскрытие! У тебя шестерка, у Билла шестерка. Ставка сыграла! Билл теряет последний куб!", action: "reveal_4" },
    { text: "Победа!", action: "victory" }
];

// Функция для создания пузыря ставки (как в реальной игре)
function tutSpawnRaiseBubble(playerId, qty, face, skin) {
    const chip = document.querySelector(`.player-chip[data-id='${playerId}']`);
    if (!chip) return;
    const bubble = document.createElement('div');
    bubble.className = 'raise-bubble';
    bubble.innerHTML = `<span class="raise-qty">${qty}×</span><div class="die ${skin} face-${face} bid-die-mini"></div>`;
    chip.appendChild(bubble);
    if (tg && tg.HapticFeedback) { try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {} }
    setTimeout(() => { if (bubble.parentNode) bubble.remove(); }, 900);
}

window.startTutorial = () => {
    tutStep = 0; tutQty = 1; tutVal = 4;
    document.getElementById('tut-bid-display').style.visibility = "hidden";
    document.getElementById('tut-game-log').innerHTML = "";
    document.getElementById('tut-bot-jack').classList.remove('turn', 'dead');
    document.getElementById('tut-bot-bill').classList.remove('turn', 'dead');
    document.getElementById('tut-controls').style.opacity = "0.3";
    document.getElementById('tut-controls').style.pointerEvents = "none";
    document.getElementById('tut-jack-dice').textContent = "🎲 2";
    document.getElementById('tut-bill-dice').textContent = "🎲 2";
    
    document.getElementById('tut-my-dice').innerHTML = `
        <div class="die skin_white face-4"></div>
        <div class="die skin_white face-2"></div>
    `;

    document.querySelectorAll('.tut-revealed').forEach(el => el.remove());

    showScreen('tutorial');
    updateTutorial();
};

window.stopTutorial = () => {
    localStorage.setItem('tutorialDone', 'true');
    showScreen('home');
    setTimeout(() => {
        uiAlert("Поздравляем, вы прошли обучение! Попробуйте игру против ботов или с друзьями!", "ОБУЧЕНИЕ ПРОЙДЕНО");
    }, 500);
};

function updateTutorial() {
    const step = tutScript[tutStep];
    const msgBox = document.getElementById('tutorial-msg-box');
    const textEl = document.getElementById('tutorial-text');
    const nextBtn = document.getElementById('tutorial-next-btn');

    // Сброс и запуск анимации появления окна
    msgBox.classList.remove('tut-pop-in', 'tut-pulse-anim');
    void msgBox.offsetWidth; // Перезапуск CSS
    msgBox.classList.add('tut-pop-in');
    setTimeout(() => msgBox.classList.add('tut-pulse-anim'), 400);

    textEl.innerHTML = step.text;
    nextBtn.textContent = step.btn || "ЖДУ...";
    nextBtn.style.display = step.btn ? "inline-block" : "none";

    document.querySelectorAll('.highlight-action').forEach(el => el.classList.remove('highlight-action'));

    // Функция для скрытия окна подсказки на время анимации
    const delayMsg = (ms) => {
        msgBox.style.display = 'none';
        setTimeout(() => {
            msgBox.style.display = 'block';
            msgBox.classList.remove('tut-pop-in', 'tut-pulse-anim');
            void msgBox.offsetWidth;
            msgBox.classList.add('tut-pop-in');
            setTimeout(() => msgBox.classList.add('tut-pulse-anim'), 400);
        }, ms);
    };

    // РАУНД 1
    if (step.action === "jack_bid_1") {
        document.getElementById('tut-bot-jack').classList.add('turn');
        tutSpawnRaiseBubble('tut_jack', 2, 4, 'skin_white');
        document.getElementById('tut-game-log').innerHTML = "<div>Бот Джек ставит: 2x[4]</div>";
        document.getElementById('tut-bid-display').style.visibility = "visible";
        document.getElementById('tut-bid-qty').innerHTML = '2<span class="bid-x">x</span>';
        document.getElementById('tut-bid-face').className = "die skin_white face-4 bid-die-icon";
        delayMsg(1200); // Ждем пока пройдет анимация пузыря
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "ДАЛЕЕ";
    }
    if (step.action === "bill_turn_1") {
        document.getElementById('tut-bot-jack').classList.remove('turn');
        document.getElementById('tut-bot-bill').classList.add('turn');
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "СМОТРЕТЬ";
    }
    if (step.action === "bill_bid_1") {
        tutSpawnRaiseBubble('tut_bill', 3, 4, 'skin_white');
        document.getElementById('tut-game-log').innerHTML = "<div>Бот Билл ставит: 3x[4]</div>";
        document.getElementById('tut-bid-qty').innerHTML = '3<span class="bid-x">x</span>';
        delayMsg(1200);
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "МОЙ ХОД";
    }
    if (step.action === "my_turn_qty_1") {
        document.getElementById('tut-bot-bill').classList.remove('turn');
        const controls = document.getElementById('tut-controls');
        controls.style.opacity = "1"; controls.style.pointerEvents = "auto";
        
        tutQty = 1; // Сбрасываем до 1
        document.getElementById('tut-qty-val').textContent = tutQty;
        
        const plus = document.getElementById('tut-qty-plus');
        plus.classList.add('highlight-action');
        plus.onclick = () => {
            if(tutQty < 4) tutQty++; 
            document.getElementById('tut-qty-val').textContent = tutQty;
            if(tutQty === 4) {
                plus.onclick = null;
                tutStep++; updateTutorial();
            }
        };
    }
    if (step.action === "my_turn_bid_1") {
        const bidBtn = document.getElementById('tut-btn-bid');
        bidBtn.classList.add('highlight-action');
        bidBtn.onclick = () => {
            document.getElementById('tut-game-log').innerHTML = "<div>Вы ставите: 4x[4]</div>";
            document.getElementById('tut-bid-qty').innerHTML = '4<span class="bid-x">x</span>';
            document.getElementById('tut-controls').style.opacity = "0.3";
            document.getElementById('tut-controls').style.pointerEvents = "none";
            delayMsg(1000);
            tutStep++; updateTutorial();
        };
    }
    if (step.action === "jack_bluff_1") {
        document.getElementById('tut-bot-jack').classList.add('turn');
        tutSpawnRaiseBubble('tut_jack', 5, 4, 'skin_white');
        document.getElementById('tut-game-log').innerHTML = "<div>Бот Джек ставит: 5x[4]</div>";
        document.getElementById('tut-bid-qty').innerHTML = '5<span class="bid-x">x</span>';
        delayMsg(1200);
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "ПОЙМАТЬ ЕГО!";
    }
    if (step.action === "my_turn_bluff_1") {
        document.getElementById('tut-bot-jack').classList.remove('turn');
        const controls = document.getElementById('tut-controls');
        controls.style.opacity = "1"; controls.style.pointerEvents = "auto";
        const liarBtn = document.getElementById('tut-btn-bluff');
        liarBtn.classList.add('highlight-action');
        liarBtn.onclick = () => {
            if(tg) tg.HapticFeedback.notificationOccurred('error');
            document.getElementById('tut-red-flash-overlay').classList.add('red-flash-active');
            setTimeout(() => document.getElementById('tut-red-flash-overlay').classList.remove('red-flash-active'), 1000);
            const cloud = document.getElementById('tut-bluff-cloud');
            cloud.classList.remove('hidden'); cloud.classList.add('bluff-cloud-active');
            msgBox.style.display = 'none'; // Прячем окно на время анимации
            setTimeout(() => {
                cloud.classList.remove('bluff-cloud-active'); cloud.classList.add('hidden');
                tutStep++; updateTutorial();
            }, 2500);
            controls.style.opacity = "0.3"; controls.style.pointerEvents = "none";
        };
    }
    if (step.action === "reveal_1") {
        document.getElementById('tut-game-log').innerHTML = "<div class='tut-log-text'>На столе 3.<br>Блеф! Джек теряет куб.</div>";
        document.getElementById('tut-bid-display').style.visibility = "hidden";
        
        // Показываем кости
        document.getElementById('tut-bot-jack').innerHTML += `<div class="revealed-dice-container tut-revealed"><div class="mini-die skin_white face-4"></div><div class="mini-die skin_white face-1"></div></div>`;
        document.getElementById('tut-bot-bill').innerHTML += `<div class="revealed-dice-container tut-revealed"><div class="mini-die skin_white face-4"></div><div class="mini-die skin_white face-3"></div></div>`;
        document.getElementById('tut-jack-dice').textContent = "🎲 1";
        
        // Гарантированно показываем окно и кнопку без задержек, чтобы не зависало
        msgBox.style.display = 'block';
        nextBtn.style.display = "inline-block"; 
        nextBtn.textContent = "ДАЛЕЕ";
    }

    // РАУНД 2
    if (step.action === "start_round_2") {
        document.querySelectorAll('.tut-revealed').forEach(el => el.remove());
        document.getElementById('tut-my-dice').innerHTML = `<div class="die skin_white face-5"></div><div class="die skin_white face-5"></div>`;
        document.getElementById('tut-game-log').innerHTML = "<div>РАУНД 2</div>";
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "МОЙ ХОД";
    }
    if (step.action === "my_turn_qty_2") {
        const controls = document.getElementById('tut-controls');
        controls.style.opacity = "1"; controls.style.pointerEvents = "auto";
        
        tutQty = 1; tutVal = 2; // Сброс значений
        document.getElementById('tut-qty-val').textContent = tutQty;
        document.getElementById('tut-val-val').textContent = tutVal;
        
        const plusQty = document.getElementById('tut-qty-plus');
        const plusVal = document.getElementById('tut-val-plus');
        plusQty.classList.add('highlight-action');
        plusVal.classList.add('highlight-action');
        
        const checkNext = () => {
            if (tutQty === 3 && tutVal === 5) {
                plusQty.onclick = null; plusVal.onclick = null;
                tutStep++; updateTutorial();
            }
        };
        plusQty.onclick = () => { if(tutQty < 3) tutQty++; document.getElementById('tut-qty-val').textContent = tutQty; checkNext(); };
        plusVal.onclick = () => { if(tutVal < 5) tutVal++; document.getElementById('tut-val-val').textContent = tutVal; checkNext(); };
    }
    if (step.action === "my_turn_bid_2") {
        const bidBtn = document.getElementById('tut-btn-bid');
        bidBtn.classList.add('highlight-action');
        bidBtn.onclick = () => {
            document.getElementById('tut-game-log').innerHTML = "<div>Вы ставите: 3x[5]</div>";
            document.getElementById('tut-bid-display').style.visibility = "visible";
            document.getElementById('tut-bid-qty').innerHTML = '3<span class="bid-x">x</span>';
            document.getElementById('tut-bid-face').className = "die skin_white face-5 bid-die-icon";
            document.getElementById('tut-controls').style.opacity = "0.3";
            document.getElementById('tut-controls').style.pointerEvents = "none";
            delayMsg(1000);
            tutStep++; updateTutorial();
        };
    }
    if (step.action === "jack_bluff_2") {
        document.getElementById('tut-bot-jack').classList.add('turn');
        msgBox.style.display = 'none';
        setTimeout(() => {
            if(tg) tg.HapticFeedback.notificationOccurred('error');
            document.getElementById('tut-red-flash-overlay').classList.add('red-flash-active');
            setTimeout(() => document.getElementById('tut-red-flash-overlay').classList.remove('red-flash-active'), 1000);
            const cloud = document.getElementById('tut-bluff-cloud');
            cloud.classList.remove('hidden'); cloud.classList.add('bluff-cloud-active');
            setTimeout(() => {
                cloud.classList.remove('bluff-cloud-active'); cloud.classList.add('hidden');
                tutStep++; updateTutorial();
            }, 2500);
        }, 800);
    }
    if (step.action === "reveal_2") {
        document.getElementById('tut-bot-jack').classList.remove('turn');
        document.getElementById('tut-game-log').innerHTML = "<div class='tut-log-success'>На столе 3.<br>Ставка есть! Джек теряет куб.</div>";
        document.getElementById('tut-bid-display').style.visibility = "hidden";
        document.getElementById('tut-bot-jack').innerHTML += `<div class="revealed-dice-container tut-revealed"><div class="mini-die skin_white face-2"></div></div>`;
        document.getElementById('tut-bot-bill').innerHTML += `<div class="revealed-dice-container tut-revealed"><div class="mini-die skin_white face-5"></div><div class="mini-die skin_white face-1"></div></div>`;
        document.getElementById('tut-jack-dice').textContent = "🎲 0";
        document.getElementById('tut-bot-jack').classList.add('dead');
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "ДАЛЕЕ";
    }

    // РАУНД 3
    if (step.action === "start_round_3") {
        document.querySelectorAll('.tut-revealed').forEach(el => el.remove());
        document.getElementById('tut-my-dice').innerHTML = `<div class="die skin_white face-1"></div><div class="die skin_white face-2"></div>`;
        document.getElementById('tut-game-log').innerHTML = "<div>РАУНД 3</div>";
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "СМОТРЕТЬ";
    }
    if (step.action === "bill_bid_3") {
        document.getElementById('tut-bot-bill').classList.add('turn');
        tutSpawnRaiseBubble('tut_bill', 2, 3, 'skin_white');
        document.getElementById('tut-game-log').innerHTML = "<div>Бот Билл ставит: 2x[3]</div>";
        document.getElementById('tut-bid-display').style.visibility = "visible";
        document.getElementById('tut-bid-qty').innerHTML = '2<span class="bid-x">x</span>';
        document.getElementById('tut-bid-face').className = "die skin_white face-3 bid-die-icon";
        delayMsg(1200);
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "МОЙ ХОД";
    }
    if (step.action === "my_turn_bluff_3") {
        document.getElementById('tut-bot-bill').classList.remove('turn');
        const controls = document.getElementById('tut-controls');
        controls.style.opacity = "1"; controls.style.pointerEvents = "auto";
        const liarBtn = document.getElementById('tut-btn-bluff');
        liarBtn.classList.add('highlight-action');
        liarBtn.onclick = () => {
            if(tg) tg.HapticFeedback.notificationOccurred('error');
            document.getElementById('tut-red-flash-overlay').classList.add('red-flash-active');
            setTimeout(() => document.getElementById('tut-red-flash-overlay').classList.remove('red-flash-active'), 1000);
            const cloud = document.getElementById('tut-bluff-cloud');
            cloud.classList.remove('hidden'); cloud.classList.add('bluff-cloud-active');
            msgBox.style.display = 'none';
            setTimeout(() => {
                cloud.classList.remove('bluff-cloud-active'); cloud.classList.add('hidden');
                tutStep++; updateTutorial();
            }, 2500);
            controls.style.opacity = "0.3"; controls.style.pointerEvents = "none";
        };
    }
    if (step.action === "reveal_3") {
        document.getElementById('tut-game-log').innerHTML = "<div class='tut-log-text'>На столе 0.<br>Блеф! Билл теряет куб.</div>";
        document.getElementById('tut-bid-display').style.visibility = "hidden";
        document.getElementById('tut-bot-bill').innerHTML += `<div class="revealed-dice-container tut-revealed"><div class="mini-die skin_white face-4"></div><div class="mini-die skin_white face-5"></div></div>`;
        document.getElementById('tut-bill-dice').textContent = "🎲 1";
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "ДАЛЕЕ";
    }

    // РАУНД 4
    if (step.action === "start_round_4") {
        document.querySelectorAll('.tut-revealed').forEach(el => el.remove());
        document.getElementById('tut-my-dice').innerHTML = `<div class="die skin_white face-6"></div><div class="die skin_white face-3"></div>`;
        document.getElementById('tut-game-log').innerHTML = "<div>РАУНД 4</div>";
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "СМОТРЕТЬ";
    }
    if (step.action === "bill_bid_4") {
        document.getElementById('tut-bot-bill').classList.add('turn');
        tutSpawnRaiseBubble('tut_bill', 1, 6, 'skin_white');
        document.getElementById('tut-game-log').innerHTML = "<div>Бот Билл ставит: 1x[6]</div>";
        document.getElementById('tut-bid-display').style.visibility = "visible";
        document.getElementById('tut-bid-qty').innerHTML = '1<span class="bid-x">x</span>';
        document.getElementById('tut-bid-face').className = "die skin_white face-6 bid-die-icon";
        delayMsg(1200);
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "МОЙ ХОД";
    }
    if (step.action === "my_turn_qty_4") {
        document.getElementById('tut-bot-bill').classList.remove('turn');
        const controls = document.getElementById('tut-controls');
        controls.style.opacity = "1"; controls.style.pointerEvents = "auto";
        
        tutQty = 1; tutVal = 6;
        document.getElementById('tut-qty-val').textContent = tutQty;
        document.getElementById('tut-val-val').textContent = tutVal;
        
        const plusQty = document.getElementById('tut-qty-plus');
        plusQty.classList.add('highlight-action');
        plusQty.onclick = () => { 
            if(tutQty < 2) tutQty++; 
            document.getElementById('tut-qty-val').textContent = tutQty; 
            if(tutQty === 2) { 
                plusQty.onclick = null; tutStep++; updateTutorial(); 
            } 
        };
    }
    if (step.action === "my_turn_bid_4") {
        const bidBtn = document.getElementById('tut-btn-bid');
        bidBtn.classList.add('highlight-action');
        bidBtn.onclick = () => {
            document.getElementById('tut-game-log').innerHTML = "<div>Вы ставите: 2x[6]</div>";
            document.getElementById('tut-bid-qty').innerHTML = '2<span class="bid-x">x</span>';
            document.getElementById('tut-controls').style.opacity = "0.3";
            document.getElementById('tut-controls').style.pointerEvents = "none";
            delayMsg(1000);
            tutStep++; updateTutorial();
        };
    }
    if (step.action === "bill_bluff_4") {
        document.getElementById('tut-bot-bill').classList.add('turn');
        msgBox.style.display = 'none';
        setTimeout(() => {
            if(tg) tg.HapticFeedback.notificationOccurred('error');
            document.getElementById('tut-red-flash-overlay').classList.add('red-flash-active');
            setTimeout(() => document.getElementById('tut-red-flash-overlay').classList.remove('red-flash-active'), 1000);
            const cloud = document.getElementById('tut-bluff-cloud');
            cloud.classList.remove('hidden'); cloud.classList.add('bluff-cloud-active');
            setTimeout(() => {
                cloud.classList.remove('bluff-cloud-active'); cloud.classList.add('hidden');
                tutStep++; updateTutorial();
            }, 2500);
        }, 800);
    }
    if (step.action === "reveal_4") {
        document.getElementById('tut-bot-bill').classList.remove('turn');
        document.getElementById('tut-game-log').innerHTML = "<div class='tut-log-success'>На столе 2.<br>Ставка есть! Билл теряет куб.</div>";
        document.getElementById('tut-bid-display').style.visibility = "hidden";
        document.getElementById('tut-bot-bill').innerHTML += `<div class="revealed-dice-container tut-revealed"><div class="mini-die skin_white face-6"></div></div>`;
        document.getElementById('tut-bill-dice').textContent = "🎲 0";
        document.getElementById('tut-bot-bill').classList.add('dead');
        nextBtn.style.display = "inline-block"; nextBtn.textContent = "ПОБЕДА!";
    }
    if (step.action === "victory") {
        showScreen('result');
        document.getElementById('winner-name').textContent = state.username || "Игрок";
        document.getElementById('result-profit').innerHTML = `<div style="color:#06d6a0; font-size:1.2rem; margin-bottom:10px;">+100💰 +100⭐</div><div style="font-size:0.8rem; opacity:0.8;">Обучение пройдено!</div>`;
        
        const restartBtn = document.getElementById('btn-restart');
        const homeBtn = document.getElementById('btn-home');
        
        const oldRestart = restartBtn.onclick;
        const oldHome = homeBtn.onclick;

        restartBtn.onclick = () => {
            restartBtn.onclick = oldRestart;
            homeBtn.onclick = oldHome;
            startTutorial();
        };
        
        homeBtn.onclick = () => {
            restartBtn.onclick = oldRestart;
            homeBtn.onclick = oldHome;
            stopTutorial();
        };
        
        if(tg) tg.HapticFeedback.notificationOccurred('success');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const nextBtn = document.getElementById('tutorial-next-btn');
    if (nextBtn) {
        nextBtn.onclick = () => {
            tutStep++;
            if (tutStep >= tutScript.length) {
                stopTutorial();
            } else {
                updateTutorial();
            }
        };
    }
});

setTimeout(() => {
    if (!localStorage.getItem('tutorialDone') && state.username) {
        uiConfirm("Ты здесь впервые, моряк! Пройти обучение?", () => {
            startTutorial();
        });
        localStorage.setItem('tutorialDone', 'true');
    }
}, 2500);


