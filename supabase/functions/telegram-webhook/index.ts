// Telegram webhook (NOT deployed yet): when a seller opens the bot link from the
// cabinet and presses Start, this ties their Telegram chat to their shop.
// Needs three secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (any long random
// text, also given to Telegram in setWebhook), and the built-in service role key.
import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const secret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
  // Reject everything that does not come from Telegram with our secret.
  if (!secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await req.json().catch(() => null);
  const chatId = update?.message?.chat?.id;
  const text: string = update?.message?.text ?? '';
  if (chatId && text.startsWith('/start')) {
    const code = text.split(' ')[1] ?? '';
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data } = code
      ? await sb.rpc('telegram_link', { p_code: code, p_chat_id: chatId })
      : { data: null };
    const reply = data
      ? `Готово! Брони магазина «${data}» будут приходить сюда.`
      : 'Откройте ссылку «Подключить Telegram» в кабинете продавца на taila.page.';
    await fetch(`https://api.telegram.org/bot${Deno.env.get('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
    });
  }
  return new Response('ok');
});
