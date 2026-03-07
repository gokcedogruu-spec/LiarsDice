// --- skillsLogic.js ---

// База всех навыков
const SKILLS = {
    // Пример: Редкая шляпа
    'hat_rare_1': {
        type: 'rare',
        activeName: 'Переброс',
        passiveName: 'Везунчик',
        activeUses: 1, // Сколько раз за игру можно использовать активный навык
        
        // Активный навык: Перебрасывает все кубики игрока
        executeActive: (game, player) => {
            player.dice = player.dice.map(() => Math.floor(Math.random() * 6) + 1);
            return { 
                success: true, 
                msg: 'Вы перебросили свои кубики!', 
                publicMsg: `${player.username} использовал навык "Переброс" и сменил свои кубики!` 
            };
        },
        
        // Пассивный навык: 10% шанс не потерять кубик при проигрыше
        executePassive: (game, player, eventType) => {
            if (eventType === 'lose_die') {
                if (Math.random() < 0.10) {
                    return { prevented: true, msg: `Пассивный навык "Везунчик" спас кубик игрока ${player.username}!` };
                }
            }
            return { prevented: false };
        }
    },

    // Пример: Легендарная шляпа
    'hat_leg_1': {
        type: 'legendary',
        activeName: 'Шулер',
        passiveName: 'Щит',
        activeUses: 1,
        
        // Активный навык: Делает первый кубик шестеркой
        executeActive: (game, player) => {
            if(player.dice.length > 0) player.dice[0] = 6;
            return { 
                success: true, 
                msg: 'Один ваш кубик чудесным образом стал шестеркой!', 
                publicMsg: `${player.username} использовал "Шулер"! Что-то произошло с его костями...` 
            };
        },
        
        // Пассивный навык: Первый раз за игру спасает от потери кубика (100% шанс)
        executePassive: (game, player, eventType) => {
            if (eventType === 'lose_die' && !player.shieldUsed) {
                player.shieldUsed = true; // Отмечаем, что щит сломан
                return { prevented: true, msg: `Легендарный "Щит" поглотил урон! ${player.username} не теряет кубик.` };
            }
            return { prevented: false };
        }
    }
};

// Функция обработки нажатия на кнопку навыка
function handleActiveSkill(game, player) {
    if (!game.settings || !game.settings.crazyMode) {
        return { error: 'Навыки работают только в режиме "Безумный стол"!' };
    }
    
    // ВАЖНО: замените player.equippedHat на ту переменную, где у вас хранится надетая шляпа
    const hatId = player.equippedHat; 
    const skill = SKILLS[hatId];
    
    if (!skill || !skill.executeActive) return { error: 'У вашей шляпы нет активного навыка.' };
    
    // Проверка лимита использований
    player.skillsUsed = player.skillsUsed || {};
    if ((player.skillsUsed[hatId] || 0) >= skill.activeUses) {
        return { error: 'Вы уже использовали этот навык в текущей игре.' };
    }
    
    const result = skill.executeActive(game, player);
    if (result.success) {
        player.skillsUsed[hatId] = (player.skillsUsed[hatId] || 0) + 1;
        result.skillName = skill.activeName;
    }
    return result;
}

// Функция проверки пассивных навыков (вызывается сервером автоматически)
function triggerPassiveSkill(game, player, eventType) {
    if (!game.settings || !game.settings.crazyMode) return null;
    
    const hatId = player.equippedHat;
    const skill = SKILLS[hatId];
    
    if (skill && skill.executePassive) {
        return skill.executePassive(game, player, eventType);
    }
    return null;
}

module.exports = { SKILLS, handleActiveSkill, triggerPassiveSkill };
