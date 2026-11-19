export function configFromEnv(env = process.env) {
  for (const key of ['BOOKSTACK_URL', 'BOOKSTACK_TOKEN_ID', 'BOOKSTACK_TOKEN_SECRET', 'INBOUND_EMAIL_TOKEN', 'ADMIN_TOKEN']) {
    if (!env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }
  for (const key of ['INBOUND_EMAIL_TOKEN', 'ADMIN_TOKEN']) {
    if (env[key].length < 32) throw new Error(`${key} must contain at least 32 characters.`);
  }
  if (env.INBOUND_EMAIL_TOKEN === env.ADMIN_TOKEN) throw new Error('Use separate intake and administration tokens.');
  for (const key of ['BOOKSTACK_URL', 'BOOKSTACK_PUBLIC_URL']) {
    if (!env[key]) continue;
    const url = new URL(env[key]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${key} must be an HTTP(S) URL without credentials, query, or fragment.`);
    }
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (env.DASHBOARD_ADMIN_PASSWORD && (env.DASHBOARD_ADMIN_PASSWORD.length < 12 || env.DASHBOARD_ADMIN_PASSWORD.length > 256)) {
    throw new Error('DASHBOARD_ADMIN_PASSWORD must contain 12 to 256 characters.');
  }
  if (env.DASHBOARD_ADMIN_EMAIL && !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(env.DASHBOARD_ADMIN_EMAIL)) {
    throw new Error('DASHBOARD_ADMIN_EMAIL must be a valid email address.');
  }
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) throw new Error('TRUST_PROXY_HOPS must be between 0 and 5.');
  return {
    trustProxyHops,
    dashboardAdminEmail: env.DASHBOARD_ADMIN_EMAIL || 'admin@assetdesk.local',
    dashboardAdminPassword: env.DASHBOARD_ADMIN_PASSWORD || null,
    cookieSecure: env.COOKIE_SECURE === 'true',
    port, databasePath: env.DATABASE_PATH || './data/assetdesk.sqlite',
    bookstack: { url: env.BOOKSTACK_URL, publicUrl: env.BOOKSTACK_PUBLIC_URL || env.BOOKSTACK_URL,
      tokenId: env.BOOKSTACK_TOKEN_ID, tokenSecret: env.BOOKSTACK_TOKEN_SECRET },
    inboundToken: env.INBOUND_EMAIL_TOKEN, adminToken: env.ADMIN_TOKEN,
    prefixes: env.ASSET_PREFIXES ? env.ASSET_PREFIXES.split(',').map(v => v.trim()).filter(Boolean) : undefined,
    supportEmails: (env.SUPPORT_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean),
  };
}
