// Здесь хранятся все настройки игры, чтобы не забивать основной сервер
const RANKS = [
    { name: "Салага", min: 0, level: 0 },
    { name: "Юнга", min: 500, level: 1 },
    { name: "Матрос", min: 1500, level: 2 },
    { name: "Старший матрос", min: 5000, level: 3 },
    { name: "Боцман", min: 10000, level: 4 }, 
    { name: "Первый помощник", min: 25000, penalty: 30, level: 5 }, 
    { name: "Капитан", min: 50000, penalty: 60, level: 6 }, 
    { name: "Легенда морей", min: 75000, reqStreak: 100, penalty: 100, level: 7 }
];

const HATS = {
    'hat_fallen': { price: 1000000, level: 6 }, 'hat_rich': { price: 1000000, level: 6 },
    'hat_underwater': { price: 1000000, level: 6 }, 'hat_voodoo': { price: 1000000, level: 6 },
    'hat_king_voodoo': { price: 10000000, level: 6 }, 'hat_cursed': { price: 10000000, level: 6 },
    'hat_flame': { price: 10000000, level: 6 }, 'hat_frozen': { price: 10000000, level: 6 },
    'hat_ghost': { price: 10000000, level: 6 }, 'hat_lava': { price: 100000000, level: 7 },
    'hat_deadlycursed': { price: 100000000, level: 7 }, 'hat_antarctica': { price: 100000000, level: 7 },
    'hat_poison': { price: 10000000, level: 6 }, 'hat_miasmas': { price: 100000000, level: 7 }
};

// Экспортируем (даем доступ другим файлам)
module.exports = { RANKS, HATS };
