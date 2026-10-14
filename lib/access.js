const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

/**
 * Roles:
 *  - administrator — a Telegram user ID listed in ADMIN_IDS (manages exit nodes, access, Acknowledge, maintenance);
 *  - viewer — a user whose access request an administrator approved (store.users) and, if group chats are
 *    listed in CHAT_IDS, any member of those groups (or a private chat listed in CHAT_IDS).
 * Group membership is checked with getChatMember and cached.
 */
export function createAccess({ tg, store, adminIds, chatIds, dryRun, log }) {
  const cache = new Map();
  const isAdmin = (userId) => adminIds.includes(String(userId));

  async function isGroupMember(userId) {
    if (!chatIds.length) return false;
    const hit = cache.get(userId);
    if (hit && hit.expires > Date.now()) return hit.ok;

    let ok = chatIds.includes(String(userId));
    for (const chatId of chatIds) {
      if (ok) break;
      if (!chatId.startsWith('-')) continue; // private chats are matched by ID above
      try {
        const m = await tg.api('getChatMember', { chat_id: chatId, user_id: userId });
        ok = MEMBER_STATUSES.has(m.status) || (m.status === 'restricted' && m.is_member);
      } catch (err) {
        log(`getChatMember(${chatId}, ${userId}): ${err.message}`);
      }
    }
    cache.set(userId, { ok, expires: Date.now() + (ok ? 10 : 1) * 60_000 });
    return ok;
  }

  async function isViewer(userId) {
    if (isAdmin(userId) || store.isApproved(userId)) return true;
    // Local debugging with groups: membership cannot be checked without Telegram, so allow.
    if (dryRun && chatIds.length) return true;
    return isGroupMember(userId);
  }

  return { isAdmin, isViewer };
}
