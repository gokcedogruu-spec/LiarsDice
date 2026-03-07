const SkillsUI = {
    listenersAdded: false,

    init: function() {
        // 1. Создаем кнопку "НАВЫКИ"
        if (!document.getElementById('btn-active-skill')) {
            const btn = document.createElement('button');
            btn.id = 'btn-active-skill';
            btn.className = 'btn-skill hidden'; 
            btn.innerHTML = '✨ НАВЫКИ';
            
            btn.addEventListener('click', () => {
                this.openMenu();
                if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
            });
            
            const controls = document.getElementById('game-controls');
            if(controls) {
                controls.appendChild(btn); // Возвращаем кнопку вниз!
            }
        }

        // 2. Создаем модальное окно для меню навыков
        if (!document.getElementById('modal-skills-menu')) {
            const modalHTML = `
                <div id="modal-skills-menu" class="modal-overlay" onclick="if(event.target.id==='modal-skills-menu') this.classList.remove('active')">
                    <div class="modal-content pop-in" style="max-width: 300px; padding-top: 20px;">
                        <button class="btn-close" onclick="document.getElementById('modal-skills-menu').classList.remove('active')">✕</button>
                        <h2 class="modal-title" style="font-size:1.5rem; margin-bottom:15px;">НАВЫКИ</h2>
                        <div id="skills-menu-container" style="display:flex; flex-direction:column; gap:10px;">
                            <!-- Кнопки навыков будут здесь -->
                        </div>
                    </div>
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', modalHTML);
        }

        // 3. Слушатели событий от сервера
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

            // Анимация пассивных навыков в начале игры (поочередно)
            socket.on('passive_skills_intro', (passives) => {
                passives.forEach((p, index) => {
                    setTimeout(() => {
                        const cloud = document.getElementById('skill-cloud');
                        if (cloud) {
                            cloud.innerHTML = `<span style="color:#ffb703">${p.name}</span><br><span style="font-size:0.8rem">${p.passiveName}</span>`;
                            cloud.classList.remove('hidden', 'skill-cloud-active');
                            void cloud.offsetWidth; // перезапуск анимации
                            cloud.classList.add('skill-cloud-active');
                            if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('warning');
                        }
                    }, index * 2500); // Показываем каждые 2.5 секунды
                });
            });

            this.listenersAdded = true;
        }
    },

   updateVisibility: function(gs, me) {
        const btn = document.getElementById('btn-active-skill');
        if (!btn) return;

        this.latestGameState = gs;
        this.me = me;

        // Показываем кнопку, если включен Безумный стол и игрок жив
        if (gs.activeRules && gs.activeRules.crazy && me && !me.isEliminated) {
            btn.classList.remove('hidden');
        } else {
            btn.classList.add('hidden');
        }
    },

    openMenu: function() {
        const container = document.getElementById('skills-menu-container');
        container.innerHTML = '';
        const me = this.me;
        if (!me) return;

        let hasSkills = false;

        // 1. Ранговые навыки (из me.availableSkills)
        const rankSkillsMap = {
            'ears': { name: 'Чувствительные уши', icon: '👂' },
            'lucky': { name: 'Счастливый кубик', icon: '🎲' },
            'kill': { name: 'Возмездие', icon: '🔫' }
        };

        if (me.availableSkills && me.availableSkills.length > 0) {
            me.availableSkills.forEach(skillId => {
                const s = rankSkillsMap[skillId];
                if (s) {
                    hasSkills = true;
                    const btn = document.createElement('button');
                    btn.className = 'btn btn-blue';
                    btn.innerHTML = `${s.icon} ${s.name}`;
                    btn.onclick = () => {
                        socket.emit('useSkill', skillId); // Старый обработчик ранговых навыков
                        document.getElementById('modal-skills-menu').classList.remove('active');
                    };
                    container.appendChild(btn);
                }
            });
        }

        // 2. Навык шляпы
        if (me.equipped && me.equipped.hat) {
            hasSkills = true;
            const hatId = me.equipped.hat;
            const btn = document.createElement('button');
            btn.className = 'btn btn-orange';
            btn.innerHTML = `🎩 Навык шляпы`;
            
            // Проверяем, использован ли навык шляпы (теперь skillsUsed это массив)
            if (me.skillsUsed && me.skillsUsed.includes(hatId)) {
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.innerHTML += ' (Использован)';
            } else {
                btn.onclick = () => {
                    socket.emit('use_active_skill'); // Обработчик навыка шляпы
                    document.getElementById('modal-skills-menu').classList.remove('active');
                };
            }
            container.appendChild(btn);
        }

        if (!hasSkills) {
            container.innerHTML = '<p style="color:white; opacity:0.7; text-align:center;">Нет доступных навыков</p>';
        }

        document.getElementById('modal-skills-menu').classList.add('active');
    }
};
