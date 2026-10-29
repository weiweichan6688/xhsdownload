// 小红书无水印视频解析 - Netlify Function
// 通过服务端抓取笔记页面，提取官方返回的原始（无水印）视频直链。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function browserHeaders(cookie) {
  const h = {
    'User-Agent': UA,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://www.xiaohongshu.com/',
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

// 从任意文本里抠出小红书链接（兼容分享文案里混着中文的情况）
function extractUrl(text) {
  const m =
    text.match(/https?:\/\/(?:www\.)?xiaohongshu\.com\/\S+/i) ||
    text.match(/https?:\/\/xhslink\.(?:com|cn)\/\S+/i);
  if (!m) return '';
  return m[0].replace(/[)'”]$/, '').trim();
}

async function resolveShort(url, cookie) {
  if (!/xhslink\.(?:com|cn)/i.test(url)) return url;
  const res = await fetch(url, {
    redirect: 'follow',
    headers: browserHeaders(cookie),
  });
  return res.url || url;
}

function getNoteId(url) {
  let m = url.match(/\/(?:explore|discovery\/item|search_result)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  m = url.match(/[?&]note_id=([A-Za-z0-9]+)/);
  if (m) return m[1];
  return '';
}

function parseState(html) {
  const start = html.indexOf('window.__INITIAL_STATE__');
  if (start === -1) return null;
  const eq = html.indexOf('=', start);
  const end = html.indexOf('</script>', eq);
  if (end === -1) return null;
  let raw = html.slice(eq + 1, end).trim().replace(/;*\s*$/, '');
  // 有时数据是 JSON.parse("...") 双重编码
  if (raw.startsWith('"')) {
    raw = JSON.parse(raw);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findVideo(note) {
  const videoObj = note.video;
  if (!videoObj) return null;
  const candidates = [];
  if (videoObj.url) candidates.push({ url: videoObj.url, type: 'mp4' });

  const h264 = (videoObj.media && videoObj.media.stream && videoObj.media.stream.h264) || [];
  for (const s of h264) {
    if (s.url) candidates.push({ url: s.url, type: 'mp4' });
    if (s.masterUrl) {
      candidates.push({
        url: s.masterUrl,
        type: s.masterUrl.includes('.m3u8') ? 'm3u8' : 'mp4',
      });
    }
  }
  // 优先直接 mp4（原始无水印），其次 m3u8
  return candidates.find((c) => c.type === 'mp4') || candidates[0] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '请求格式错误' }) };
  }

  const input = (body.url || '').trim();
  const cookie = (body.cookie || '').trim();
  if (!input) {
    return { statusCode: 400, body: JSON.stringify({ error: '请输入小红书链接' }) };
  }

  try {
    let url = extractUrl(input);
    if (!url) throw new Error('未识别到有效的小红书链接');

    url = await resolveShort(url, cookie);

    const noteId = getNoteId(url);
    if (!noteId) throw new Error('无法从链接中解析笔记 ID');

    const pageUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
    const res = await fetch(pageUrl, {
      redirect: 'follow',
      headers: browserHeaders(cookie),
    });
    const html = await res.text();

    const state = parseState(html);
    if (!state) {
      throw new Error('页面未返回数据。若笔记需要登录可见，请在下方填写 Cookie 后重试。');
    }

    const note = state.note && state.note.noteCard;
    if (!note) throw new Error('未找到笔记内容，链接可能已失效或需要登录');

    const video = findVideo(note);
    if (!video) throw new Error('该笔记不是视频笔记（可能是图文），无法提取视频');

    const title = cleanText(note.title || note.desc || 'xhs_video');
    const author = cleanText((note.user && note.user.nickname) || '');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        author,
        videoUrl: video.url,
        type: video.type,
        noteId,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message || '解析失败' }),
    };
  }
};
