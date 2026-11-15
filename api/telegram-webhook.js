import { neon } from '@neondatabase/serverless';

const PAGE_SIZE = 1;
const MAX_PAGE = 999;
const STATUS_NAMES = {
  new: 'Нове',
  processing: 'Збирається',
  shipped: 'Відправлено',
  completed: 'Завершено',
  cancelled: 'Скасовано'
};
const STATUS_BUTTONS = [
  { value: 'new', text: 'Нове' },
  { value: 'processing', text: 'Обробка' },
  { value: 'shipped', text: 'Відправлено' },
  { value: 'completed', text: 'Завершено' },
  { value: 'cancelled', text: 'Скасовано' }
];

function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return {};
}

function formatOrderNumber(value) {
  return String(value).padStart(6, '0');
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function cleanText(value, maxLength = 250) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
}

function formatOrder(order) {
  const date = new Date(order.created_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  const total = Number(order.total_price).toLocaleString('uk-UA');
  const customerName = cleanText(order.customer_name || 'Клієнт', 100);
  const phone = cleanText(order.phone, 40);
  const address = cleanText(order.delivery_info || 'Не вказана');
  const status = STATUS_NAMES[order.status] || order.status;

  return [
    `🔹 Замовлення #${formatOrderNumber(order.order_number)}`,
    `👤 ${customerName}`,
    `📞 ${phone}`,
    `📍 ${address}`,
    `💰 ${total} грн · ${status}`,
    `📅 ${date}`
  ].join('\n');
}

async function telegramApi(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram API rejected ${method}: ${result.description || response.statusText}`);
  }
  return result.result;
}

function scopeFromCode(code) {
  if (code === 'a') return 'archive';
  if (code === 'o') return 'orders';
  return null;
}

function scopeCode(scope) {
  return scope === 'archive' ? 'a' : 'o';
}

async function getOrdersPage(sql, scope, page) {
  const limit = PAGE_SIZE + 1;
  const offset = page * PAGE_SIZE;
  if (scope === 'archive') {
    return sql`
      SELECT id, order_number, customer_name, phone, delivery_info, total_price, status, created_at
      FROM orders
      WHERE status = 'completed'
      ORDER BY created_at DESC, order_number DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }
  return sql`
    SELECT id, order_number, customer_name, phone, delivery_info, total_price, status, created_at
    FROM orders
    ORDER BY created_at DESC, order_number DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

async function showOrdersPage(token, chatId, sql, scope, page, editTarget) {
  let orders = await getOrdersPage(sql, scope, page);
  while (orders.length === 0 && page > 0) {
    page -= 1;
    orders = await getOrdersPage(sql, scope, page);
  }

  const hasNext = orders.length > PAGE_SIZE;
  const visibleOrders = orders.slice(0, PAGE_SIZE);
  const title = scope === 'archive' ? '🗃 Архів завершених замовлень' : '📦 Останні замовлення';
  const text = visibleOrders.length
    ? `${title} · сторінка ${page + 1}\n\n${visibleOrders.map(formatOrder).join('\n\n')}`
    : scope === 'archive'
      ? 'Архів порожній.'
      : 'Поки що немає жодного замовлення в базі.';

  const inlineKeyboard = [];
  for (const order of visibleOrders) {
    if (order.status === 'completed') {
      inlineKeyboard.push([{
        text: `🗑 Видалити #${formatOrderNumber(order.order_number)}`,
        callback_data: `d|${order.id}|${scopeCode(scope)}|${page}`
      }]);
    }
    inlineKeyboard.push(
      STATUS_BUTTONS.slice(0, 3).map(status => ({
        text: `${order.status === status.value ? '✓ ' : ''}${status.text}`,
        callback_data: `s|${order.id}|${status.value}|${scopeCode(scope)}|${page}`
      })),
      STATUS_BUTTONS.slice(3).map(status => ({
        text: `${order.status === status.value ? '✓ ' : ''}${status.text}`,
        callback_data: `s|${order.id}|${status.value}|${scopeCode(scope)}|${page}`
      }))
    );
  }
  const pageControls = [];
  if (page > 0) pageControls.push({ text: '⬅️ Назад', callback_data: `p|${scopeCode(scope)}|${page - 1}` });
  if (hasNext) pageControls.push({ text: 'Далі ➡️', callback_data: `p|${scopeCode(scope)}|${page + 1}` });
  if (pageControls.length) inlineKeyboard.push(pageControls);

  const payload = {
    chat_id: chatId,
    text,
    ...(editTarget || inlineKeyboard.length ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
  };
  if (editTarget) {
    await telegramApi(token, 'editMessageText', { ...payload, message_id: editTarget.messageId });
  } else {
    await telegramApi(token, 'sendMessage', payload);
  }
  return page;
}

async function answerCallback(token, callbackQueryId, text) {
  await telegramApi(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {})
  });
}

async function handleCallback(token, sql, callbackQuery) {
  const message = callbackQuery.message;
  const data = String(callbackQuery.data || '').split('|');
  const editTarget = { messageId: message.message_id };

  if (data[0] === 'p') {
    const scope = scopeFromCode(data[1]);
    const page = Number(data[2]);
    if (!scope || !Number.isInteger(page) || page < 0 || page > MAX_PAGE) {
      await answerCallback(token, callbackQuery.id, 'Невірна сторінка');
      return;
    }
    await showOrdersPage(token, message.chat.id, sql, scope, page, editTarget);
    await answerCallback(token, callbackQuery.id);
    return;
  }

  if (data[0] === 's' && isUuid(data[1])) {
    const status = data[2];
    const scope = scopeFromCode(data[3]);
    const page = Number(data[4]);
    if (!Object.prototype.hasOwnProperty.call(STATUS_NAMES, status) ||
      !scope || !Number.isInteger(page) || page < 0 || page > MAX_PAGE) {
      await answerCallback(token, callbackQuery.id, 'Невірна команда');
      return;
    }
    const updated = await sql`
      UPDATE orders SET status = ${status}
      WHERE id = ${data[1]}
      RETURNING order_number
    `;
    await answerCallback(token, callbackQuery.id, updated.length
      ? `Статус: ${STATUS_NAMES[status]}`
      : 'Замовлення не знайдено');
    await showOrdersPage(token, message.chat.id, sql, scope, page, editTarget);
    return;
  }

  if (data[0] === 'd' && isUuid(data[1])) {
    const scope = scopeFromCode(data[2]);
    const page = Number(data[3]);
    if (!scope || !Number.isInteger(page) || page < 0 || page > MAX_PAGE) {
      await answerCallback(token, callbackQuery.id, 'Невірна команда');
      return;
    }
    const orderNumber = await sql`
      SELECT order_number FROM orders
      WHERE id = ${data[1]} AND status = 'completed'
    `;
    if (orderNumber.length === 0) {
      await answerCallback(token, callbackQuery.id, 'Замовлення не знайдено або воно ще не завершене');
      await showOrdersPage(token, message.chat.id, sql, scope, page, editTarget);
      return;
    }
    const number = formatOrderNumber(orderNumber[0].order_number);
    await telegramApi(token, 'editMessageText', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `Видалити завершене замовлення #${number}?`,
      reply_markup: {
        inline_keyboard: [[
          { text: 'Так, видалити', callback_data: `x|${data[1]}|${data[2]}|${page}` },
          { text: 'Скасувати', callback_data: `c|${data[2]}|${page}` }
        ]]
      }
    });
    await answerCallback(token, callbackQuery.id);
    return;
  }

  if (data[0] === 'x' && isUuid(data[1])) {
    const scope = scopeFromCode(data[2]);
    const page = Number(data[3]);
    if (!scope || !Number.isInteger(page) || page < 0 || page > MAX_PAGE) {
      await answerCallback(token, callbackQuery.id, 'Невірна команда');
      return;
    }
    const deleted = await sql`
      DELETE FROM orders
      WHERE id = ${data[1]} AND status = 'completed'
      RETURNING order_number
    `;
    await answerCallback(token, callbackQuery.id, deleted.length ? 'Замовлення видалено' : 'Замовлення не знайдено');
    await showOrdersPage(token, message.chat.id, sql, scope, page, editTarget);
    return;
  }

  if (data[0] === 'c') {
    const scope = scopeFromCode(data[1]);
    const page = Number(data[2]);
    if (!scope || !Number.isInteger(page) || page < 0 || page > MAX_PAGE) {
      await answerCallback(token, callbackQuery.id, 'Невірна команда');
      return;
    }
    await showOrdersPage(token, message.chat.id, sql, scope, page, editTarget);
    await answerCallback(token, callbackQuery.id);
    return;
  }

  await answerCallback(token, callbackQuery.id, 'Невідома команда');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !webhookSecret || !adminChatId) {
    console.error('Telegram webhook is missing required environment configuration');
    return res.status(503).json({ error: 'Telegram webhook is not configured' });
  }

  if (req.headers['x-telegram-bot-api-secret-token'] !== webhookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = getBody(req);
    const callbackQuery = body && body.callback_query;
    const message = body && body.message;
    const chatId = callbackQuery
      ? callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id
      : message && message.chat && message.chat.id;
    if (String(chatId) !== String(adminChatId)) {
      if (callbackQuery) await answerCallback(token, callbackQuery.id);
      return res.status(200).json({ ok: true });
    }

    if (callbackQuery) {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
      await handleCallback(token, neon(process.env.DATABASE_URL), callbackQuery);
      return res.status(200).json({ ok: true });
    }
    if (!message || typeof message.text !== 'string') return res.status(200).json({ ok: true });

    const text = message.text.trim();
    const command = text.split(/\s+/, 1)[0];
    const buttonText = text.replace(/^📦\s*/, '').replace(/^🗃\s*/, '').toLowerCase();
    if (/^\/start(?:@[a-zA-Z0-9_]+)?$/i.test(command)) {
      await telegramApi(token, 'sendMessage', {
        chat_id: chatId,
        text: 'Вітаємо у ВольтЗапас! Оберіть потрібну дію в меню нижче:',
        reply_markup: {
          keyboard: [
            [{ text: '📦 Мої замовлення' }],
            [{ text: '🗃 Архів' }]
          ],
          resize_keyboard: true,
          is_persistent: true
        }
      });
      return res.status(200).json({ ok: true });
    }

    const isArchive = /^\/archive(?:@[a-zA-Z0-9_]+)?$/i.test(command) ||
      buttonText === 'архів' || buttonText === 'архів замовлень';
    const isOrders = /^\/orders(?:@[a-zA-Z0-9_]+)?$/i.test(command) || buttonText === 'мої замовлення';
    if (!isArchive && !isOrders) return res.status(200).json({ ok: true });

    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
    await showOrdersPage(token, chatId, neon(process.env.DATABASE_URL), isArchive ? 'archive' : 'orders', 0);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
