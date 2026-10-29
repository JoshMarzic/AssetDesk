import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';

const DEFAULT_PREFIXES = ['ASSET', 'LAPTOP', 'DESKTOP', 'PC', 'SRV', 'SERVER', 'PRINTER', 'MONITOR', 'SW'];
const MAX_ASSETS = 25;
const MAX_TEXT = 100_000;

function invalid(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cleanHeader(value, maxLength = 998) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, maxLength);
}

function messageIds(value) {
  const input = (Array.isArray(value) ? value : [value]).filter(Boolean).join(' ');
  return [...new Set(input.match(/<[^<>\s\x00-\x1f]{1,990}>/g) ?? [])].slice(-100);
}

/**
 * Detect known inventory tags, plus an explicit "Asset: ID" escape hatch.
 * Prefix-based IDs require a digit so prose such as SERVER-ROOM is not an asset.
 * URLs and email addresses are excluded to avoid detecting tags in signatures.
 */
export function extractAssetRefs(text, { prefixes = DEFAULT_PREFIXES } = {}) {
  const input = String(text ?? '').slice(0, MAX_TEXT + 240)
    .replace(/(?:[A-Z][A-Z0-9+.-]*:\/\/|www\.)[^\s<>]+/gi, ' ')
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ');
  const found = [];
  const add = (id, position) => {
    const normalized = id.toUpperCase();
    if (normalized.length <= 64) found.push({ id: normalized, position });
  };
  // The closing bracket is mandatory for bracketed references. Plain labels end
  // at whitespace or punctuation; punctuation at the end is not part of an ID.
  const explicit = /\[\s*asset\s*:\s*([A-Z0-9][A-Z0-9._-]{0,63})\s*\]|\basset(?:[ \t]+tag)?[ \t]*:[ \t]*([A-Z0-9][A-Z0-9._-]{0,63})(?![A-Z0-9._-])/gi;
  for (const match of input.matchAll(explicit)) {
    const id = (match[1] ?? match[2]).replace(/[._-]+$/, '');
    if (id) add(id, match.index);
  }
  const safePrefixes = [...new Set(prefixes.map(prefix => String(prefix).toUpperCase()))]
    .filter(prefix => /^[A-Z][A-Z0-9]{0,31}$/.test(prefix));
  if (safePrefixes.length) {
    const automatic = new RegExp(`(?<![A-Z0-9_@/.-])(?:${safePrefixes.join('|')})-[A-Z0-9]+(?:-[A-Z0-9]+)*(?![A-Z0-9_/-])`, 'gi');
    for (const match of input.matchAll(automatic)) {
      if (/\d/.test(match[0].slice(match[0].indexOf('-') + 1))) add(match[0], match.index);
    }
  }
  found.sort((a, b) => a.position - b.position);
  return [...new Set(found.map(value => value.id))].slice(0, MAX_ASSETS);
}

/** Parse an RFC 5322 message without accepting its HTML as trusted content. */
export async function parseRawEmail(raw, { maxBytes = 10_485_760, prefixes = DEFAULT_PREFIXES } = {}) {
  if (!Buffer.isBuffer(raw) && typeof raw !== 'string') throw invalid('Email must be an RFC 5322 message.');
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  if (buffer.length > maxBytes) throw invalid('Email exceeds the maximum message size.', 413);
  if (!buffer.length) throw invalid('Email is empty.');
  let parsed;
  try {
    parsed = await simpleParser(buffer, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true,
      maxHtmlLengthToParse: maxBytes,
    });
  } catch {
    throw invalid('Email could not be parsed.');
  }
  const addresses = parsed.from?.value ?? [];
  const fromHeaders = parsed.headerLines.filter(header => header.key === 'from');
  if (fromHeaders.length !== 1 || addresses.length !== 1) throw invalid('Email requires exactly one From address.');
  const address = addresses[0].address?.trim().toLowerCase();
  if (!address || address.length > 254 || !/^[^\s<>\x00-\x1f@]+@[^\s<>\x00-\x1f@]+\.[^\s<>\x00-\x1f@]+$/.test(address)) {
    throw invalid('Email requires a valid From address.');
  }
  // mailparser generates text for HTML-only messages. Rendering is always the
  // caller's responsibility: this string is untrusted text, never safe HTML.
  const text = String(parsed.text ?? '').replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw invalid('Email body is empty.');
  if (text.length > MAX_TEXT) throw invalid('Email body exceeds 100,000 characters.', 413);
  const subject = cleanHeader(parsed.subject || '(No subject)', 240);
  const messageId = messageIds(parsed.messageId)[0] ?? `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
  return {
    messageId,
    inReplyTo: messageIds(parsed.inReplyTo).at(-1) ?? null,
    references: messageIds(parsed.references),
    subject,
    from: { name: cleanHeader(addresses[0].name, 200), address },
    text,
    assetRefs: extractAssetRefs(`${subject}\n${text}`, { prefixes }),
    receivedAt: new Date().toISOString(),
  };
}
