export function normalizeMessageContext(raw = {}) {
  return {
    channelType: raw.channelType || raw.channel_type,
    platformContextId: raw.platformContextId || raw.platform_context_id,
    channelId: raw.channelId || raw.channel_id,
    userId: raw.userId || raw.user_id,
    content: raw.content || "",
    attachments: raw.attachments || [],
    accountId: raw.accountId || raw.account_id,
    to: raw.to,
    from: raw.from,
    messageThreadId: raw.messageThreadId || raw.message_thread_id,
  };
}

export function buildChannelSessionKey(rawCtx) {
  const ctx = normalizeMessageContext(rawCtx);
  return `${ctx.channelType}:${ctx.platformContextId}:${ctx.channelId}:${ctx.userId}`;
}
