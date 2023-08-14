const path = require('path');
require('dotenv').config();

process.env.TZ = 'Asia/Shanghai';

const crypto = require('crypto');
const Web3 = require('web3').Web3;
const MTProto = require('@mtproto/core');
const { sleep } = require('@mtproto/core/src/utils/common');
const { Telegraf } = require('telegraf');
const redis = require("redis");
const fs = require('fs');

const web3 = new Web3(process.env.WEB3_URL);
const bot = new Telegraf(process.env.BOT_TOKEN);
const client = redis.createClient({
    url: process.env.REDIS_URL
});

client.on('error', (err) => {
    console.log('Redis ' + err);
});

client.on('ready', () => {
    console.log('Redis Ready');
});

client.connect().then(() => {
    console.log('Redis Connected');
});

function dateFormat(fmt, date) {
    let ret;
    const opt = {
        "Y+": date.getFullYear().toString(),
        "m+": (date.getMonth() + 1).toString(),
        "d+": date.getDate().toString(),
        "H+": date.getHours().toString(),
        "M+": date.getMinutes().toString(),
        "S+": date.getSeconds().toString()
    };
    for (let k in opt) {
        ret = new RegExp("(" + k + ")").exec(fmt);
        if (ret) {
            fmt = fmt.replace(ret[1], (ret[1].length === 1) ? (opt[k]) : (opt[k].padStart(ret[1].length, "0")));
        }
    }
    return fmt;
}

const getTodayDateString = () => {
    return dateFormat('YYYY-mm-dd', new Date());
}

const SPECIAL_CHARS = [
    '\\',
    '_',
    '*',
    '[',
    ']',
    '(',
    ')',
    '~',
    '`',
    '>',
    '<',
    '&',
    '#',
    '+',
    '-',
    '=',
    '|',
    '{',
    '}',
    '.',
    '!'
]

const escapeMarkdown = (text) => {
    text += '';
    SPECIAL_CHARS.forEach(char => (text = text.replaceAll(char, `\\${char}`)))
    return text
}

class API {
    constructor() {
      this.mtproto = new MTProto({
        api_id: process.env.API_ID,
        api_hash: process.env.API_HASH,
        storageOptions: {
        path: path.resolve(__dirname, './data/mtp.json'),
    }
      });
      this.isDcId = false;
    }

    async call(method, params, options = {}) {
      try {
        if (this.isDcId) {
          Object.assign(options, { dcId: this.isDcId });
        }
        const result = await this.mtproto.call(method, params, options);
  
        return result;
      } catch (error) {
        console.log(`${method} error:`, error);
  
        const { error_code, error_message } = error;
  
        if (error_code === 420) {
          const seconds = Number(error_message.split('FLOOD_WAIT_')[1]);
          const ms = seconds * 1000;
  
          await sleep(ms);
  
          return this.call(method, params, options);
        }
  
        if (error_code === 303) {
          const [type, dcIdAsString] = error_message.split('_MIGRATE_');
  
          const dcId = Number(dcIdAsString);
  
          this.isDcId = dcId;

          // If auth.sendCode call on incorrect DC need change default DC, because
          // call auth.signIn on incorrect DC return PHONE_CODE_EXPIRED error
          if (type === 'PHONE') {
            await this.mtproto.setDefaultDc(dcId);
          } else {
            Object.assign(options, { dcId });
          }
  
          return this.call(method, params, options);
        }
  
        return Promise.reject(error);
      }
    }
}

const api = new API();

const checkisAuthKey = () => {
    const storage = JSON.parse(fs.readFileSync(path.resolve(__dirname, './data/mtp.json')));
    if(storage['1authKey'] || storage['2authKey'] || storage['3authKey'] || storage['4authKey'] || storage['5authKey']) return true;
    return false;
}

if(checkisAuthKey) {
    api.mtproto.syncAuth(0).catch((e) => {
        console.log('syncAuth error:', e);
    });
} else {
    api.call('auth.importBotAuthorization', {
        flags: 0,
        api_id: process.env.API_ID,
        api_hash: process.env.API_HASH,
        bot_auth_token: process.env.BOT_TOKEN,
    }).then(result => {
        console.log('result:', result);
    }
    ).catch(error => {
        console.log('error:', error);
    });
}

const addSha256ToUserList = (list) => {
    const Return = [];
    for (const user of list) {
        if(user.bot) continue;
        const hash = crypto.createHash('sha256');
        hash.update(`${user.id}.${getTodayDateString()}`);
        user.sha256 = hash.digest('hex');
        Return.push(user);
    }
    return Return;
}

const getChatMembers = async (chatId, chatType, userName) => {
    const rawRedis = await client.get('waifu:chatMembers:'  + getTodayDateString() + ':' + chatId);
    if (rawRedis) return JSON.parse(rawRedis);
    if(chatType === 'group') {
        const FullChat = await api.call('messages.getFullChat', {
            chat_id: chatId.toString().replace('-', ''),
        });
        const addSha256 = addSha256ToUserList(FullChat.users);
        await client.set('waifu:chatMembers:'  + getTodayDateString() + ':' + chatId, JSON.stringify(addSha256), 'EX', 86400);
        return addSha256;
    }
    else {
        const Channel = await api.call('channels.getChannels', {
            id: [{
                _: 'inputChannel',
                channel_id: chatId.toString().replace('-100', ''),
                access_hash: 0,
            }],
        });
        const memberCount = await bot.telegram.getChatMembersCount(chatId);
        let offset = 0;
        const Return = [];
        do {
            const getParticipants = await api.call('channels.getParticipants', {
                channel: {
                    _: 'inputChannel',
                    channel_id: Channel.chats[0].id,
                    access_hash: Channel.chats[0].access_hash,
                },
                filter: {
                    _: 'channelParticipantsRecent',
                },
                offset: offset,
                limit: 200,
                hash: 0,
            });
            for (const user of getParticipants.users) {
                Return.push(user);
                offset++;
            }
        }
        while(offset < memberCount && offset < 1000);
        const addSha256 = addSha256ToUserList(Return);
        await client.set('waifu:chatMembers:'  + getTodayDateString() + ':' + chatId, JSON.stringify(addSha256), 'EX', 86400);
        return addSha256;
    }
    
};

bot.command('eth_waifu', async (ctx) => {
    console.log(ctx.chat)
    if (ctx.chat.type === 'private') {
        ctx.reply('请在群组中使用！', {
            reply_to_message_id: ctx.message.message_id
        });
        return;
    }
    const chatId = ctx.chat.id;
    const senderId = ctx.message.from.id;
    const chatType = ctx.chat.type;
    const userName = ctx.chat.username;


    let chatMembers = await getChatMembers(chatId, chatType, userName);

    try {
        const senderSha256 = chatMembers.find((user) => {
            return Number(user.id) === senderId;
        }).sha256;
    }
    catch (e) {
        ctx.reply('发生Bug了！', {
            reply_to_message_id: ctx.message.message_id
        });
    }
    const senderSha256 = chatMembers.find((user) => {
        return Number(user.id) === senderId;
    }).sha256;
    

    const waifuResult = await client.get('waifu:result:'  + getTodayDateString() + ':' + chatId + ':' + senderId);
    if (waifuResult) {
        const waifuResultJSON = JSON.parse(waifuResult);
        if(waifuResultJSON.waifu.photo) {
            try {
                const photos = await bot.telegram.getUserProfilePhotos(waifuResultJSON.waifu.id);
                if(photos.total_count > 0) {
                    const photo = photos.photos[0][photos.photos[0].length - 1];
                    ctx.replyWithPhoto(photo.file_id, {
                        caption: `今日的老婆是：[${escapeMarkdown(waifuResultJSON.waifu.first_name)} ${waifuResultJSON.waifu.last_name ? escapeMarkdown(waifuResultJSON.waifu.last_name) : ''}](tg://user?id=${waifuResultJSON.waifu.id})\n\n*结果溯源*\n你的Hash:\`${'0x' + waifuResultJSON.senderSha256}\`\nETH最新区块:\`${waifuResultJSON.blockNumber}\`\n最新区块Hash：\`${waifuResultJSON.blockHash}\`\n抽取基数:\`${waifuResultJSON.memberLength}\`\n时间戳:\`${waifuResultJSON.timestamp}\``,
                        parse_mode: 'MarkdownV2',
                        reply_to_message_id: ctx.message.message_id
                    });
                    return;
                }
            }
            catch(e) {

            }
        }
        ctx.reply(`今日的老婆是：[${escapeMarkdown(waifuResultJSON.waifu.first_name)} ${waifuResultJSON.waifu.last_name ? escapeMarkdown(waifuResultJSON.waifu.last_name) : ''}](tg://user?id=${waifuResultJSON.waifu.id})\n\n*结果溯源*\n你的Hash:\`${'0x' + waifuResultJSON.senderSha256}\`\nETH最新区块:\`${waifuResultJSON.blockNumber}\`\n最新区块Hash：\`${waifuResultJSON.blockHash}\`\n抽取基数:\`${waifuResultJSON.memberLength}\`\n时间戳:\`${waifuResultJSON.timestamp}\``, {
            parse_mode: 'MarkdownV2',
            reply_to_message_id: ctx.message.message_id
        });
    } else {
        const blockNumber = await web3.eth.getBlockNumber();
        const timestamp = new Date().getTime();
        const block = await web3.eth.getBlock(blockNumber);
        const decimalBlockHash = BigInt(block.hash).toString(10);
        const decimalSenderHash = BigInt('0x' + senderSha256).toString(10);
        const waifuId = (Number(decimalBlockHash) + Number(decimalSenderHash)) % chatMembers.length;
        const waifu = chatMembers[waifuId];
        await client.set('waifu:result:'  + getTodayDateString() + ':' + chatId + ':' + senderId, JSON.stringify({waifu,blockNumber: blockNumber.toString(10),blockHash: block.hash,timestamp,senderSha256,memberLength: chatMembers.length}), 'EX', 86400);
        if(waifu.photo) {
            try {
                const photos = await bot.telegram.getUserProfilePhotos(waifu.id);
                if(photos.total_count > 0) {
                    const photo = photos.photos[0][photos.photos[0].length - 1];
                    ctx.replyWithPhoto(photo.file_id, {
                        caption: `今日的老婆是：[${escapeMarkdown(waifu.first_name)} ${waifu.last_name ? escapeMarkdown(waifu.last_name) : ''}](tg://user?id=${waifu.id})\n\n*结果溯源*\n你的Hash:\`${'0x' + senderSha256}\`\nETH最新区块:\`${blockNumber.toString(10)}\`\n最新区块Hash：\`${block.hash}\`\n抽取基数:\`${chatMembers.length}\`\n时间戳:\`${timestamp}\``,
                        parse_mode: 'MarkdownV2',
                        reply_to_message_id: ctx.message.message_id
                    });
                    return;
                    }
                    
                }
            catch(e) {

            }
        }
        ctx.reply(`今日的老婆是：[${escapeMarkdown(waifu.first_name)} ${waifu.last_name ? escapeMarkdown(waifu.last_name) : ''}](tg://user?id=${waifu.id})\n\n*结果溯源*\n你的Hash:\`${'0x' + senderSha256}\`\nETH最新区块:\`${blockNumber.toString(10)}\`\n最新区块Hash：\`${block.hash}\`\n抽取基数:\`${chatMembers.length}\`\n时间戳:\`${timestamp}\``, {
            parse_mode: 'MarkdownV2',
            reply_to_message_id: ctx.message.message_id
        });
    }
});

bot.launch();