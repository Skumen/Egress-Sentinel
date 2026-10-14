const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT = 4000; // Telegram accepts up to 4096 characters; keep a margin

/**
 * Splits an HTML message into parts of at most LIMIT characters at line boundaries.
 * A <pre>…</pre> block (a table) is never split, otherwise Telegram rejects the markup.
 * An oversized message that could not be split would mean a lost alert, the worst outcome for a monitor.
 */
export function splitMessage(html, limit = LIMIT) {
  if (html.length <= limit) return [html];
  const units = [];
  let pre = null;
  for (const line of html.split('\n')) {
    if (pre !== null) {
      pre += `\n${line}`;
      if (line.includes('</pre>')) { units.push(pre); pre = null; }
    } else if (line.includes('<pre>') && !line.includes('</pre>')) {
      pre = line;
    } else {
      units.push(line);
    }
  }
  if (pre !== null) units.push(pre);

  const chunks = [];
  let cur = '';
  for (const unit of units) {
    // A single unit longer than the limit (a huge table): cut it bluntly so that at least something arrives.
    const pieces = unit.length > limit ? unit.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'g')) : [unit];
    for (const piece of pieces) {
      if (cur && cur.length + 1 + piece.length > limit) { chunks.push(cur); cur = piece; }
      else cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function createTelegram({ token, dryRun, log }) {
  async function api(method, body, timeoutMs = 15_000) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    if (!data.ok) {
      const migrated = data.parameters?.migrate_to_chat_id;
      const hint = migrated ? ` — the group became a supergroup, new ID: ${migrated}; update CHAT_IDS` : '';
      const err = new Error(`Telegram ${method}: ${data.error_code} ${data.description}${hint}`);
      err.retryAfter = data.parameters?.retry_after;
      err.status = data.error_code;
      throw err;
    }
    return data.result;
  }

  /** extra — additional sendMessage fields such as { reply_markup }. Buttons go under the last part. */
  async function send(chatId, html, extra = {}) {
    const chunks = splitMessage(html);
    if (chunks.length > 1) {
      const { reply_markup: markup, ...rest } = extra;
      let result;
      for (let i = 0; i < chunks.length; i++) {
        result = await sendOne(chatId, chunks[i], i === chunks.length - 1 && markup ? { ...rest, reply_markup: markup } : rest);
      }
      return result;
    }
    return sendOne(chatId, html, extra);
  }

  async function sendOne(chatId, html, extra = {}) {
    if (dryRun) {
      const buttons = extra.reply_markup?.inline_keyboard
        ?.map((row) => row.map((b) => `[${b.text}]`).join(' ')).join('\n') ?? '';
      console.log(`\n──── [DRY_RUN → ${chatId}] ────\n${htmlToText(html)}${buttons ? `\n${buttons}` : ''}\n────────────────────────────\n`);
      return;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await api('sendMessage', {
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...extra,
        });
      } catch (err) {
        // 4xx (except 429): retrying will not help — wrong chat_id, bot removed from the group, etc.
        const permanent = err.status >= 400 && err.status < 500 && err.status !== 429;
        if (permanent || attempt >= 3) throw err;
        await sleep((err.retryAfter ?? 3 * attempt) * 1000);
      }
    }
  }

  /** Sends a message to several chats and returns the failures [{ chatId, err }]. */
  async function broadcast(chatIds, html, extra) {
    const failures = [];
    await Promise.all(chatIds.map((id) => send(id, html, extra).catch((err) => {
      log(`Failed to send a message to chat ${id}: ${err.message}`);
      failures.push({ chatId: id, err });
    })));
    return failures;
  }

  /** Long polling: calls onUpdate for every incoming update. */
  async function poll(onUpdate) {
    let offset = 0;
    for (;;) {
      try {
        const updates = await api('getUpdates', {
          offset,
          timeout: 30,
          allowed_updates: ['message', 'channel_post', 'callback_query'],
        }, 45_000);
        for (const u of updates) {
          offset = u.update_id + 1;
          await onUpdate(u).catch((err) => log(`Failed to handle an update: ${err.message}`));
        }
      } catch (err) {
        log(`getUpdates: ${err.message}`);
        await sleep(5_000);
      }
    }
  }

  return { api, send, broadcast, poll };
}

function htmlToText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
