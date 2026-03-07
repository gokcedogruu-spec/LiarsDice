// --- skills.js ---
const SkillsUI = {
    init: function() {
        // Создаем кнопку, если её еще нет
        if (!document.getElementById('btn-active-skill')) {
            const btn = document.createElement('button');
            btn.id = 'btn-active-skill';
            btn.className = 'btn-skill hidden'; // Скрыта по умолчанию
            btn.innerHTML = '✨ НАВЫК';
            btn.onclick = () => this.useSkill();
            
            // Добавляем кнопку на панель управления (рядом со ставками)
            const controls = document.getElementById('game-controls');
            if(controls) controls.appendChild(btn);
        }
    },

   updateVisibility: function(gs, me) {
        const btn = document.getElementById('btn-active-skill');
        if (!btn) return;

        // Показываем кнопку только если:
        // 1. Включен "Безумный стол" (crazy)
        // 2. Игрок жив (!me.isEliminated)
        // 3. У игрока надета шляпа (me.equipped && me.equipped.hat)
        if (gs.activeRules && gs.activeRules.crazy && me && !me.isEliminated && me.equipped && me.equipped.hat) {
            btn.classList.remove('hidden');
            
            // Можно даже менять иконку кнопки в зависимости от надетой шляпы!
            // const hatId = me.equipped.hat;
            // btn.style.backgroundImage = `url('${getRankImage(null, hatId)}')`;
        } else {
            btn.classList.add('hidden');
        }
    },

    useSkill: function() {
        socket.emit('use_active_skill');
        if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
    }
};

// Слушаем ответы от сервера
socket.on('skill_result', (data) => {
    if (data.error) {
        uiAlert(data.error, "ОШИБКА НАВЫКА");
    } else if (data.msg) {
        uiAlert(data.msg, "УСПЕХ!");
    }
});

socket.on('skill_broadcast', (data) => {
    // Показываем красивое уведомление всем за столом
    const logBox = document.getElementById('game-log-box'); // Ваше окно логов
    if (logBox) {
        logBox.innerHTML = `<div style="color: #ffd166; font-weight: bold; text-shadow: 1px 1px 2px black;">🌟 ${data.publicMsg}</div>`;
    }
});
