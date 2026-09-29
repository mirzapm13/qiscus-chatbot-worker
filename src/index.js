export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const data = await request.json();

      const appCode = data.app_code;
      const roomId = data.payload?.room?.id;
      const incomingText = (data.payload?.message?.text || '').trim();
      const senderEmail = data.payload?.from?.email;

      // Ignore echoes from bot or empty payloads
      if (!incomingText || (senderEmail && senderEmail.includes('admin@qismo.com'))) {
        return new Response('Ignored', { status: 200 });
      }

      // 1. Check the 24-hour cooldown lock first
      const cooldownKey = `cooldown:${roomId}`;
      const isCooldown = await env.CHAT_COOLDOWN.get(cooldownKey);
      if (isCooldown) {
        return new Response('Suppressed: In 24h cooldown', { status: 200 });
      }

      // 2. Route to the Durable Object for this specific room
      const id = env.ROOM_DEBOUNCER.idFromName(roomId.toString());
      const stub = env.ROOM_DEBOUNCER.get(id);

      // Pass the message to the Durable Object to buffer and set the 5-min timer
      await stub.fetch(
        new Request('https://internal/add-message', {
          method: 'POST',
          body: JSON.stringify({
            appCode,
            roomId,
            text: incomingText
          })
        })
      );

      return new Response('Message queued for 5m debounce', { status: 200 });
    } catch (err) {
      console.error('Webhook error:', err);
      return new Response('Internal Error', { status: 500 });
    }
  }
};

// Durable Object handling per-room message aggregation and 5-min timer
export class RoomDebouncer {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const { appCode, roomId, text } = await request.json();

    // 1. Append message to internal state
    const messages = (await this.ctx.storage.get('messages')) || [];
    messages.push(text);
    await this.ctx.storage.put('messages', messages);
    await this.ctx.storage.put('metadata', { appCode, roomId });

    // 2. Set (or reset) the alarm for 5 minutes from now (5 * 60 * 1000 ms)
    const fiveMinutes = 5 * 60 * 1000;
    await this.ctx.storage.setAlarm(Date.now() + fiveMinutes);

    return new Response('Queued');
  }

  // Cloudflare triggers this function when the 5-minute timer expires
  async alarm() {
    const metadata = await this.ctx.storage.get('metadata');
    const messages = await this.ctx.storage.get('messages');

    // Clean up DO storage
    await this.ctx.storage.deleteAll();

    if (!messages || messages.length === 0 || !metadata) {
      return;
    }

    const { appCode, roomId } = metadata;
    const cooldownKey = `cooldown:${roomId}`;

    // Verify 24h cooldown lock hasn't been set by another process
    const isCooldown = await this.env.CHAT_COOLDOWN.get(cooldownKey);
    if (isCooldown) {
      return;
    }

    const combinedText = messages.join('\n');

    // 3. Classify intent using Workers AI
    const classification = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: `You are an ISP support triage classifier. Categorize the user's message into EXACTLY one category:
- TECHNICAL_ISSUE: problems with internet connection, red LOS light, slow speed, no connection, fiber cut, wifi down.
- CHANGE_PASSWORD: requests to change Wi-Fi password, SSID, or router credentials.
- OTHER: greetings only ("halo", "p"), billing questions, general inquiries, or complex questions.

Output strictly valid JSON: {"category": "TECHNICAL_ISSUE" | "CHANGE_PASSWORD" | "OTHER"}`
        },
        {
          role: 'user',
          content: combinedText
        }
      ],
      max_tokens: 30
    });

    let category = 'OTHER';
    try {
      const parsed = JSON.parse(classification.response.trim());
      category = parsed.category;
    } catch (e) {
      if (classification.response.includes('TECHNICAL_ISSUE')) category = 'TECHNICAL_ISSUE';
      else if (classification.response.includes('CHANGE_PASSWORD')) category = 'CHANGE_PASSWORD';
    }

    // 4. Formulate reply
    let reply = '';
    if (category === 'TECHNICAL_ISSUE') {
      reply = 'Halo! Untuk kendala teknis/koneksi internet, silakan langsung hubungi Teknisi Lapangan kami via WhatsApp: https://wa.me/6281234567890';
    } else if (category === 'CHANGE_PASSWORD') {
      reply = 'Halo! Untuk pergantian password Wi-Fi / konfigurasi router, silakan hubungi Admin Layanan kami: https://wa.me/6281987654321';
    } else {
      // Do nothing. Leave the chat open for human agents in Qiscus.
      return;
    }

    // 5. Send single consolidated reply to Qiscus
    await sendReply(appCode, roomId, reply, this.env.QISCUS_SECRET_KEY, this.env.BOT_ADMIN_EMAIL);

    // 6. Set the 24-hour cooldown lock (86,400 seconds)
    await this.env.CHAT_COOLDOWN.put(cooldownKey, '1', {
      expirationTtl: 86400
    });
  }
}

async function sendReply(appCode, roomId, message, secretKey, botEmail) {
  const url = `https://omnichannel.qiscus.com/${appCode}/bot`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'QISCUS_SDK_SECRET': secretKey
    },
    body: JSON.stringify({
      sender_email: botEmail,
      message: message,
      type: 'text',
      room_id: roomId
    })
  });
}