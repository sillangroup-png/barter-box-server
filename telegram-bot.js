// Telegram-бот: оператор шлёт скриншот статистики Instagram-поста с подписью —
// логином блогера (например "@dana.style") — бот распознаёт цифры через
// Anthropic API (зрение) и обновляет соответствующую запись в influencerDeals.
//
// Работает в том же процессе, что и веб-сервер (long polling, без вебхука и без
// отдельного платного сервиса на Render). Включается только если заданы ОБА
// env var'а: TELEGRAM_BOT_TOKEN и ANTHROPIC_API_KEY — если их нет, тихо не стартует.
"use strict";

function normalizeLogin(s){
  return String(s || "").trim().toLowerCase().replace(/^@/, "");
}

function findDealByLogin(state, login){
  const target = normalizeLogin(login);
  if(!target) return null;
  return state.influencerDeals.find(d => normalizeLogin(d.blogerLogin) === target) || null;
}

async function downloadTelegramFile(token, fileId){
  const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if(!info.ok) throw new Error("Не удалось получить файл из Telegram: " + (info.description || ""));
  const filePath = info.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const arrBuf = await fileRes.arrayBuffer();
  return Buffer.from(arrBuf);
}

async function analyzeScreenshot(anthropicKey, model, imageBuffer){
  const base64 = imageBuffer.toString("base64");
  const prompt = "Это скриншот статистики публикации в Instagram (Reels/Stories/пост). " +
    "Извлеки числовые метрики, которые видно на изображении: просмотры/охват, лайки, комментарии, " +
    "сохранения, переходы по ссылке/клики (если есть). Если какой-то метрики не видно — верни null. " +
    "Ответь СТРОГО одним JSON-объектом без пояснений и без markdown-разметки, например: " +
    '{"views":15400,"likes":780,"comments":71,"saves":120,"clicks":null}';
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          {type: "image", source: {type: "base64", media_type: "image/jpeg", data: base64}},
          {type: "text", text: prompt},
        ],
      }],
    }),
  });
  const data = await resp.json();
  if(data.error) throw new Error(data.error.message || "Ошибка Anthropic API");
  const text = (data.content && data.content[0] && data.content[0].text) || "";
  const match = text.match(/\{[\s\S]*\}/);
  if(!match) throw new Error("Модель не вернула JSON: " + text.slice(0, 200));
  return JSON.parse(match[0]);
}

function startTelegramBot(state, persist){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

  if(!token){
    console.log("TELEGRAM_BOT_TOKEN не задан — Telegram-бот для инфлюенс-статистики выключен.");
    return null;
  }
  if(!anthropicKey){
    console.log("ANTHROPIC_API_KEY не задан — Telegram-бот выключен (нечем распознавать скриншоты).");
    return null;
  }

  let TelegramBot;
  try{ TelegramBot = require("node-telegram-bot-api"); }
  catch(e){ console.error("Пакет node-telegram-bot-api не установлен:", e.message); return null; }

  const bot = new TelegramBot(token, {polling: true});
  console.log("Telegram-бот для инфлюенс-статистики запущен.");

  bot.onText(/\/start/, (msg)=>{
    bot.sendMessage(msg.chat.id,
      "Пришлите скриншот статистики Instagram-поста с подписью — логином блогера (например: @dana.style).\n" +
      "Я распознаю цифры на скриншоте и обновлю данные во вкладке «Инфлюенс интеграции крупные»."
    );
  });

  bot.on("photo", async (msg)=>{
    const chatId = msg.chat.id;
    const caption = (msg.caption || "").trim();
    if(!caption){
      bot.sendMessage(chatId, "Добавьте подпись к фото — логин блогера (например: @dana.style) — и отправьте ещё раз.");
      return;
    }
    const deal = findDealByLogin(state, caption);
    if(!deal){
      bot.sendMessage(chatId, `Блогер «${caption}» не найден среди интеграций «Инфлюенс крупные». Сначала добавьте интеграцию в приложении, затем присылайте скриншоты.`);
      return;
    }
    try{
      bot.sendMessage(chatId, "Читаю скриншот…");
      const sizes = msg.photo;
      const photo = sizes[sizes.length - 1];
      const buf = await downloadTelegramFile(token, photo.file_id);
      const stats = await analyzeScreenshot(anthropicKey, model, buf);

      if(stats.views != null) deal.reach = stats.views;
      if(stats.clicks != null) deal.clicks = stats.clicks;
      if(stats.likes != null) deal.likes = stats.likes;
      if(stats.comments != null) deal.comments = stats.comments;
      if(stats.saves != null) deal.saves = stats.saves;
      deal.lastUpdatedFrom = "telegram";
      deal.lastUpdatedAt = new Date().toISOString();
      persist();

      const lines = [
        `Обновлено: ${deal.blogerLogin}`,
        `Охват: ${stats.views ?? "—"}`,
        `Лайки: ${stats.likes ?? "—"} · Комментарии: ${stats.comments ?? "—"} · Сохранения: ${stats.saves ?? "—"}`,
      ];
      if(stats.clicks != null) lines.push(`Клики: ${stats.clicks}`);
      lines.push("Данные уже видны на вкладке «Инфлюенс интеграции крупные».");
      bot.sendMessage(chatId, lines.join("\n"));
    }catch(e){
      console.error("Ошибка обработки скриншота от Telegram-бота:", e.message);
      bot.sendMessage(chatId, "Не получилось распознать скриншот: " + e.message);
    }
  });

  bot.on("polling_error", (err)=> console.error("Telegram polling error:", err.message));

  return bot;
}

module.exports = { startTelegramBot, findDealByLogin };
