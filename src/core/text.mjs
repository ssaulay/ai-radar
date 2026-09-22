// Normalisation de texte, HTML -> texte lisible, extraction de liens. Aucune dependance.
import crypto from 'node:crypto';

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// Normalisation pour comparer un extrait au texte d'une page : casse, espaces, apostrophes et tirets typographiques.
export const norm = s => (s ?? '').normalize('NFKC').toLowerCase().replace(/[’‘`´]/g, "'").replace(/[–—‐]/g, '-').replace(/\s+/g, ' ').trim();

// Normalisation d'un nom de personne ou d'organisation pour servir de cle d'identite (sans accents ni ponctuation).
export const normName = s => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9' -]/g, '').replace(/\s+/g, ' ').trim();

// Cle d'identite d'une personne : tokens du nom tries, pour que "BRUNELLI Filippo" et "Filippo Brunelli" coincident.
export const personKey = (name, orgId) => `${normName(name).replace(/\b(phd|md|msc|prof|dr|pharmd|mba)\b\.?/g, '').replace(/,/g, '').split(' ').filter(Boolean).sort().join(' ')}|${orgId}`;

export const decodeEntities = s => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

export function htmlToText(html) {
  let h = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|figcaption|blockquote|dd|dt)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<[^>]+>/g, ' ');
  return decodeEntities(h).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function extractLinks(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { out.push({ href: new URL(m[1], baseUrl).href, text: decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() }); } catch {}
  }
  for (const m of html.matchAll(/<link\b[^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/gi)) {
    try { out.push({ href: new URL(m[1], baseUrl).href, text: 'RSS', rss: true }); } catch {}
  }
  return out;
}

// Verdict mecanique sur une proposition {name, role, quote} contre le texte normalise d'un document.
export function verifyProposal(p, normText) {
  const name = String(p.name ?? '').trim(), role = String(p.role ?? '').trim(), quote = String(p.quote ?? '').trim();
  if (!name || !quote) return 'REJECTED_EMPTY';
  if (!normText.includes(norm(quote))) return 'REJECTED_QUOTE_NOT_IN_DOCUMENT';
  if (!norm(quote).includes(norm(name))) return 'REJECTED_NAME_NOT_IN_QUOTE';
  if (!role) return 'REJECTED_NO_ROLE';
  if (name.split(/\s+/).length < 2) return 'REJECTED_SINGLE_TOKEN_NAME';
  return 'VERIFIED';
}

export const hostOf = url => new URL(url).host.replace(/^www\./, '');
