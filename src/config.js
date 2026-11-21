import { normalizeActionConnections, normalizeActionPublicUrl } from './action-transports.js';

export function actionsConfigFromEnv(env = process.env) {
  let connections;
  try { connections = JSON.parse(env.ACTION_API_CONNECTIONS || '[]'); }
  catch { throw new Error('ACTION_API_CONNECTIONS must contain a valid JSON array of API connections.'); }
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be between 1 and 65535.');
  if (env.SMTP_SECURE && !['true', 'false'].includes(env.SMTP_SECURE)) throw new Error('SMTP_SECURE must be true or false.');
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) throw new Error('Configure SMTP_USER and SMTP_PASS together.');
  return {
    publicUrl: normalizeActionPublicUrl(env.ACTION_PUBLIC_URL || ''),
    smtp: { host: env.SMTP_HOST || '', port, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
      user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.SMTP_FROM || '' },
    connections: normalizeActionConnections(connections),
  };
}

export function configFromEnv(env = process.env) {
  for (const key of ['INBOUND_EMAIL_TOKEN', 'ADMIN_TOKEN']) {
    if (!env[key]) throw new Error(`Missing required environment variable: ${key}`);
  }
  for (const key of ['INBOUND_EMAIL_TOKEN', 'ADMIN_TOKEN']) {
    if (env[key].length < 32) throw new Error(`${key} must contain at least 32 characters.`);
  }
  if (env.INBOUND_EMAIL_TOKEN === env.ADMIN_TOKEN) throw new Error('Use separate intake and administration tokens.');
  if (env.AI_ENCRYPTION_KEY && env.AI_ENCRYPTION_KEY.length < 32) throw new Error('AI_ENCRYPTION_KEY must contain at least 32 characters.');
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
    actions: actionsConfigFromEnv(env),
    aiEncryptionKey: env.AI_ENCRYPTION_KEY || '',
    trustProxyHops,
    dashboardAdminEmail: env.DASHBOARD_ADMIN_EMAIL || 'admin@assetdesk.local',
    dashboardAdminPassword: env.DASHBOARD_ADMIN_PASSWORD || null,
    cookieSecure: env.COOKIE_SECURE === 'true',
    port, databasePath: env.DATABASE_PATH || './data/assetdesk.sqlite',
    inboundToken: env.INBOUND_EMAIL_TOKEN, adminToken: env.ADMIN_TOKEN,
    prefixes: env.ASSET_PREFIXES ? env.ASSET_PREFIXES.split(',').map(v => v.trim()).filter(Boolean) : undefined,
    supportEmails: (env.SUPPORT_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean),
  };
}
