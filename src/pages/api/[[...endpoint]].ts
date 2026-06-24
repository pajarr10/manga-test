import type { NextApiRequest, NextApiResponse } from 'next';
import axios from 'axios';
import * as cheerio from 'cheerio';

// Satu file API untuk semua endpoint agar project tetap ringkas.
const MangaDistrictScraper = require('../../lib/mangadistrict.js');

const BASE_URL = 'https://mangadistrict.com';
const CACHE_TTL = 5 * 60 * 1000;
const CHAPTER_TTL = 15 * 60 * 1000;
const cache = new Map<string, { data: unknown; exp: number }>();
const limits = new Map<string, { count: number; exp: number }>();
const orderValues = ['latest', 'title', 'trending', 'rating', 'views', 'new', 'modified'];

const adultGenreFallback = ['Adult', '18+', 'Mature', 'Ecchi', 'Hentai', 'Uncensored'];
const genreFallback = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Romance', 'School Life', 'Shounen', 'Shoujo', 'Seinen', 'Slice of Life', 'Supernatural', 'Mystery', 'Horror', 'Isekai', 'Manhwa', 'Manhua', ...adultGenreFallback];
const tagFallback = ['Magic', 'Reincarnation', 'Regression', 'System', 'Dungeon', 'Villainess', 'Royalty', 'Monster', 'Game', 'Harem', 'NSFW', ...adultGenreFallback];

function page(v: unknown) { const n = Number(String(Array.isArray(v) ? v[0] : v || '1').replace(/\D/g, '')); return Number.isFinite(n) && n > 0 ? Math.min(999, n) : 1; }
function text(v: unknown, max = 240) { return String(Array.isArray(v) ? v[0] : v || '').trim().replace(/[<>`"']/g, '').slice(0, max); }
function slug(v: unknown) { return text(v, 180).replace(/[^a-zA-Z0-9+_.~%:-]/g, ''); }
function order(v: unknown) { const x = text(v || 'latest') as string; return orderValues.includes(x) ? x : 'latest'; }
function safeUrl(v: unknown) { try { const u = new URL(String(Array.isArray(v) ? v[0] : v || '')); return ['http:', 'https:'].includes(u.protocol) ? u.toString() : ''; } catch { return ''; } }
function termSlug(name: string) { return name.toLowerCase().trim().replace(/&/g, 'and').replace(/[^a-z0-9+]+/g, '-').replace(/^-+|-+$/g, '').replace(/\+/g, 'plus'); }
function isAdultTerm(s = '') { return /(^|[\s_./+|#,:;()\[\]{}-])(18\+|adult|nsfw|uncensored|mature|ecchi|hentai|smut|dewasa|erotic|xxx)(?=$|[\s_./+|#,:;()\[\]{}-])/i.test(s); }
function term(name: string, kind: 'genre' | 'tag', url?: string) { const hit = url?.match(/publication-(?:genre|tag)\/([^/?#]+)/i)?.[1]; const clean = name.replace(/\s+/g, ' ').trim(); return { name: clean, slug: decodeURIComponent(hit || termSlug(clean)), url, kind, adult: isAdultTerm(clean) || isAdultTerm(hit || '') }; }
function uniq<T>(arr: T[], key: (x: T) => string) { const seen = new Set<string>(); return arr.filter((x) => { const k = key(x).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }
async function cached<T>(key: string, ttl: number, fn: () => Promise<T>) { const hit = cache.get(key); if (hit && hit.exp > Date.now()) return hit.data as T; const data = await fn(); cache.set(key, { data, exp: Date.now() + ttl }); return data; }
function rateLimit(req: NextApiRequest, res: NextApiResponse) { const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip').split(',')[0]; const now = Date.now(); const hit = limits.get(ip); if (!hit || hit.exp < now) { limits.set(ip, { count: 1, exp: now + 60_000 }); return true; } hit.count += 1; if (hit.count > 100) { res.status(429).json({ error: 'Terlalu banyak request. Coba lagi sebentar lagi.' }); return false; } return true; }
async function timeout<T>(p: Promise<T>, ms = 60_000) { return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('Scraper timeout')), ms))]); }

async function taxonomy() {
  return cached('taxonomy', 6 * 60 * 60 * 1000, async () => {
    const genres: any[] = [];
    const tags: any[] = [];
    try {
      const html = (await axios.get(`${BASE_URL}/series/`, { timeout: 20_000, headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${BASE_URL}/` } })).data;
      const $ = cheerio.load(html);
      $('a[href*="/publication-genre/"]').each((_, el) => { const name = $(el).text().trim(); const href = $(el).attr('href'); if (name) genres.push(term(name, 'genre', href?.startsWith('http') ? href : `${BASE_URL}${href}`)); });
      $('a[href*="/publication-tag/"]').each((_, el) => { const name = $(el).text().trim(); const href = $(el).attr('href'); if (name) tags.push(term(name, 'tag', href?.startsWith('http') ? href : `${BASE_URL}${href}`)); });
    } catch { /* fallback operasional */ }
    genreFallback.forEach((g) => genres.push(term(g, 'genre')));
    tagFallback.forEach((t) => tags.push(term(t, 'tag')));
    return { creator: 'pazm', page: 'taxonomy', data: { genres: uniq(genres, (x) => x.slug).sort((a, b) => Number(a.adult) - Number(b.adult) || a.name.localeCompare(b.name)), tags: uniq(tags, (x) => x.slug).sort((a, b) => Number(a.adult) - Number(b.adult) || a.name.localeCompare(b.name)), updatedAt: new Date().toISOString() } };
  });
}

async function proxyImage(req: NextApiRequest, res: NextApiResponse) {
  const url = safeUrl(req.query.url);
  if (!url) return res.status(400).end('Invalid image URL');
  const img = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 30_000, maxContentLength: 35 * 1024 * 1024, headers: { Referer: `${BASE_URL}/`, 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*;q=0.8' } });
  res.setHeader('Content-Type', String(img.headers['content-type'] || 'image/jpeg'));
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800');
  return res.send(Buffer.from(img.data));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  if (!rateLimit(req, res)) return;
  const parts = (Array.isArray(req.query.endpoint) ? req.query.endpoint : []) as string[];
  const ep = parts[0] || 'home';
  const scraper = new MangaDistrictScraper();
  try {
    if (ep === 'image') return proxyImage(req, res);
    let result: unknown;
    if (ep === 'home') result = await cached(`home:${page(req.query.page)}`, CACHE_TTL, () => timeout(scraper.home(page(req.query.page))));
    else if (ep === 'search') result = text(req.query.query ?? req.query.q, 120) ? await cached(`search:${text(req.query.query ?? req.query.q)}:${page(req.query.page)}`, CACHE_TTL, () => timeout(scraper.search(text(req.query.query ?? req.query.q, 120), page(req.query.page)))) : { creator: 'pazm', page: 'search', data: { items: [], count: 0, currentPage: 1 } };
    else if (ep === 'series') result = await cached(`series:${order(req.query.orderby)}:${page(req.query.page)}`, CACHE_TTL, () => timeout(scraper.series(order(req.query.orderby), page(req.query.page))));
    else if (ep === 'genre') result = await cached(`genre:${slug(parts[1] || req.query.slug)}:${order(req.query.orderby)}:${page(req.query.page)}`, CACHE_TTL, () => timeout(scraper.genre(slug(parts[1] || req.query.slug), order(req.query.orderby), page(req.query.page))));
    else if (ep === 'tag') result = await cached(`tag:${slug(parts[1] || req.query.slug)}:${order(req.query.orderby)}:${page(req.query.page)}`, CACHE_TTL, () => timeout(scraper.tag(slug(parts[1] || req.query.slug), order(req.query.orderby), page(req.query.page))));
    else if (ep === 'release') result = await cached(`release:${slug(parts[1] || req.query.year)}:${order(req.query.orderby)}:${page(req.query.page)}`, CACHE_TTL, () => timeout(scraper.release(slug(parts[1] || req.query.year), order(req.query.orderby), page(req.query.page))));
    else if (ep === 'detail') { const id = safeUrl(req.query.url) || slug(req.query.slug); if (!id) throw new Error('Slug atau URL wajib diisi'); result = await cached(`detail:${id}`, CACHE_TTL, () => timeout(scraper.detail(id))); }
    else if (ep === 'chapter') { const url = safeUrl(req.query.url); if (!url) throw new Error('Chapter URL wajib diisi'); result = await cached(`chapter:${url}`, CHAPTER_TTL, () => timeout(scraper.chapter(url), 75_000)); }
    else if (ep === 'episode-video') { const url = safeUrl(req.query.url); if (!url) throw new Error('Episode URL wajib diisi'); result = await cached(`episode:${url}`, CHAPTER_TTL, () => timeout(scraper.episodeVideo(url), 75_000)); }
    else if (ep === 'taxonomy') result = await taxonomy();
    else return res.status(404).json({ error: 'Endpoint tidak ditemukan' });
    res.setHeader('Cache-Control', ep === 'chapter' || ep === 'episode-video' ? 's-maxage=900, stale-while-revalidate=1800' : 's-maxage=300, stale-while-revalidate=900');
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Server error' });
  }
}
