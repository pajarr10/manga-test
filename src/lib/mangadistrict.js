const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.104 Mobile Safari/537.36'
];

const BASE_URL = 'https://mangadistrict.com';
let uaIndex = 0;

function getHeaders(referer) {
  const ua = userAgents[uaIndex % userAgents.length];
  uaIndex++;
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': referer || BASE_URL + '/',
    'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Connection': 'keep-alive',
    'Cache-Control': 'max-age=0'
  };
}

async function fetchWithRetry(url, retries = 5, referer = null) {
  const headers = getHeaders(referer || url);
  const config = {
    url,
    method: 'GET',
    headers,
    timeout: 30000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    maxRedirects: 5,
    decompress: true,
    validateStatus: status => status >= 200 && status < 400
  };
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios(config);
      return response;
    } catch (err) {
      if (err.response && err.response.status >= 300 && err.response.status < 400) {
        return err.response;
      }
      lastError = err;
      if (err.response && err.response.status === 403) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
        continue;
      }
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastError || new Error('Fetch failed after retries');
}

function clean(obj) {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const cleaned = obj.map(i => clean(i)).filter(i => i !== undefined);
    return cleaned.length ? cleaned : undefined;
  }
  if (typeof obj === 'object') {
    const result = {};
    for (const key of Object.keys(obj)) {
      const val = clean(obj[key]);
      if (val !== undefined) result[key] = val;
    }
    return Object.keys(result).length ? result : undefined;
  }
  return obj;
}

function parseChapterNumber(text) {
  if (!text) return null;
  const match = text.match(/(?:Vol\.?\s*\d+[:\s]*)?[Cc]h(?:apter)?\s*(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

class MangaDistrictScraper {
  constructor() {
    this.creator = 'rynaqrtz';
    this.baseUrl = BASE_URL;
  }

  async list(url) {
    const html = (await fetchWithRetry(url)).data;
    const $ = cheerio.load(html);

    const items = [];
    $('.page-item-detail.manga').each((i, el) => {
      const $el = $(el);

      const titleEl = $el.find('.post-title h3 a, .post-title h1 a').first();
      const title = titleEl.text().trim();
      const link = titleEl.attr('href');

      if (!title || !link) return;

      const posterEl = $el.find('.item-thumb img, .summary_image img').first();
      const poster = posterEl.attr('data-src') || posterEl.attr('data-lazy-src') || posterEl.attr('data-original') || posterEl.attr('src') || null;

      let rating = null;
      const ratingText = $el.find('.score.font-meta.total_votes, .post-rating .score').text().trim();
      if (ratingText) {
        const match = ratingText.match(/([\d.]+)/);
        if (match) rating = parseFloat(match[1]);
      }

      let status = null;
      const badges = [];
      $el.find('.manga-title-badges .text').each((j, b) => {
        const txt = $(b).text().trim();
        badges.push(txt);
        if (['Ongoing', 'Completed', 'Hiatus', 'On-Going', 'Complete'].includes(txt)) {
          status = txt;
        }
      });

      const chapterEl = $el.find('.list-chapter .chapter-item:first-child .chapter a').first();
      const latestChapter = {
        title: chapterEl.text().trim() || null,
        url: chapterEl.attr('href') || null
      };

      let updateTime = null;
      const timeSelectors = [
        '.list-chapter .chapter-item:first-child .post-on .timediff',
        '.list-chapter .chapter-item:first-child .post-on time',
        '.chapter-date',
        '.post-on time'
      ];
      for (const sel of timeSelectors) {
        const el = $el.find(sel).first();
        if (el.length) {
          updateTime = el.text().trim() || el.attr('datetime') || null;
          if (updateTime) break;
        }
      }

      const viewsEl = $el.find('.list-chapter .chapter-item:first-child .views').first();
      const views = viewsEl.text().trim() || null;

      const genres = [];
      const genreSelectors = [
        '.mg_genres .summary-content a',
        '.genres-content a',
        '.post-content_item.mg_genres .summary-content a',
        '.item-summary .genres a'
      ];
      for (const sel of genreSelectors) {
        const found = $el.find(sel);
        if (found.length) {
          found.each((j, g) => genres.push($(g).text().trim()));
          break;
        }
      }

      const authorSelectors = ['.mg_author .summary-content', '.author-content a'];
      let author = null;
      for (const sel of authorSelectors) {
        const el = $el.find(sel).first();
        if (el.length) { author = el.text().trim() || null; break; }
      }

      const artistSelectors = ['.mg_artist .summary-content', '.artist-content a'];
      let artist = null;
      for (const sel of artistSelectors) {
        const el = $el.find(sel).first();
        if (el.length) { artist = el.text().trim() || null; break; }
      }

      const yearSelectors = ['.release-year', '.mg_release_year .summary-content'];
      let year = null;
      for (const sel of yearSelectors) {
        const el = $el.find(sel).first();
        if (el.length) { year = el.text().trim() || null; break; }
      }

      items.push({
        title,
        link: link.startsWith('http') ? link : this.baseUrl + link,
        poster,
        rating,
        status,
        badges,
        latestChapter,
        updateTime,
        views,
        genres,
        author,
        artist,
        year
      });
    });

    let next = null;
    const nextEl = $('.wp-pagenavi .page-numbers.next');
    if (nextEl.length) next = nextEl.attr('href');

    const currentPage = parseInt($('.wp-pagenavi .page-numbers.current').text()) || 1;

    return clean({
      creator: this.creator,
      page: 'list',
      data: {
        url,
        count: items.length,
        currentPage,
        items,
        next: next ? (next.startsWith('http') ? next : this.baseUrl + next) : null
      }
    });
  }

  async detail(slug) {
    const url = slug.startsWith('http') ? slug : this.baseUrl + '/series/' + slug.replace(/^\/+/, '');
    const html = (await fetchWithRetry(url)).data;
    const $ = cheerio.load(html);

    const title = $('.profile-manga .post-title h1').text().trim() || $('meta[property="og:title"]').attr('content') || '';
    const posterNode = $('.profile-manga .summary_image img').first();
    const poster = posterNode.attr('data-src') || posterNode.attr('data-lazy-src') || posterNode.attr('data-original') || posterNode.attr('src') || null;

    const altNames = [];
    const altEl = $('.post-content_item:contains("Alternative") .summary-content');
    if (altEl.length) {
      altEl.text().split(',').forEach(s => {
        const trimmed = s.trim();
        if (trimmed) altNames.push(trimmed);
      });
    }

    const author = $('.mg_author .summary-content').text().trim() || null;
    const artist = $('.mg_artist .summary-content').text().trim() || null;

    const genres = [];
    $('.mg_genres .summary-content a, .genres-content a').each((i, el) => {
      const text = $(el).text().trim();
      if (text) genres.push(text);
    });

    const tags = [];
    $('.mg_tags .summary-content a, .tags-content a, .post-content_item:contains("Tag") .summary-content a, a[href*="/publication-tag/"]').each((i, el) => {
      const text = $(el).text().trim();
      if (text && !tags.includes(text)) tags.push(text);
    });

    const year = $('.release-year, .mg_release_year .summary-content').text().trim() || null;
    const status = $('.mg_status .summary-content').text().trim() || null;
    const type = $('.mg_type .summary-content, .post-content_item:contains("Type") .summary-content').first().text().trim() || null;
    const views = $('.manga-views, .post-content_item:contains("Views") .summary-content, .views').first().text().trim() || null;
    const banner = $('meta[property="og:image"]').attr('content') || poster || null;

    let rating = null;
    let ratingCount = null;
    const ratingEl = $('.post-rating .score');
    if (ratingEl.length) {
      rating = parseFloat(ratingEl.text().trim());
      const countEl = $('.post-rating .count');
      if (countEl.length) {
        const countText = countEl.text().trim();
        const match = countText.match(/(\d+)/);
        if (match) ratingCount = parseInt(match[1]);
      }
    }

    const description = $('.description-summary').text().trim() || null;

    const hasLoadMore = $('.load-more-chapters, .loadmore-action').length > 0;
    const related = [];
    $('.related-posts .page-item-detail.manga, .related-reading-wrap .page-item-detail.manga, .manga-related .page-item-detail.manga, .related-post .c-tabs-item').each((i, el) => {
      const $el = $(el);
      const titleEl = $el.find('.post-title h3 a, .post-title h4 a, h3 a, h4 a, a').first();
      const rTitle = titleEl.text().trim();
      const rLink = titleEl.attr('href');
      if (!rTitle || !rLink) return;
      const img = $el.find('img').first();
      related.push({
        title: rTitle,
        link: rLink.startsWith('http') ? rLink : this.baseUrl + rLink,
        poster: img.attr('data-src') || img.attr('data-lazy-src') || img.attr('data-original') || img.attr('src') || null
      });
    });

    let chapters = [];
    $('.page-content-listing .wp-manga-chapter, .listing-chapters_wrap .wp-manga-chapter, .version-chap .wp-manga-chapter').each((i, el) => {
      const $el = $(el);
      const linkEl = $el.find('a').first();
      const title = linkEl.find('.chap-title').text().trim() || linkEl.text().trim();
      const url = linkEl.attr('href');
      const date = $el.find('.chap-date').text().trim() || null;
      const number = parseChapterNumber(title);

      chapters.push({
        number,
        title,
        url: url ? (url.startsWith('http') ? url : this.baseUrl + url) : null,
        date
      });
    });

    return clean({
      creator: this.creator,
      page: 'detail',
      data: {
        url,
        slug,
        title,
        poster,
        banner,
        altNames,
        author,
        artist,
        genres,
        tags,
        year,
        release: year,
        status,
        type,
        views,
        rating,
        ratingCount,
        description,
        hasLoadMore,
        chapters,
        related
      }
    });
  }

  async episodeVideo(url) {
    const html = (await fetchWithRetry(url, 5, url)).data;
    const $ = cheerio.load(html);

    let iframeSrc = $('iframe').first().attr('src') || null;
    if (iframeSrc && iframeSrc.includes('discord.com')) iframeSrc = null;

    const videoSrc = $('video source').first().attr('src') || $('video').first().attr('src') || null;
    const videoLinks = [];
    $('a[href$=".mp4"], a[href$=".m3u8"]').each((i, el) => {
      videoLinks.push($(el).attr('href'));
    });

    let jsonData = null;
    $('script:not([src])').each((i, el) => {
      const text = $(el).html();
      if (text && (text.includes('video') || text.includes('player'))) {
        try {
          const match = text.match(/(\{.*"video".*\})/);
          if (match) jsonData = JSON.parse(match[1]);
        } catch(e) {}
      }
    });

    const images = [];
    $('.reading-content img, .entry-content img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && !src.includes('data:image')) {
        images.push({ src, index: i + 1 });
      }
    });

    let prevEpisode = null;
    const prevEl = $('.nav-previous a, .nav-links a:contains("Previous")');
    if (prevEl.length) prevEpisode = prevEl.attr('href');

    let nextEpisode = null;
    const nextEl = $('.nav-next a, .nav-links a:contains("Next")');
    if (nextEl.length) nextEpisode = nextEl.attr('href');

    const episodes = [];
    $('select.paged-links option').each((i, el) => {
      const val = $(el).attr('value');
      const text = $(el).text().trim();
      if (val) {
        episodes.push({
          title: text,
          url: val.startsWith('http') ? val : this.baseUrl + val
        });
      }
    });

    return clean({
      creator: this.creator,
      page: 'episode_video',
      data: {
        url,
        title: $('meta[property="og:title"]').attr('content') || null,
        iframeSrc,
        videoSrc,
        videoLinks,
        jsonData,
        images,
        prevEpisode: prevEpisode ? (prevEpisode.startsWith('http') ? prevEpisode : this.baseUrl + prevEpisode) : null,
        nextEpisode: nextEpisode ? (nextEpisode.startsWith('http') ? nextEpisode : this.baseUrl + nextEpisode) : null,
        episodes
      }
    });
  }

  async chapter(url) {
    const html = (await fetchWithRetry(url, 5, url)).data;
    const $ = cheerio.load(html);

    const hasVideo = $('video').length > 0 ||
                     $('source[src$=".m3u8"]').length > 0 ||
                     $('a[href$=".m3u8"], a[href$=".mp4"]').length > 0 ||
                     ($('script:not([src])').text().includes('video') && $('script:not([src])').text().includes('m3u8'));

    if (hasVideo) {
      return this.episodeVideo(url);
    }

    const title = $('.entry-header .breadcrumb span:last-child').text().trim() ||
                  $('.entry-header .breadcrumb a:last-child').text().trim() ||
                  $('meta[property="og:title"]').attr('content') ||
                  $('h1.entry-title').text().trim() ||
                  '';

    const images = [];
    $('.reading-content.manga-chapter img, .reading-content img, .page-break img').each((i, el) => {
      const $el = $(el);
      const src = $el.attr('src') ||
                  $el.attr('data-src') ||
                  $el.attr('data-lazy-src') ||
                  $el.attr('data-original') ||
                  $el.attr('data-cfsrc') ||
                  null;
      if (src && !src.startsWith('data:image')) {
        images.push({
          src,
          alt: $el.attr('alt') || null,
          index: i + 1
        });
      }
    });

    if (images.length === 0) {
      $('.page-break, .reading-content div[style*="background"]').each((i, el) => {
        const style = $(el).attr('style');
        if (style) {
          const match = style.match(/url\(['"]?(.*?)['"]?\)/);
          if (match && match[1]) {
            images.push({
              src: match[1],
              alt: null,
              index: i + 1
            });
          }
        }
      });
    }

    let prevChapter = null;
    const prevEl = $('.nav-previous a, .nav-links a:contains("Previous")');
    if (prevEl.length) prevChapter = prevEl.attr('href');

    let nextChapter = null;
    const nextEl = $('.nav-next a, .nav-links a:contains("Next")');
    if (nextEl.length) nextChapter = nextEl.attr('href');

    const chapters = [];
    $('select.paged-links option').each((i, el) => {
      const val = $(el).attr('value');
      const text = $(el).text().trim();
      if (val) {
        chapters.push({
          number: parseChapterNumber(text),
          title: text,
          url: val.startsWith('http') ? val : this.baseUrl + val
        });
      }
    });

    return clean({
      creator: this.creator,
      page: 'chapter',
      data: {
        url,
        title,
        images,
        prevChapter: prevChapter ? (prevChapter.startsWith('http') ? prevChapter : this.baseUrl + prevChapter) : null,
        nextChapter: nextChapter ? (nextChapter.startsWith('http') ? nextChapter : this.baseUrl + nextChapter) : null,
        chapters
      }
    });
  }

  async search(query, page = 1) {
    const url = page === 1
      ? this.baseUrl + `/?s=${encodeURIComponent(query)}&post_type=wp-manga`
      : this.baseUrl + `/page/${page}/?s=${encodeURIComponent(query)}&post_type=wp-manga`;
    return this.list(url);
  }

  async home(page = 1) {
    const url = page === 1 ? this.baseUrl + '/' : this.baseUrl + `/page/${page}/`;
    return this.list(url);
  }

  async series(orderby = 'latest', page = 1) {
    const orderMap = {
      latest: '',
      title: 'title',
      trending: 'trending',
      rating: 'rating',
      views: 'views',
      new: 'new-manga',
      modified: 'modified'
    };
    const order = orderMap[orderby] || '';
    const url = page === 1
      ? this.baseUrl + `/series/${order ? '?m_orderby=' + order : ''}`
      : this.baseUrl + `/series/page/${page}/${order ? '?m_orderby=' + order : ''}`;
    return this.list(url);
  }

  async genre(slug, orderby = 'latest', page = 1) {
    const orderMap = {
      latest: '',
      title: 'title',
      trending: 'trending',
      rating: 'rating',
      views: 'views',
      new: 'new-manga',
      modified: 'modified'
    };
    const order = orderMap[orderby] || '';
    const url = page === 1
      ? this.baseUrl + `/publication-genre/${slug}/${order ? '?m_orderby=' + order : ''}`
      : this.baseUrl + `/publication-genre/${slug}/page/${page}/${order ? '?m_orderby=' + order : ''}`;
    return this.list(url);
  }

  async tag(slug, orderby = 'latest', page = 1) {
    const orderMap = {
      latest: '',
      title: 'title',
      trending: 'trending',
      rating: 'rating',
      views: 'views',
      new: 'new-manga',
      modified: 'modified'
    };
    const order = orderMap[orderby] || '';
    const url = page === 1
      ? this.baseUrl + `/publication-tag/${slug}/${order ? '?m_orderby=' + order : ''}`
      : this.baseUrl + `/publication-tag/${slug}/page/${page}/${order ? '?m_orderby=' + order : ''}`;
    return this.list(url);
  }

  async release(year, orderby = 'latest', page = 1) {
    const orderMap = {
      latest: '',
      title: 'title',
      trending: 'trending',
      rating: 'rating',
      views: 'views',
      new: 'new-manga',
      modified: 'modified'
    };
    const order = orderMap[orderby] || '';
    const url = page === 1
      ? this.baseUrl + `/publication-release/${year}/${order ? '?m_orderby=' + order : ''}`
      : this.baseUrl + `/publication-release/${year}/page/${page}/${order ? '?m_orderby=' + order : ''}`;
    return this.list(url);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  const params = args.slice(1);
  const scraper = new MangaDistrictScraper();

  (async () => {
    let result;
    try {
      switch (command) {
        case 'home':
          result = await scraper.home(parseInt(params[0]) || 1);
          break;
        case 'series':
          result = await scraper.series(params[0] || 'latest', parseInt(params[1]) || 1);
          break;
        case 'search':
          if (!params[0]) throw new Error('Query required');
          result = await scraper.search(params[0], parseInt(params[1]) || 1);
          break;
        case 'genre':
          if (!params[0]) throw new Error('Genre slug required');
          result = await scraper.genre(params[0], params[1] || 'latest', parseInt(params[2]) || 1);
          break;
        case 'tag':
          if (!params[0]) throw new Error('Tag slug required');
          result = await scraper.tag(params[0], params[1] || 'latest', parseInt(params[2]) || 1);
          break;
        case 'release':
          if (!params[0]) throw new Error('Year required');
          result = await scraper.release(params[0], params[1] || 'latest', parseInt(params[2]) || 1);
          break;
        case 'detail':
          if (!params[0]) throw new Error('Slug or URL required');
          result = await scraper.detail(params[0]);
          break;
        case 'chapter':
          if (!params[0]) throw new Error('Slug or URL required');
          result = await scraper.chapter(params[0]);
          break;
        case 'episode-video':
          if (!params[0]) throw new Error('URL required');
          result = await scraper.episodeVideo(params[0]);
          break;
        default:
          console.error('Unknown command');
          console.log(`
Commands:
  home [page]                    - Homepage (latest series)
  series [orderby] [page]        - Series list (orderby: latest, title, trending, rating, views, new, modified)
  search <query> [page]          - Search manga
  genre <slug> [orderby] [page]  - Filter by genre (e.g. uncensored)
  tag <slug> [orderby] [page]    - Filter by tag (e.g. tsundere)
  release <year> [orderby] [page] - Filter by release year (e.g. 2026)
  detail <slug|url>              - Get series detail + chapter list
  chapter <url>                  - Get chapter images (auto-detects video)
  episode-video <url>            - Force video extraction
          `);
          process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(JSON.stringify({ error: err.message }));
      process.exit(1);
    }
  })();
}

module.exports = MangaDistrictScraper;