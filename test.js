require('dotenv').config();

const { Telegraf } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN);

(async () => {
    console.log(await bot.telegram.getUserProfilePhotos(1917599405));
})();