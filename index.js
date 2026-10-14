import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from './lib/checks.js';
import { createTelegram, splitMessage } from './lib/telegram.js';
import { createMessages } from './lib/messages.js';
import { createStore, REQUEST_COOLDOWN_MS } from './lib/store.js';
import { createHistory } from './lib/history.js';
import { createMonitor } from './lib/monitor.js';
import { createAccess } from './lib/access.js';
import { createSensors } from './lib/sensors.js';
import { NOTIFICATION_IDS } from './lib/notifications.js';
import { startWebServer } from './lib/webserver.js';
import { displayName } from './lib/auth.js';
import { normalizeTarget, ValidationError } from './lib/validate.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const die = (msg) => { console.error(`Error: ${msg}`); process.exit(1); };
const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// ── Settings ─────────────────────────────────────────────────────────────────

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const TOKEN = process.env.TELEGRAM_TOKEN?.trim();
const DRY_RUN = args.has('--dry-run') || ['1', 'true', 'yes'].includes((process.env.DRY_RUN ?? '').toLowerCase());
let CHAT_IDS = list(process.env.CHAT_IDS);
const ADMIN_IDS = list(process.env.ADMIN_IDS);
const WEBAPP_URL = process.env.WEBAPP_URL?.trim().replace(/\/+$/, '') || '';
// In DRY_RUN, group membership checks are disabled. If WEBAPP_URL is set (a real server with a public address),
// the dashboard is not started in this mode at all, even with an explicit WEBAPP_PORT; otherwise any Telegram user
// could open it while debugging. Locally (no WEBAPP_URL), DRY_RUN + WEBAPP_PORT is used for tests.
const WEBAPP_PORT = DRY_RUN && WEBAPP_URL ? 0 : Number(process.env.WEBAPP_PORT) || (WEBAPP_URL ? 8080 : 0);
const WEBAPP_SHORT_NAME = process.env.WEBAPP_SHORT_NAME?.trim() || '';

// CHAT_IDS is optional: alerts go to users approved by an administrator, in private chats.
// Group chats are an extra option (their members then get access without a request).
CHAT_IDS = CHAT_IDS.filter((id) => id !== '0'); // "0" — a placeholder from older instructions
if (!DRY_RUN) {
  if (!TOKEN) die('TELEGRAM_TOKEN is not set (see .env.example)');
  // Without ADMIN_IDS the bot still starts, otherwise nobody could learn their ID with /myid (bootstrap mode).
  if (WEBAPP_URL && !WEBAPP_URL.startsWith('https://')) die('WEBAPP_URL must start with https:// — Telegram does not open Mini Apps over http');
} else if (!CHAT_IDS.length) {
  CHAT_IDS = ['console']; // DRY_RUN: group messages are printed to the console
}
if (!ADMIN_IDS.length) {
  log('⚠ ADMIN_IDS is not set — bootstrap mode: nobody can manage exit nodes or approve requests, '
    + 'and alerts have no recipients. Send /myid to the bot, put the ID into ADMIN_IDS and restart the bot.');
}

const config = loadConfig(process.env.CONFIG_PATH || join(ROOT, 'config.json'));
const intervalMs = config.intervalSeconds * 1000;
const startedAt = Date.now();

// data/: store.json (nodes, texts, schedule, users), state.json (open incidents),
// history.json (aggregated check history), incidents.json (incident log).
const dataPath = process.env.DATA_PATH || join(ROOT, 'data', 'store.json');
const dataDir = dirname(dataPath);
let store;
let history;
try {
  store = createStore(dataPath, config.servers);
  history = createHistory({
    historyPath: join(dataDir, 'history.json'), incidentsPath: join(dataDir, 'incidents.json'), log,
  });
} catch (err) {
  // Typical cause: data/ was created by root during a manual run, while the service runs as another user.
  die(`no access to ${dataDir} (${err.code ?? err.message}). The folder must belong to the user the service runs as, `
    + `for example: sudo chown -R sentinel:sentinel ${ROOT}`);
}

const tg = createTelegram({ token: TOKEN, dryRun: DRY_RUN, log });
// Texts are read from the store for every message, so edits in the Mini App take effect immediately.
const messages = createMessages({
  ...config, texts: () => store.texts(), availability: (id) => history.availability(id),
});
const access = createAccess({ tg, store, adminIds: ADMIN_IDS, chatIds: CHAT_IDS.filter((id) => id !== 'console'), dryRun: DRY_RUN, log });
const botInfo = { username: '', startedAt };
let monitor = null; // created in main(): --test does not need monitoring
let sensors = null;

// ── Delivery ─────────────────────────────────────────────────────────────────

const isGroupChat = (chatId) => String(chatId).startsWith('-') || chatId === 'console';

/**
 * Delivery.
 *   audience 'subscribers' — alerts and maintenance: groups from CHAT_IDS + approved subscribers in private chats;
 *   audience 'admins'      — service notices (configuration changes, start-up): groups + administrators.
 * keyboard({ isPrivate }) builds buttons separately for groups and private chats: Telegram allows the Mini App
 * (web_app) button only in private chats; groups get a link instead.
 */
async function notify(html, keyboard, { audience = 'subscribers' } = {}) {
  const targets = new Set(CHAT_IDS);
  if (audience === 'subscribers') store.subscribers().forEach((u) => targets.add(String(u.id)));
  if (audience === 'admins') ADMIN_IDS.forEach((id) => targets.add(id));
  const groups = [...targets].filter(isGroupChat);
  const admins = [...targets].filter((id) => !isGroupChat(id) && ADMIN_IDS.includes(id));
  const users = [...targets].filter((id) => !isGroupChat(id) && !ADMIN_IDS.includes(id));
  const extra = (opts) => {
    const markup = keyboard?.(opts);
    return markup ? { reply_markup: markup } : undefined;
  };
  const failures = [
    ...(groups.length ? await tg.broadcast(groups, html, extra({ isPrivate: false, isAdmin: false })) : []),
    ...(admins.length ? await tg.broadcast(admins, html, extra({ isPrivate: true, isAdmin: true })) : []),
    ...(users.length ? await tg.broadcast(users, html, extra({ isPrivate: true, isAdmin: false })) : []),
  ];
  for (const { chatId, err } of failures) {
    // The user blocked the bot or never started it: unsubscribe so we do not retry.
    if (err.status === 403 && store.isSubscribed(Number(chatId))) {
      store.setSubscribed(Number(chatId), false);
      log(`User ${chatId} blocked the bot — subscription disabled`);
    }
  }
}

/** Is the notification category enabled? Administrators mute categories in the Mini App. */
function notificationEnabled(type) {
  if (!NOTIFICATION_IDS.has(type) || store.notificationEnabled(type)) return true;
  log(`🔕 Notification "${type}" not sent — the category is muted`);
  return false;
}

function onEvent(type, p) {
  if (!notificationEnabled(type)) return undefined;
  const dash = (opts) => dashboardKeyboard(opts);
  switch (type) {
    case 'alert': return notify(messages.alert(p.states), (o) => incidentKeyboard(p.states, o));
    case 'reminder': return notify(messages.reminder(p.states, p.due), (o) => incidentKeyboard(p.due, o));
    case 'recovered': return notify(messages.recovered(p.states, p.recovered), dash);
    case 'acknowledged': return notify(messages.acknowledged(p.state), dash);
    case 'degraded': return notify(messages.degraded(p.states, p.items), dash);
    case 'performanceRestored': return notify(messages.performanceRestored(p.states, p.items), dash);
    case 'maintenanceStarted': return notify(messages.maintenanceStarted(p), dash);
    case 'maintenanceEnded': return notify(messages.maintenanceEnded(p), dash);
    case 'maintenanceScheduled': return notify(messages.maintenanceScheduled(p), dash);
    case 'maintenanceReminder': return notify(messages.maintenanceReminder(p), dash);
    case 'maintenanceCancelled': return notify(messages.maintenanceCancelled(p), dash);
    case 'configChanged': return notify(messages.configChanged(p), dash, { audience: 'admins' });
    case 'templatesChanged': return notify(messages.templatesChanged(p), undefined, { audience: 'admins' });
    case 'sensorStatus': return notify(messages.sensorStatus(p), dash, { audience: 'admins' });
    default: return undefined;
  }
}

// ── Administrator messages to users ──────────────────────────────────────────

const MAX_MESSAGE_TEXT = 3500;
const MAX_SUBJECT = 120;

const messageInput = ({ subject, text } = {}) => {
  const body = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
  const subj = typeof subject === 'string' ? subject.replace(/\s+/g, ' ').trim() : '';
  if (!body) throw new ValidationError('Message text is required');
  if (body.length > MAX_MESSAGE_TEXT) throw new ValidationError(`Message text must not exceed ${MAX_MESSAGE_TEXT} characters`);
  if (subj.length > MAX_SUBJECT) throw new ValidationError(`Subject must not exceed ${MAX_SUBJECT} characters`);
  return { subject: subj, text: body };
};

/** A sample (unsent) message for the dashboard preview. */
function previewAdminMessage(input, by) {
  const { subject, text } = messageInput(input);
  return messages.adminMessage({ subject, text, from: by, ref: messages.messageRef(Date.now(), '0000') });
}

/**
 * Sends an administrator message to the selected users (approved users only).
 * Delivery is sequential to stay within Telegram's message rate limits.
 */
async function sendAdminMessage({ ids, subject, text } = {}, by) {
  const input = messageInput({ subject, text });
  if (!Array.isArray(ids) || !ids.length) throw new ValidationError('Select at least one recipient');
  const unique = [...new Set(ids.map(Number))];
  if (unique.length > 1000) throw new ValidationError('Too many recipients');
  const users = unique.map((id) => store.getUser(id));
  if (users.some((u) => !u || u.status !== 'approved')) {
    throw new ValidationError('One of the selected recipients no longer has access. Please reload and try again.');
  }
  const now = Date.now();
  const id = randomBytes(4).toString('hex');
  const ref = messages.messageRef(now, id);
  const html = messages.adminMessage({ ...input, from: by, ref }, now);
  const recipients = [];
  for (const u of users) {
    try {
      await tg.send(String(u.id), html, { reply_markup: dashboardKeyboard({ isPrivate: true }) });
      recipients.push({ id: u.id, name: u.name, ok: true });
    } catch (err) {
      // 403 — the user blocked the bot or never started it.
      const blocked = err.status === 403;
      if (blocked && store.isSubscribed(u.id)) store.setSubscribed(u.id, false);
      recipients.push({ id: u.id, name: u.name, ok: false, error: blocked ? 'The user has blocked the bot or never started it' : err.message });
    }
  }
  const delivered = recipients.filter((r) => r.ok).length;
  log(`📨 Message ${ref} from ${by}: delivered ${delivered} of ${recipients.length}`);
  return store.addMessage({ id, ref, at: now, by, ...input, recipients });
}

// ── Access approved by an administrator ──────────────────────────────────────

const userStatus = (id) => store.getUser(id)?.status ?? 'none';
/** Whether a new request may be submitted (none pending, and a day has passed since a refusal). */
function canRequest(id, now = Date.now()) {
  const u = store.getUser(id);
  if (!u) return true;
  if (u.status === 'denied' || u.status === 'revoked') return now - (u.decidedAt ?? 0) >= REQUEST_COOLDOWN_MS;
  return false;
}

const requestKeyboard = () => ({ inline_keyboard: [[{ text: '🔐 Request access', callback_data: 'req' }]] });
const decisionKeyboard = (id) => ({
  inline_keyboard: [[
    { text: '✅ Approve', callback_data: `acc:${id}:a` },
    { text: '⛔ Deny', callback_data: `acc:${id}:d` },
  ]],
});

/** An access request from a Telegram user (from the chat or the Mini App). Returns the user status. */
async function submitAccessRequest(from) {
  if (await access.isViewer(from.id)) return 'approved';
  const { user, created } = store.requestAccess(from.id, displayName(from), from.username);
  if (created) {
    log(`🔐 Access request: ${user.name} (${user.id})`);
    if (notificationEnabled('accessRequest')) {
      await tg.broadcast(ADMIN_IDS, messages.accessRequest(user), { reply_markup: decisionKeyboard(user.id) });
    }
  }
  return user.status;
}

/** An administrator's decision (chat buttons or dashboard). status: approved | denied | revoked. */
async function decideAccess(id, status, by) {
  const user = store.getUser(id);
  if (!user) throw new ValidationError('User not found');
  // Approve: pending, declined or revoked; decline: pending only; revoke: approved only.
  const allowedFrom = { approved: ['pending', 'denied', 'revoked'], denied: ['pending'], revoked: ['approved'] }[status];
  if (!allowedFrom || !allowedFrom.includes(user.status)) {
    throw new ValidationError(`Request already ${user.status}${user.decidedBy ? ` by ${user.decidedBy}` : ''}`);
  }
  store.decide(id, status, by);
  log(`🔐 Access ${status} for ${user.name} (${id}) by ${by}`);
  const text = { approved: messages.accessGranted(), denied: messages.accessDeclined(), revoked: messages.accessRevoked() }[status];
  await tg.send(String(id), text, status === 'approved' ? { reply_markup: dashboardKeyboard({ isPrivate: true }) } : {})
    .catch((err) => log(`Failed to notify user ${id}: ${err.message}`));
  return store.getUser(id);
}

/** Upcoming and active maintenance windows with node names, for /status and the dashboard. */
function upcomingSchedules() {
  return store.schedules()
    .filter((s) => s.state === 'scheduled' || s.state === 'active')
    .sort((a, b) => a.start - b.start)
    .map((s) => ({ ...s, nodes: s.nodeIds.map((id) => monitor?.get(id)).filter(Boolean) }));
}

const statusReport = () => messages.status(monitor.list(), upcomingSchedules());

// ── Buttons ──────────────────────────────────────────────────────────────────
// The web_app button works only in private chats. Groups get a plain t.me/<bot>?startapp link,
// which opens the same Mini App (it has to be enabled once in @BotFather).

function dashboardButton({ isPrivate = false } = {}) {
  if (!WEBAPP_URL) return null;
  if (isPrivate) return { text: '📋 Open dashboard', web_app: { url: WEBAPP_URL } };
  if (!botInfo.username) return null;
  const url = WEBAPP_SHORT_NAME
    ? `https://t.me/${botInfo.username}/${WEBAPP_SHORT_NAME}`
    : `https://t.me/${botInfo.username}?startapp`;
  return { text: '📋 Open dashboard', url };
}

function dashboardKeyboard(opts) {
  const b = dashboardButton(opts);
  return b ? { inline_keyboard: [[b]] } : undefined;
}

const shorten = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Under an alert: Acknowledge and Maintenance 1 h for every unacknowledged incident.
 * Regular subscribers do not see these buttons in private chats (only administrators can use them).
 */
function incidentKeyboard(states, { isPrivate = false, isAdmin = false } = {}) {
  const rows = isPrivate && !isAdmin ? [] : states
    .filter((s) => s.status === 'down' && !s.ack)
    .slice(0, 6)
    .map((s) => [
      { text: `✅ Acknowledge · ${shorten(s.target.name, 20)}`, callback_data: `ack:${s.id}` },
      { text: '🔧 Maintenance 1 h', callback_data: `mnt:${s.id}:60` },
    ]);
  const b = dashboardButton({ isPrivate });
  if (b) rows.push([b]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function statusKeyboard({ isPrivate = false } = {}) {
  const row = [{ text: '🔄 Refresh', callback_data: 'refresh' }];
  const b = dashboardButton({ isPrivate });
  if (b) row.push(b);
  return { inline_keyboard: [row] };
}

// ── Commands and button presses ──────────────────────────────────────────────

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const msg = update.message ?? update.channel_post;
  if (msg?.text) return handleCommand(msg);
}

async function handleCommand(msg) {
  const m = msg.text.trim().match(/^\/(\w+)(?:@(\w+))?/);
  if (!m) return;
  const [, cmd, mention] = m;
  if (mention && mention.toLowerCase() !== botInfo.username.toLowerCase()) return;

  const chatId = String(msg.chat.id);
  const isPrivate = msg.chat.type === 'private';
  const userId = msg.from?.id;
  const reply = (html, markup) => tg.send(chatId, html, markup ? { reply_markup: markup } : {});

  // Service commands work in any chat; they are needed during setup.
  if (cmd === 'chatid') return reply(messages.chatId(chatId));
  if (cmd === 'myid' && userId) return reply(messages.userId(userId));

  // Everything else: in allowed groups, or in a private chat with an approved user or administrator.
  const allowed = CHAT_IDS.includes(chatId) || (isPrivate && userId && await access.isViewer(userId));
  if (!allowed) {
    if (!isPrivate || !userId) return undefined;
    // No access: offer to submit a request (or say that one is already pending).
    const status = userStatus(userId);
    return reply(messages.accessRequired(status), canRequest(userId) ? requestKeyboard() : undefined);
  }

  const ensureUser = () => store.ensureApproved(userId, displayName(msg.from), msg.from.username,
    access.isAdmin(userId) ? 'administrator' : 'group member');

  switch (cmd) {
    case 'status':
      return reply(statusReport(), statusKeyboard({ isPrivate }));
    case 'start':
    case 'help':
      if (isPrivate && access.isAdmin(userId)) ensureUser();
      return reply(messages.help({ isPrivate }), dashboardKeyboard({ isPrivate }));
    case 'subscribe':
      if (!isPrivate) return reply('Use /subscribe in a private chat with the bot.');
      ensureUser();
      store.setSubscribed(userId, true);
      return reply(messages.subscribed());
    case 'unsubscribe':
      if (!isPrivate) return reply('Use /unsubscribe in a private chat with the bot.');
      store.setSubscribed(userId, false);
      return reply(messages.unsubscribed());
    default:
      return undefined;
  }
}

async function handleCallback(cq) {
  const answer = (text = '', showAlert = false) =>
    tg.api('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: showAlert }).catch(() => {});
  const msg = cq.message;
  const data = cq.data ?? '';

  if (data === 'refresh') {
    const inAllowedChat = msg && CHAT_IDS.includes(String(msg.chat.id));
    if (!inAllowedChat && !(await access.isViewer(cq.from.id))) return answer('Access denied.', true);
    if (msg) {
      const report = statusReport();
      const markup = statusKeyboard({ isPrivate: msg.chat.type === 'private' });
      // A long report does not fit into one message and cannot be edited, so send it again in parts.
      if (splitMessage(report).length > 1) {
        await tg.send(String(msg.chat.id), report, { reply_markup: markup });
        return answer('Status report updated below.');
      }
      await tg.api('editMessageText', {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        text: report,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: markup,
      }).catch((err) => { if (!/not modified/i.test(err.message)) throw err; });
    }
    return answer('Status report updated.');
  }

  // An access request from a user without access.
  if (data === 'req') {
    if (msg?.chat.type !== 'private') return answer();
    if (!canRequest(cq.from.id) && !(await access.isViewer(cq.from.id))) {
      return answer(userStatus(cq.from.id) === 'pending'
        ? 'Your request is already awaiting review.'
        : 'A new request may be submitted 24 hours after the previous decision.', true);
    }
    const status = await submitAccessRequest(cq.from);
    if (status === 'approved') return answer('You already have access. Use /help.', true);
    await tg.api('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } })
      .catch(() => {});
    await tg.send(String(msg.chat.id), messages.accessRequestSubmitted());
    return answer('Request submitted.');
  }

  const [action, id, arg] = data.split(':');
  if (action !== 'ack' && action !== 'mnt' && action !== 'acc') return answer();
  if (!access.isAdmin(cq.from.id)) {
    return answer('This action is restricted to the responsible administrator.', true);
  }
  const by = displayName(cq.from);
  try {
    if (action === 'acc') {
      // Decision on a request: append it to the administrator's message and remove the buttons.
      const status = arg === 'a' ? 'approved' : 'denied';
      const user = await decideAccess(Number(id), status, by);
      if (msg) {
        await tg.api('editMessageText', {
          chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML',
          text: messages.accessRequest(user) + messages.accessDecisionNote(status, by),
        }).catch(() => {});
      }
      return answer(status === 'approved' ? 'Access granted.' : 'Request declined.');
    }
    if (action === 'ack') {
      if (!monitor.acknowledge(id, by)) return answer('Exit node not found.', true);
      return answer('Incident acknowledged. Repeat notifications are suspended.');
    }
    if (!monitor.setMaintenance(id, Number(arg), by)) return answer('Exit node not found.', true);
    return answer(`Maintenance window opened for ${arg} min.`);
  } catch (err) {
    if (err instanceof ValidationError) return answer(err.message, true);
    throw err;
  }
}

// ── Start-up ─────────────────────────────────────────────────────────────────

async function main() {
  if (!DRY_RUN) {
    try {
      botInfo.username = (await tg.api('getMe', {})).username;
    } catch (err) {
      die(`cannot connect to Telegram — check TELEGRAM_TOKEN (${err.message})`);
    }
  }

  if (args.has('--test')) {
    // A sample alert with test data, to administrators and groups (if any).
    // Monitoring is not started: neither the state nor the schedule changes.
    await tg.broadcast([...new Set([...CHAT_IDS, ...ADMIN_IDS])], '🧪 <b>TEST NOTIFICATION</b>\n'
      + '<i>This message has been issued to verify the notification channel. No action is required.</i>\n\n'
      + messages.preview('alert'));
    log('Test message sent.');
    return;
  }

  // If ping does not work on this machine, every ping node would "fail" and users would get a false alert.
  if ([...store.servers(), ...config.canaries].some((t) => t.type === 'ping')) {
    const self = await runCheck({ type: 'ping', host: '127.0.0.1' }, config.timeoutSeconds * 1000);
    if (!self.ok) die(`ping does not work on this machine (${self.error}). Install iputils-ping or remove "ping" checks`);
  }

  sensors = createSensors({
    store, log, nodeName: (id) => store.get(id)?.name ?? null,
    onEvent: (type, payload) => Promise.resolve(onEvent(type, payload)).catch((err) => log(`Failed to send ${type}:`, err)),
  });
  monitor = createMonitor({
    config, store, history, statePath: join(dataDir, 'state.json'), log, onEvent, sensors,
  });

  log(`Starting${DRY_RUN ? ' (DRY_RUN — messages go to the console only)' : ` as @${botInfo.username}`}. `
    + `Exit nodes: ${store.servers().length}, interval ${config.intervalSeconds} s, threshold ${config.failThreshold}.`);

  if (WEBAPP_PORT) {
    if (!TOKEN) {
      log('⚠ Mini App not started: TELEGRAM_TOKEN is required to verify signatures');
    } else {
      startWebServer({
        port: WEBAPP_PORT, token: TOKEN, htmlPath: join(ROOT, 'webapp', 'index.html'),
        config, access, monitor, store, history, messages, tg, botInfo, log, upcomingSchedules, sensors,
        publicUrl: WEBAPP_URL,
        accessFlow: { submit: submitAccessRequest, decide: decideAccess, status: userStatus, canRequest },
        adminMessages: { send: sendAdminMessage, preview: previewAdminMessage },
        onAudit: (type, payload) => Promise.resolve(onEvent(type, payload)).catch((err) => log(`Failed to send ${type}:`, err)),
      });
    }
  }

  if (!DRY_RUN) {
    await tg.api('setMyCommands', {
      commands: [
        { command: 'status', description: 'Current status report' },
        { command: 'subscribe', description: 'Receive outage notifications privately' },
        { command: 'unsubscribe', description: 'Stop private notifications' },
        { command: 'myid', description: 'Your Telegram user ID' },
        { command: 'help', description: 'List of commands' },
      ],
    }).catch((err) => log(`setMyCommands: ${err.message}`));
    if (WEBAPP_URL) {
      // The "Dashboard" button next to the input field in the private chat with the bot.
      await tg.api('setChatMenuButton', {
        menu_button: { type: 'web_app', text: 'Dashboard', web_app: { url: WEBAPP_URL } },
      }).catch((err) => log(`setChatMenuButton: ${err.message}`));
    }
  }

  if (config.notifyOnStart && notificationEnabled('started')) {
    await notify(messages.started(monitor.list(), {
      restored: monitor.restoredCount(),
      subscribers: store.subscribers().length,
      groups: CHAT_IDS.filter((id) => id !== 'console').length,
    }), (o) => dashboardKeyboard(o), { audience: 'admins' });
  }
  if (!DRY_RUN) tg.poll(handleUpdate);

  for (;;) {
    const started = Date.now();
    try {
      await monitor.cycle();
    } catch (err) {
      log('Check cycle error:', err);
    }
    await sleep(Math.max(1000, intervalMs - (Date.now() - started)));
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('Stopping: saving state and history.');
    try { monitor?.shutdown(); } catch (err) { log('Failed to save on shutdown:', err); }
    process.exit(0);
  });
}

main();

// ── Loading and validating config.json ───────────────────────────────────────
// The servers list in config.json is used only on the first start, to seed data/store.json.
// After that, exit nodes are managed in the Mini App.

function loadConfig(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') die(`${path} not found. Create it from the example: cp config.example.json config.json`);
    die(`cannot read ${path}: ${err.message}`);
  }

  const cfg = {
    adminName: 'Administrator',
    monitorName: hostname(),
    timezone: 'UTC',
    intervalSeconds: 60,
    timeoutSeconds: 5,
    failThreshold: 3,
    remindEveryMinutes: 60,
    latencyThresholdMs: 300,
    latencyThresholdHttpMs: 0,
    latencyChecks: 3,
    maintenanceNoticeMinutes: 60,
    notifyOnStart: true,
    servers: [],
    canaries: [],
    ...raw,
  };

  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: cfg.timezone });
  } catch {
    die(`config.json: unknown time zone "${cfg.timezone}"`);
  }
  for (const key of ['intervalSeconds', 'timeoutSeconds', 'failThreshold', 'latencyChecks']) {
    if (!(cfg[key] > 0)) die(`config.json: ${key} must be a positive number`);
  }
  for (const key of ['remindEveryMinutes', 'latencyThresholdMs', 'latencyThresholdHttpMs', 'maintenanceNoticeMinutes']) {
    if (!(Number.isFinite(cfg[key]) && cfg[key] >= 0)) die(`config.json: ${key} must be a number >= 0 (0 disables it)`);
  }

  const check = (t, where, opts) => {
    try { return normalizeTarget(t, opts); } catch (err) { return die(`config.json, ${where}: ${err.message}`); }
  };
  cfg.servers = cfg.servers.map((s, i) => check(s, `servers[${i}]`));
  cfg.canaries = cfg.canaries.map((c, i) => check(c, `canaries[${i}]`, { requireName: false }));
  return cfg;
}
