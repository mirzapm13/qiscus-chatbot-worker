const REPLY_TEMPLATES = {
  PASANG_BARU: `Terima kasih sudah berkenan untuk berlangganan layanan Mbangsari.Net.

Untuk informasi lebih lanjut terkait pemasangan baru, silakan menghubungi Admin Pemasangan kami melalui kontak berikut: 0821-3686-2085 Tim kami akan membantu memberikan penjelasan mengenai paket layanan.

Hormat kami,
Staff Mbangsari.Net`,

  INFO_TAGIHAN: `Untuk keperluan administrasi, pembayaran, atau tagihan, silakan hubungi Admin Billing Mbangsari.Net melalui kontak berikut: 0821-3686-2085

Tim kami akan membantu memberikan penjelasan terkait informasi administrasi yang dibutuhkan

Hormat kami,
Staff Mbangsari.Net`,

  SUDAH_BAYAR: `Apabila Bpk/Ibu telah melakukan pembayaran, dan masih menerima tagihan. Silakan mengirimkan bukti bayarnya melalui kontak Admin berikut: 0821-3686-2085

Tim kami akan membantu proses validasi pembayaran yang dilakukan.

Hormat kami,
Staff Mbangsari.Net`,

  GANGGUAN_INTERNET: `Silakan lakukan langkah awal dengan merestart router (cabut adaptor, lalu pasang kembali setelah 10 detik).

Apabila kendala masih berlanjut, mohon segera menghubungi Layanan Gangguan Mbangsari.Net melalui nomor berikut agar dapat kami tindaklanjuti secepatnya:
0821-3686-2020

*Mohon sertakan pula ID Pelanggan dan Foto Modem agar identifikasi gangguan oleh teknisi kami lebih cepat dan tepat ^^

Hormat kami,
Staff Mbangsari.Net`,

  GANTI_PASSWORD: `Untuk mereset ulang pasword/username bisa langsung menghubungi layanan gangguan 0821-3686-2020, agar segera ditindaklanjuti^^

Untuk permintaan pergantian sandi WiFi, mohon Bapak/Ibu menyertakan data identitas pelanggan berikut agar kami dapat memproses dengan cepat dan tepat:

Nama Lengkap :

ID Pelanggan :

Alamat Lengkap Pemasangan :

Nama user wifi lama :

Nama user wifi baru :

Sandi lama yang digunakan :

Sandi baru yang diinginkan :

Setelah data terisi, dimohon untuk mengirimkan format data pergantian sandi WiFi kepada kontak Layanan Gangguan, tim teknis Mbangsari.Net akan segera membantu melakukan perubahan sandi WiFi.

Terima kasih atas kerja samanya. 🙏`,

  GANTI_PAKET: `Untuk keperluan perubahan paket, silakan hubungi Admin Mbangsari.Net melalui kontak berikut: 0821-3686-2085 dengan melampirkan bukti pembayaran di bulan ini. Tim kami akan membantu memberikan penjelasan terkait informasi administrasi yang dibutuhkan

Hormat kami,
Staff Mbangsari.Net`,
};

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const data = await request.json();
      console.log("--- INCOMING WEBHOOK PAYLOAD ---");
      console.log(JSON.stringify(data));

      const appCode = data.app_code;
      const roomId = data.payload?.room?.id;
      const incomingText = (data.payload?.message?.text || "").trim();
      const senderEmail = data.payload?.from?.email;

      let channelId = data.payload?.channel_id || null;
      let customerPhone =
        (data.customer?.phone_number || senderEmail || data.payload?.from?.user_id || "").replace("+", "");

      if (data.payload?.room?.options) {
        try {
          const opts =
            typeof data.payload.room.options === "string"
              ? JSON.parse(data.payload.room.options)
              : data.payload.room.options;
          if (opts.channel_details?.channel_id) {
            channelId = opts.channel_details.channel_id;
          }
        } catch (e) {
          console.warn("Could not parse room.options:", e);
        }
      }

      console.log(
        `Parsed -> Room: ${roomId}, Channel: ${channelId}, Phone: ${customerPhone}, Text: "${incomingText}"`,
      );

      // Ignore echoes from bot
      if (senderEmail && senderEmail.includes("admin@qismo.com")) {
        console.log("Ignored: Sent by bot admin");
        return new Response("Ignored bot echo", { status: 200 });
      }

      if (!incomingText) {
        console.log("Ignored: Empty message text");
        return new Response("Ignored empty text", { status: 200 });
      }

      // Check cooldown
      const cooldownKey = `cooldown:${roomId}`;
      const isCooldown = await env.CHAT_COOLDOWN.get(cooldownKey);
      console.log(`Cooldown check for ${cooldownKey}: ${isCooldown}`);

      if (isCooldown) {
        console.log("Ignored: Under 24h cooldown");
        return new Response("Suppressed: In 24h cooldown", { status: 200 });
      }

      // Forward to Durable Object
      const id = env.ROOM_DEBOUNCER.idFromName(roomId.toString());
      const stub = env.ROOM_DEBOUNCER.get(id);

      await stub.fetch(
        new Request("https://internal/add-message", {
          method: "POST",
          body: JSON.stringify({
            appCode,
            roomId,
            channelId,
            customerPhone,
            text: incomingText,
          }),
        }),
      );

      console.log("Successfully queued into Durable Object");
      return new Response("Message queued for debounce", { status: 200 });
    } catch (err) {
      console.error("Fatal Webhook Error:", err);
      return new Response("Internal Error: " + err.message, { status: 500 });
    }
  },
};

// Durable Object handling per-room message aggregation and timer
export class RoomDebouncer {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const { appCode, roomId, channelId, customerPhone, text } =
      await request.json();

    // 1. Append message to internal state
    const messages = (await this.ctx.storage.get("messages")) || [];
    messages.push(text);
    await this.ctx.storage.put("messages", messages);
    await this.ctx.storage.put("metadata", {
      appCode,
      roomId,
      channelId,
      customerPhone,
    });

    // 2. Set alarm timer for 5 minutes (5 * 60 * 1000 ms)
    const fiveMinutes = 5 * 60 * 1000;
    await this.ctx.storage.setAlarm(Date.now() + fiveMinutes);

    return new Response("Queued");
  }

  // Cloudflare triggers this function when the timer expires
  async alarm() {
    console.log("--- ⏰ ALARM FIRED ---");
    const metadata = await this.ctx.storage.get("metadata");
    const messages = await this.ctx.storage.get("messages");

    // Clean up DO storage
    await this.ctx.storage.deleteAll();

    if (!messages || messages.length === 0 || !metadata) {
      console.log("Alarm exited: No messages or metadata found.");
      return;
    }

    const { appCode, roomId, channelId, customerPhone } = metadata;
    const cooldownKey = `cooldown:${roomId}`;

    // Verify 24h cooldown lock hasn't been set by another process
    const isCooldown = await this.env.CHAT_COOLDOWN.get(cooldownKey);
    if (isCooldown) {
      return;
    }

    const combinedText = messages.join("\n");
    console.log(
      `Processing aggregated text for room ${roomId}: "${combinedText}"`,
    );

    // 3. Classify intent using Workers AI
    const classification = await this.env.AI.run(
      "@cf/meta/llama-3.2-3b-instruct",
      {
        messages: [
          {
            role: "system",
            content: `Anda adalah AI classifier untuk customer service ISP Mbangsari.Net.
Tugas Anda adalah mengkategorikan pesan pelanggan ke dalam SATU kategori berikut:

1. PASANG_BARU:
- Pertanyaan mendaftar langganan baru, pasang internet baru, cek cover area.
- Contoh: "mau pasang wifi", "cara daftar internet", "apakah daerah sini tercover", "langganan baru".

2. INFO_TAGIHAN:
- Menanyakan jumlah tagihan, jatuh tempo, rincian biaya, atau nomor rekening pembayaran.
- Contoh: "berapa tagihan bulan ini", "minta no rek bayar wifi", "cek tagihan saya".

3. SUDAH_BAYAR:
- Menyatakan sudah melakukan pembayaran/transfer tetapi masih dapat penagihan atau konfirmasi pembayaran.
- Contoh: "saya sudah bayar ya", "ini bukti transfernya tapi kok ditagih", "lunas ya min".

4. GANGGUAN_INTERNET:
- Keluhan internet lemot, mati total, los merah, putus-putus, wifi tidak bisa connect, kabel putus.
- Contoh: "wifi kok lemot ya", "internet mati", "lampu los merah", "lemot bgt min", "gabisa browsing".

5. GANTI_PASSWORD:
- Permintaan ganti password wifi, ganti nama SSID/wifi, reset sandi/username modem.
- Contoh: "mau ganti sandi wifi", "ubah password router", "ganti nama wifi dong".

6. GANTI_PAKET:
- Permintaan ganti paket wifi, upgrade/downgrade speed, tambah kecepatan internet.
- Contoh: "mau upgrade speed", "ganti paket ke 20mbps", "tambah kecepatan dong".

7. OTHER:
- Hanya sapaan ("p", "halo", "assalamualaikum", "pagi", "siang"), atau pertanyaan umum di luar 6 kategori di atas.

PENTING:
- Jika ada keluhan koneksi/lemot/gangguan, WAJIB pilih GANGGUAN_INTERNET.
- Jika ada kata "sudah bayar" / "bukti bayar" / "lunas", WAJIB pilih SUDAH_BAYAR.
- Balas HANYA dengan JSON valid tanpa penjelasan tambahan:
{"category": "PASANG_BARU" | "INFO_TAGIHAN" | "SUDAH_BAYAR" | "GANGGUAN_INTERNET" | "GANTI_PASSWORD" | "GANTI_PAKET" | "OTHER"}`,
          },
          {
            role: "user",
            content: combinedText,
          },
        ],
        max_tokens: 40,
      },
    );

    // Safely extract text from the model output
    let rawResponse = "";
    if (typeof classification === "string") {
      rawResponse = classification;
    } else if (typeof classification?.response === "string") {
      rawResponse = classification.response;
    } else if (classification?.response) {
      rawResponse = JSON.stringify(classification.response);
    } else {
      rawResponse = JSON.stringify(classification || {});
    }

    console.log(`Raw AI Output: ${rawResponse}`);

    let category = "OTHER";
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (
          parsed.category &&
          (parsed.category in REPLY_TEMPLATES || parsed.category === "OTHER")
        ) {
          category = parsed.category;
        }
      }
    } catch (e) {
      console.warn("JSON extraction error:", e);
    }

    // Keyword fallback if regex JSON extraction didn't match a valid template key
    if (category === "OTHER") {
      if (rawResponse.includes("PASANG_BARU")) category = "PASANG_BARU";
      else if (rawResponse.includes("INFO_TAGIHAN")) category = "INFO_TAGIHAN";
      else if (rawResponse.includes("SUDAH_BAYAR")) category = "SUDAH_BAYAR";
      else if (rawResponse.includes("GANGGUAN_INTERNET"))
        category = "GANGGUAN_INTERNET";
      else if (rawResponse.includes("GANTI_PASSWORD"))
        category = "GANTI_PASSWORD";
      else if (rawResponse.includes("GANTI_PAKET")) category = "GANTI_PAKET";
    }

    console.log(`Classified Category: ${category}`);

    // 4. Formulate & Send reply
    const FOOTER_NOTE = `\n\n----------------------------------------\n*Catatan: Nomor ini adalah nomor otomatis dari sistem Mbangsari.Net.\n- Admin (Informasi Berlangganan & Pembayaran): +62 821-3686-2085\n- Layanan Gangguan / Teknisi: +62 821-3686-2020`;

    let res;
    if (category === "GANTI_PASSWORD") {
      const templateName =
        this.env.WHATSAPP_FLOW_TEMPLATE_NAME || "ganti_password_wifi";
      const namespace =
        this.env.QISCUS_WA_NAMESPACE || "c1d1cc94_9127_4c26_992e_5231627f5299";

      console.log(
        `Sending WhatsApp Flow template "${templateName}" (namespace: ${namespace}) to ${customerPhone} via channel ${channelId}`,
      );
      res = await sendFlowReply(
        appCode,
        channelId,
        customerPhone,
        templateName,
        this.env.QISCUS_SECRET_KEY,
        namespace,
      );
    } else {
      const baseReply = REPLY_TEMPLATES[category];
      if (!baseReply) {
        console.log(
          `Category "${category}" has no template. Leaving for human agent.`,
        );
        return;
      }
      const reply = baseReply + FOOTER_NOTE;
      res = await sendReply(
        appCode,
        roomId,
        reply,
        this.env.QISCUS_SECRET_KEY,
        this.env.BOT_ADMIN_EMAIL,
      );
    }

    const qiscusResult = await res.json().catch(() => null);
    console.log(`Qiscus API response (${res?.status}):`, qiscusResult);

    // 5. Set the 24-hour cooldown lock (86,400 seconds)
    await this.env.CHAT_COOLDOWN.put(cooldownKey, "1", {
      expirationTtl: 86400,
    });

    console.log(`Successfully saved ${cooldownKey} to KV for 24 hours.`);
  }
}

async function sendReply(appCode, roomId, message, secretKey, botEmail) {
  const url = `https://omnichannel.qiscus.com/${appCode}/bot`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      QISCUS_SDK_SECRET: secretKey,
    },
    body: JSON.stringify({
      sender_email: botEmail,
      message: message,
      type: "text",
      room_id: roomId,
    }),
  });
}

async function sendFlowReply(
  appCode,
  channelId,
  customerPhone,
  templateName,
  secretKey,
  namespace,
) {
  const url = `https://omnichannel.qiscus.com/whatsapp/v1/${appCode}/${channelId}/messages`;

  const payload = {
    recipient_type: "individual",
    to: customerPhone,
    type: "template",
    template: {
      name: templateName,
      namespace: namespace || "c1d1cc94_9127_4c26_992e_5231627f5299",
      language: {
        policy: "deterministic",
        code: "id",
      },
      components: [
        {
          type: "button",
          sub_type: "flow",
          index: "0",
        },
      ],
    },
  };

  console.log(payload, appCode, secretKey, namespace);

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Qiscus-App-Id": appCode,
      "Qiscus-Secret-Key": secretKey,
    },
    body: JSON.stringify(payload),
  });
}
