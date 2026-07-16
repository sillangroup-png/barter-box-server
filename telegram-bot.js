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

// Один и тот же блогер может делать несколько интеграций в разные даты
// (например, @luinaofficial 16 июля, 20 июля, 30 июля — три разные записи
// в influencerDeals). Поэтому ищем ВСЕ совпадения по логину, а не первое.
function findDealsByLogin(state, login){
  const target = normalizeLogin(login);
  if(!target) return [];
  return state.influencerDeals.filter(d => normalizeLogin(d.blogerLogin) === target);
}

// Оставлено для обратной совместимости (возвращает первое совпадение).
function findDealByLogin(state, login){
  return findDealsByLogin(state, login)[0] || null;
}

// Разбирает дату из подписи в формат YYYY-MM-DD (как хранится в plannedDate/publishedDate).
// Понимает: 20.07, 20.07.2026, 2026-07-20, 20/07.
function parseDateToken(token){
  if(!token) return null;
  const t = token.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  m = t.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/);
  if(m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  m = t.match(/^(\d{1,2})[.\/](\d{1,2})$/);
  if(m){
    const year = new Date().getFullYear();
    return `${year}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  }
  return null;
}

function dealDateLabel(d){
  return d.publishedDate || d.plannedDate || "без даты";
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

function sniffImageMediaType(buf){
  if(buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if(buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if(buf.length >= 6 && buf.toString("ascii", 0, 6) === "GIF87a") return "image/gif";
  if(buf.length >= 6 && buf.toString("ascii", 0, 6) === "GIF89a") return "image/gif";
  if(buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/jpeg";
}

async function analyzeScreenshot(anthropicKey, model, imageBuffer){
  const base64 = imageBuffer.toString("base64");
  const mediaType = sniffImageMediaType(imageBuffer);
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
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {type: "image", source: {type: "base64", media_type: mediaType, data: base64}},
            {type: "text", text: prompt},
          ],
        },
      ],
    }),
  });
  const data = await resp.json();
  if(data.error) throw new Error(data.error.message || "Ошибка Anthropic API");
  // Модель может вернуть несколько блоков контента (например, "thinking" перед "text") —
  // берём и склеиваем именно текстовые блоки, а не слепо content[0].
  const blocks = Array.isArray(data.content) ? data.content : [];
  const fullText = blocks.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
  console.log("Telegram-бот: сырой ответ модели (для отладки):", JSON.stringify(data.content).slice(0, 800));
  const match = fullText.match(/\{[\s\S]*\}/);
  if(!match){
    console.error("Telegram-бот: модель не вернула JSON, сырой ответ:", fullText.slice(0, 500));
    throw new Error("модель не смогла распознать данные на скриншоте, попробуйте другой скриншот (крупнее/чётче)");
  }
  try{
    return JSON.parse(match[0]);
  }catch(e){
    console.error("Telegram-бот: не удалось распарсить JSON от модели:", fullText.slice(0, 500));
    throw new Error("не удалось разобрать ответ модели, попробуйте ещё раз");
  }
}

function startTelegramBot(state, persist){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

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
      "Я распознаю цифры на скриншоте и обновлю данные во вкладке «Инфлюенс интеграции крупные».\n\n" +
      "Если у блогера несколько интеграций в разные даты, добавьте дату поста через пробел, " +
      "например: @dana.style 20.07 — иначе я уточню, какую именно дату вы имеете в виду."
    );
  });

  bot.on("photo", async (msg)=>{
    const chatId = msg.chat.id;
    const caption = (msg.caption || "").trim();
    if(!caption){
      bot.sendMessage(chatId, "Добавьте подпись к фото — логин блогера (например: @dana.style) — и отправьте ещё раз.");
      return;
    }
    const tokens = caption.split(/\s+/);
    const loginToken = tokens[0];
    const dateToken = tokens.slice(1).join(" ").trim();

    const matches = findDealsByLogin(state, loginToken);
    if(matches.length === 0){
      bot.sendMessage(chatId, `Блогер «${loginToken}» не найден среди интеграций «Инфлюенс крупные». Сначала добавьте интеграцию в приложении, затем присылайте скриншоты.`);
      return;
    }

    let deal = null;
    if(matches.length === 1){
      deal = matches[0];
    }else{
      // У блогера несколько интеграций (разные даты постов) — без даты в подписи
      // непонятно, какую запись обновлять, поэтому просим уточнить.
      const parsedDate = parseDateToken(dateToken);
      if(parsedDate){
        deal = matches.find(d => d.publishedDate === parsedDate || d.plannedDate === parsedDate) || null;
      }
      if(!deal){
        const optionsList = matches.map(d => `• ${dealDateLabel(d)} (${d.status || "—"}, ${d.platform || ""})`).join("\n");
        bot.sendMessage(chatId,
          `У блогера «${loginToken}» несколько интеграций «Инфлюенс крупные» — уточните дату поста в подписи, ` +
          `например: «${loginToken} 20.07».\n\nДоступные даты:\n${optionsList}`
        );
        return;
      }
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
        `Обновлено: ${deal.blogerLogin} (интеграция от ${dealDateLabel(deal)})`,
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

module.exports = { startTelegramBot, findDealByLogin, findDealsByLogin, parseDateToken };
