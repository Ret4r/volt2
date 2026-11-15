import { neon } from '@neondatabase/serverless';

const getSql = () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }
  return neon(process.env.DATABASE_URL);
};

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function formatOrderNumber(value) {
  return String(value).padStart(6, '0');
}

async function notifyTelegram(order) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('Telegram order notification skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured');
    return;
  }

  const items = Array.isArray(order.items) ? order.items : [];
  const itemsList = items.map(item => {
    const name = item.name || item.title || 'Товар';
    const quantity = Number(item.qty || item.quantity || 1);
    const price = Number(item.price || 0);
    return `• ${name} (×${quantity}) — ${price} грн`;
  }).join('\n') || 'Немає даних про товари';
  const message = [
    `Нове замовлення #${formatOrderNumber(order.order_number)} на ВольтЗапас!`,
    '',
    `👤Клієнт: ${order.customer_name || ''}`,
    `📱Телефон: ${order.phone || ''}`,
    `🚘Доставка: ${order.delivery_info || ''}`,
    '',
    '🗂️Товари:',
    itemsList,
    '',
    `💰Сума: ${order.total_price} грн`
  ].join('\n');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram API rejected order notification: ${result.description || response.statusText}`);
  }
}

export default async function handler(req, res) {
  setNoStore(res);

  try {
    const sql = getSql();
    const body = req.body && typeof req.body === 'object' ? req.body : typeof req.body === 'string' ? JSON.parse(req.body || '{}') : {};
    const adminPassword = process.env.ADMIN_PASSWORD;
    const isAdmin = Boolean(adminPassword) && req.headers['x-admin-password'] === adminPassword;

    if (req.method === 'POST') {
      const { customer_name, phone, delivery_info, delivery_city, delivery_branch, comment, items, total_price } = body;
      if (comment != null && typeof comment !== 'string') {
        return res.status(400).json({ error: 'Коментар має бути текстом' });
      }
      const orderComment = typeof comment === 'string' ? comment.trim() : '';
      if (orderComment.length > 500) {
        return res.status(400).json({ error: 'Коментар має містити не більше 500 символів' });
      }
      const city = typeof delivery_city === 'string' ? delivery_city.trim() : '';
      const branch = typeof delivery_branch === 'string' ? delivery_branch.trim() : '';
      const orderInfo = [
        city ? `Місто: ${city}` : '',
        branch ? `Відділення: ${branch}` : '',
        !city && !branch && typeof delivery_info === 'string' ? delivery_info.trim() : '',
        orderComment ? `Коментар: ${orderComment}` : ''
      ].filter(Boolean).join('\n');

      const [order] = await sql`
        INSERT INTO orders (customer_name, phone, delivery_info, items, total_price)
        VALUES (${customer_name}, ${phone}, ${orderInfo}, ${JSON.stringify(items)}, ${total_price})
        RETURNING *
      `;
      try {
        await notifyTelegram({ ...order, items });
      } catch (error) {
        console.error('Telegram order notification failed', error);
      }
      return res.status(201).json(order);
    }

    if (req.method === 'GET') {
      if (!isAdmin) return res.status(401).json({ error: 'Доступ лише для адміністратора' });
      const orders = await sql`SELECT * FROM orders ORDER BY created_at DESC, order_number DESC`;
      return res.status(200).json(orders);
    }

    if (!isAdmin) return res.status(401).json({ error: 'Невірний пароль адміністратора' });

    if (req.method === 'PUT') {
      const { id, status } = body || {};
      if (!isUuid(id)) {
        return res.status(400).json({ error: 'Невірний ID замовлення' });
      }
      if (!['new', 'processing', 'shipped', 'completed', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Невідомий статус замовлення' });
      }
      await sql`UPDATE orders SET status = ${status} WHERE id = ${id}`;
      return res.status(200).json({ updated: true });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!isUuid(id)) {
        return res.status(400).json({ error: 'Невірний ID замовлення' });
      }
      await sql`DELETE FROM orders WHERE id = ${id}`;
      return res.status(200).json({ deleted: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Метод не підтримується' });
  } catch (error) {
    const message = error && error.message ? error.message : 'Unknown error';
    if (/DATABASE_URL is not configured|relation .* does not exist|column .* does not exist/i.test(message)) {
      return res.status(503).json({ error: 'База даних не налаштована. Виконайте SQL із database/schema.sql у Neon.' });
    }
    console.error('Orders API failed', error);
    return res.status(500).json({ error: 'Внутрішня помилка сервера' });
  }
}
