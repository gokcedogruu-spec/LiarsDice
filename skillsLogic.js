const SKILLS = {
    'hat_rich': {
        passiveName: 'Казначей',
        activeName: 'Золотой сундук',
        activeUses: 1,
        executeActive: (game, player) => {
            player.goldenChest = true;
            return { success: true, msg: 'Вы активировали Золотой сундук!', publicMsg: `${player.name} объявляет "Золотой сундук"! Ставки растут!` };
        }
    },
    'hat_fallen': {
        passiveName: 'Упавшая легенда',
        activeName: 'Второй шанс',
        activeUses: 1,
        executeActive: (game, player) => {
            player.secondChance = true;
            return { success: true, msg: 'Активирован Второй шанс! При вылете вы вернетесь с 1 кубиком.', publicMsg: `${player.name} готов восстать из мертвых!` };
        }
    },
    'hat_underwater': {
        passiveName: 'Дыхание под водой',
        activeName: 'Глоток воздуха',
        activeUses: 1,
        executeActive: (game, player) => {
            game.turnDeadline += game.turnDuration;
            game.turnDuration *= 2;
            return { success: true, msg: 'Ваше время на ход удвоено!', publicMsg: `${player.name} делает глубокий вдох... Время замедляется!` };
        }
    },
    'hat_voodoo': {
        passiveName: 'Шёпот костей',
        activeName: 'Проклятье языка',
        activeUses: 1,
        executeActive: (game, player) => {
            if (!game.currentBid) return { error: 'Никто еще не сделал ставку!' };
            const target = game.players.find(p => p.id === game.currentBid.playerId);
            if (!target) return { error: 'Цель не найдена!' };
            target.cursedTongue = true;
            return { success: true, msg: `Вы прокляли ${target.name}!`, publicMsg: `${player.name} наложил Проклятье языка на ${target.name}!` };
        }
    },
    'hat_king_voodoo': {
        passiveName: 'Король проклятий',
        activeName: 'Кукла вуду',
        activeUses: 1,
        executeActive: (game, player) => {
            const enemies = game.players.filter(p => p.id !== player.id && p.diceCount > 0);
            if (enemies.length === 0) return { error: 'Нет целей!' };
            const target = enemies[Math.floor(Math.random() * enemies.length)];
            if (target.dice.length > 0) target.dice.pop(); 
            return { success: true, msg: `Вы проткнули куклу ${target.name}! У него пропал 1 кубик на этот раунд.`, publicMsg: `${player.name} использует Куклу вуду! Кто-то лишился кубика!` };
        }
    },
    'hat_cursed': {
        passiveName: 'Живи опасно',
        activeName: 'Проклятый банк',
        activeUses: 1,
        executeActive: (game, player) => {
            game.cursedBank = true;
            return { success: true, msg: 'Вы прокляли банк! Штрафы и награды увеличены.', publicMsg: `${player.name} проклинает общий банк! Ставки взлетели!` };
        }
    },
    'hat_flame': {
        passiveName: 'Горячий стиль',
        activeName: 'Пылающий вызов',
        activeUses: 1,
        executeActive: (game, player) => {
            game.flamingChallenge = true;
            return { success: true, msg: 'Пылающий вызов брошен! Ошибочный блеф стоит 2 кубика.', publicMsg: `${player.name} бросает Пылающий вызов! Ошибки теперь стоят дороже!` };
        }
    },
    'hat_frozen': {
        passiveName: 'Лёд в жилах',
        activeName: 'Ледяной шок',
        activeUses: 1,
        executeActive: (game, player) => {
            game.iceShockActive = true;
            return { success: true, msg: 'Следующий игрок получит вдвое меньше времени на ход!', publicMsg: `${player.name} использует Ледяной шок! Время замерзает!` };
        }
    },
    'hat_ghost': {
        passiveName: 'Призрачный взгляд',
        activeName: 'Видение конца',
        activeUses: 1,
        executeActive: (game, player) => {
            const face = Math.floor(Math.random() * 5) + 2; 
            let count = 0;
            game.players.forEach(p => {
                p.dice.forEach(d => { if (d === face || (game.config.jokers && d === 1)) count++; });
            });
            return { success: true, msg: `Духи шепчут: на столе ровно ${count} кубиков с номиналом ${face}.`, publicMsg: `${player.name} взывает к духам и видит истину!` };
        }
    },
    'hat_poison': {
        passiveName: 'Токсичная аура',
        activeName: 'Отравленный куб',
        activeUses: 1,
        executeActive: (game, player) => {
            const enemies = game.players.filter(p => p.id !== player.id && p.diceCount > 0);
            if (enemies.length === 0) return { error: 'Нет целей!' };
            const target = enemies[Math.floor(Math.random() * enemies.length)];
            target.poisoned = true;
            return { success: true, msg: `Вы отравили куб игрока ${target.name}!`, publicMsg: `${player.name} подбрасывает Отравленный куб!` };
        }
    },
    'hat_lava': {
        passiveName: 'Огненная выносливость',
        activeName: 'Огненный шторм',
        activeUses: 1,
        executeActive: (game, player) => {
            game.players.forEach(p => { if (p.dice.length > 0) p.dice[0] = Math.floor(Math.random() * 6) + 1; });
            return { success: true, msg: 'Огненный шторм перебросил по 1 кубику у всех игроков!', publicMsg: `${player.name} вызывает Огненный шторм! Кубики плавятся!` };
        }
    },
    'hat_deadlycursed': {
        passiveName: 'Тень над столом',
        activeName: 'Теневой выстрел',
        activeUses: 1,
        executeActive: (game, player) => {
            const enemies = game.players.filter(p => p.id !== player.id && p.diceCount > 0);
            if (enemies.length === 0) return { error: 'Нет целей!' };
            const target = enemies[Math.floor(Math.random() * enemies.length)];
            if (target.dice.length > 0) {
                const stolenDie = target.dice.pop();
                player.dice.push(stolenDie);
            }
            return { success: true, msg: `Вы украли 1 кубик у ${target.name} на этот раунд!`, publicMsg: `${player.name} делает Теневой выстрел и крадет кубик!` };
        }
    },
    'hat_antarctica': {
        passiveName: 'Ледяной фронт',
        activeName: 'Метель',
        activeUses: 1,
        executeActive: (game, player) => {
            game.players.forEach(p => { p.dice = p.dice.map(() => Math.floor(Math.random() * 6) + 1); });
            return { success: true, msg: 'Метель перебросила все кубики на столе!', publicMsg: `${player.name} вызывает Метель! Все кости перемешаны!` };
        }
    },
    'hat_miasmas': {
        passiveName: 'Заражённый стол',
        activeName: 'Туча миазм',
        activeUses: 1,
        executeActive: (game, player) => {
            game.miasmaCloud = true;
            return { success: true, msg: 'Туча миазм накрыла стол! Проигравший потеряет дополнительный куб.', publicMsg: `${player.name} выпускает Тучу миазм! Дышать становится тяжелее...` };
        }
    }
};

function handleActiveSkill(game, player) {
    if (!game.config || !game.config.crazy) return { error: 'Навыки работают только в режиме "Безумный стол"!' };
    
    const hatId = player.equipped?.hat; 
    if (!hatId) return { error: 'У вас не надета шляпа!' };

    const skill = SKILLS[hatId];
    if (!skill || !skill.executeActive) return { error: 'У этой шляпы пока нет активного навыка в коде сервера.' };
    
    player.skillsUsed = player.skillsUsed || [];
    if (player.skillsUsed.includes(hatId)) return { error: 'Вы уже использовали этот навык в текущей игре.' };
    
    const result = skill.executeActive(game, player);
    if (result.success) {
        player.skillsUsed.push(hatId);
        result.skillName = skill.activeName;
    }
    return result;
}

function triggerPassiveSkill(game, player, eventType) {
    if (!game.config || !game.config.crazy) return null;
    const hatId = player.equipped?.hat;
    const skill = SKILLS[hatId];
    if (skill && skill.executePassive) return skill.executePassive(game, player, eventType);
    return null;
}

module.exports = { SKILLS, handleActiveSkill, triggerPassiveSkill };
