import { neon } from '@neondatabase/serverless';

function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return {};
}

function formatOrder(order) {
  const date = new Date(order.created_at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  const total = Number(order.total_price).toLocaleString('uk-UA');
  const customerName = String(order.customer_name || 'Клієнт').replace(/[\r\n\t]+/g, ' ');
  const phone = String(order.phone || '').replace(/[\r\n\t]+/g, ' ');

  return [
    `🔹 Замовлення #${order.id}`,
    `👤 ${customerName} (${phone})`,
    `💰 Сума: ${total} грн`,
    `📅 ${date}`
  ].join('\n');
}

async function sendTelegramMessage(token, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram API rejected webhook reply: ${result.description || response.statusText}`);
  }
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
    const message = body && body.message;
    if (!message || !message.text) return res.status(200).json({ ok: true });

    const chatId = message.chat && message.chat.id;
    if (String(chatId) !== String(adminChatId)) return res.status(200).json({ ok: true });

    const text = message.text.trim();
    const command = text.split(/\s+/, 1)[0];
    if (!/^\/orders(?:@[a-zA-Z0-9_]+)?$/i.test(command) && text.toLowerCase() !== 'мої замовлення') {
      return res.status(200).json({ ok: true });
    }

    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not configured');
    }
    const sql = neon(process.env.DATABASE_URL);
    const orders = await sql`
      SELECT id, customer_name, phone, total_price, created_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT 5
    `;
    const reply = orders.length
      ? `📦 Останні замовлення на ВольтЗапас:\n\n${orders.map(formatOrder).join('\n\n')}`
      : 'Поки що немає жодного замовлення в базі.';

    await sendTelegramMessage(token, chatId, reply);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
