const SkillsUI = {
    init: function() {
        // Создаем кнопку, если её еще нет
        if (!document.getElementById('btn-active-skill')) {
            const btn = document.createElement('button');
            btn.id = 'btn-active-skill';
            btn.className = 'btn-skill hidden'; // Скрыта по умолчанию
            btn.innerHTML = '✨ НАВЫК';
            
            // ЖЕЛЕЗОБЕТОННАЯ ПРИВЯЗКА КЛИКА
            btn.addEventListener('click', () => {
                console.log("Кнопка навыка нажата!"); // Для проверки в консоли
                socket.emit('use_active_skill');
                if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
            });
            
            // Добавляем кнопку на панель управления (рядом со ставками)
            const controls = document.getElementById('game-controls');
            if(controls) {
                // Вставляем кнопку ПЕРЕД блоком со ставками, чтобы она была сверху
                controls.insertBefore(btn, controls.firstChild);
            }
        }
    },

   updateVisibility: function(gs, me) {
        const btn = document.getElementById('btn-active-skill');
        if (!btn) return;

        // Показываем кнопку, если включен Безумный стол и игрок жив
        if (gs.activeRules && gs.activeRules.crazy && me && !me.isEliminated) {
            btn.classList.remove('hidden');
            
            if (me.equipped && me.equipped.hat) {
                btn.innerHTML = '🎩 НАВЫК';
                btn.disabled = false;
                btn.style.opacity = '1';
            } else {
                btn.innerHTML = '🎩 НУЖНА ШЛЯПА';
                btn.disabled = true; // Блокируем кнопку, если нет шляпы
                btn.style.opacity = '0.5';
            }
        } else {
            btn.classList.add('hidden');
        }
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
    const logBox = document.getElementById('game-log'); // Исправил ID на правильный из вашего HTML
    if (logBox) {
        logBox.innerHTML = `<div style="color: #ffd166; font-weight: bold; text-shadow: 1px 1px 2px black;">🌟 ${data.publicMsg}</div>`;
    }
});
