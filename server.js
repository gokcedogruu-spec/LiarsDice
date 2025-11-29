require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const token = process.env.TELEGRAM_BOT_TOKEN;

const bot = token ? new TelegramBot(token, { polling: true }) : null;

if (bot) {
    console.log('Bot started...');

    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const text = (msg.text || '').trim();
        
        // --- ТЕСТОВАЯ ССЫЛКА НА GOOGLE ---
        // Если это сработает, значит проблема была в твоей ссылке
        const TEST_URL = 'https://google.com'; 

        console.log(`[MSG] From: ${chatId}, Text: "${text}"`);

        if (text.toLowerCase().includes('/start')) {
            console.log(`[DEBUG] Пытаюсь отправить кнопку с ссылкой: ${TEST_URL}`);

            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        // Кнопка 1: Обычная ссылка (Проверка)
                        [{ text: "🔗 Просто ссылка", url: TEST_URL }],
                        // Кнопка 2: WebApp (То, что нам нужно)
                        [{ text: "🚀 WebApp Google", web_app: { url: TEST_URL } }]
                    ]
                }
            };
            
            bot.sendMessage(chatId, 'Тест кнопок:', opts)
                .then(() => console.log(`[SUCCESS] Кнопки отправлены!`))
                .catch((err) => {
                    console.error(`[ERROR] ОШИБКА:`, err.message);
                    console.error(`[DEBUG] Объект ошибки:`, JSON.stringify(err.response ? err.response.body : err));
                });
        }
    });
}

app.use(express.static(path.join(__dirname, 'public')));
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
