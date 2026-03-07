// База всех навыков (Используем РЕАЛЬНЫЕ ID шляп из игры)
const SKILLS = {
    'hat_fallen': {
        type: 'rare',
        activeName: 'Переброс',
        activeUses: 1, // Сколько раз за игру можно использовать
        executeActive: (game, player) => {
            // Перебрасываем все кубики игрока
            player.dice = player.dice.map(() => Math.floor(Math.random() * 6) + 1);
            return { 
                success: true, 
                msg: 'Вы перебросили свои кубики!', 
                publicMsg: `${player.name} использовал навык "Переброс" и сменил свои кубики!` 
            };
        }
    },

    'hat_rich': {
        type: 'rare',
        activeName: 'Шулер',
        activeUses: 1,
        executeActive: (game, player) => {
            // Делает первый кубик шестеркой
            if(player.dice.length > 0) player.dice[0] = 6;
            return { 
                success: true, 
                msg: 'Один ваш кубик чудесным образом стал шестеркой!', 
                publicMsg: `${player.name} использовал "Шулер"! Что-то произошло с его костями...` 
            };
        }
    }
    // Сюда потом добавите остальные шляпы (hat_underwater, hat_voodoo и т.д.)
};

function handleActiveSkill(game, player) {
    if (!game.config || !game.config.crazy) {
        return { error: 'Навыки работают только в режиме "Безумный стол"!' };
    }
    
    const hatId = player.equipped?.hat; 
    if (!hatId) return { error: 'У вас не надета шляпа!' };

    const skill = SKILLS[hatId];
    if (!skill || !skill.executeActive) {
        return { error: 'У этой шляпы пока нет активного навыка в коде сервера.' };
    }
    
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

function triggerPassiveSkill(game, player, eventType) {
    if (!game.config || !game.config.crazy) return null;
    
    const hatId = player.equipped?.hat;
    const skill = SKILLS[hatId];
    
    if (skill && skill.executePassive) {
        return skill.executePassive(game, player, eventType);
    }
    return null;
}

module.exports = { SKILLS, handleActiveSkill, triggerPassiveSkill };
