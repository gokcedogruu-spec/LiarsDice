const SkillsUI = {
    listenersAdded: false,

    init: function() {
        // Создаем кнопку, если её еще нет
        if (!document.getElementById('btn-active-skill')) {
            const btn = document.createElement('button');
            btn.id = 'btn-active-skill';
            btn.className = 'btn-skill hidden'; 
            btn.innerHTML = '✨ НАВЫК';
            
            btn.addEventListener('click', () => {
                socket.emit('use_active_skill');
                if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
            });
            
            const controls = document.getElementById('game-controls');
            if(controls) {
                // ВЕРНУЛИ КНОПКУ ВНИЗ (в конец панели управления)
                controls.appendChild(btn); 
            }
        }

        // БЕЗОПАСНОЕ ДОБАВЛЕНИЕ СЛУШАТЕЛЕЙ (чтобы работало без ошибок)
        if (!this.listenersAdded && typeof socket !== 'undefined') {
            socket.on('skill_result', (data) => {
                if (data.error) {
                    uiAlert(data.error, "ОШИБКА НАВЫКА");
                } else if (data.msg) {
                    uiAlert(data.msg, "УСПЕХ!");
                }
            });

            socket.on('skill_broadcast', (data) => {
                const logBox = document.getElementById('game-log'); 
                if (logBox) {
                    logBox.innerHTML = `<div style="color: #ffd166; font-weight: bold; text-shadow: 1px 1px 2px black;">🌟 ${data.publicMsg}</div>`;
                }
            });
            this.listenersAdded = true;
        }
    },

   updateVisibility: function(gs, me) {
        const btn = document.getElementById('btn-active-skill');
        if (!btn) return;

        if (gs.activeRules && gs.activeRules.crazy && me && !me.isEliminated) {
            btn.classList.remove('hidden');
            
            if (me.equipped && me.equipped.hat) {
                btn.innerHTML = '🎩 НАВЫК';
                btn.disabled = false;
                btn.style.opacity = '1';
            } else {
                btn.innerHTML = '🎩 НУЖНА ШЛЯПА';
                btn.disabled = true;
                btn.style.opacity = '0.5';
            }
        } else {
            btn.classList.add('hidden');
        }
    }
};
