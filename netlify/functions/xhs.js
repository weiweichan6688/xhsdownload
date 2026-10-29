// 小红书无水印视频解析 - Netlify Function
// 原理：服务端用「移动端 UA」请求笔记页，取 __INITIAL_STATE__ 里的
// video.consumer.originVideoKey，拼成 sns-video-bd.xhscdn.com/{key} 即为无水印原片。

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

function buildHeaders(cookie) {
  const h = {
    'User-Agent': MOBILE_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

// 从任意文本里抠出小红书链接（兼容分享文案混着中文）
function extractUrl(text) {
  const m =
    text.match(/https?:\/\/(?:www\.)?xiaohongshu\.com\/\S+/i) ||
    text.match(/https?:\/\/xhslink\.(?:com|cn)\/\S+/i);
  if (!m) return '';
  return m[0].replace(/[)'”」，。]+$/, '').trim();
}

function cleanText(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 解析 window.__INITIAL_STATE__（页面里含 undefined，需要转成 null 才能 JSON.parse）
function parseState(html) {
  const marker = 'window.__INITIAL_STATE__';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const eq = html.indexOf('=', start + marker.length);
  if (eq === -1) return null;
  const end = html.indexOf('</script>', eq);
  if (end === -1) return null;

  const raw = html.slice(eq + 1, end).trim().replace(/;+\s*$/, '');
  let text;
  try {
    if (raw.startsWith('JSON.parse(')) {
      text = JSON.parse(raw.slice('JSON.parse('.length).replace(/\)\s*;?\s*$/, ''));
    } else if (raw.startsWith('"')) {
      text = JSON.parse(raw);
    } else {
      text = raw;
    }
    // JS 的 undefined -> null（仅在结构位置替换，避免误伤字符串）
    text = text.replace(/(?<=[:,\[])\s*undefined\s*(?=[,}\]])/g, 'null');
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function getNoteId(url) {
  let m = url.match(/\/(?:explore|discovery\/item|search_result)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  m = url.match(/[?&]note_id=([A-Za-z0-9]+)/);
  if (m) return m[1];
  return '';
}

// 若被重定向到登录页，从 redirectPath 里还原真实笔记地址
function unwrapLogin(url) {
  if (!/\/login\b/.test(url)) return url;
  try {
    const u = new URL(url);
    const rp = u.searchParams.get('redirectPath');
    if (rp) return rp.replace(/^http:\/\//i, 'https://');
  } catch (e) {}
  return url;
}

async function resolveShort(url, cookie) {
  if (!/xhslink\.(?:com|cn)/i.test(url)) return url;
  const res = await fetch(url, { redirect: 'follow', headers: buildHeaders(cookie) });
  return res.url || url;
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

    // 1) 短链还原（移动端 UA 下 xhslink.cn 会直接跳到笔记页）
    url = await resolveShort(url, cookie);
    // 2) 万一落到登录页，从 redirectPath 取回真实地址
    url = unwrapLogin(url);

    const noteId = getNoteId(url);
    if (!noteId) throw new Error('无法从链接中解析笔记 ID，请确认链接完整');

    // 3) 直接请求真实笔记地址（保留 xsec_token 等参数）
    const res = await fetch(url, { redirect: 'follow', headers: buildHeaders(cookie) });
    const finalUrl = res.url || url;
    if (/\/login\b/.test(finalUrl)) {
      throw new Error('该笔记需要登录才能查看。请把浏览器 Cookie 填到「Cookie」框后重试。');
    }

    const html = await res.text();
    const state = parseState(html);
    if (!state) {
      throw new Error('页面未返回数据。若笔记需要登录可见，请填写 Cookie 后重试。');
    }

    // 兼容新旧两种结构
    const note =
      (state.noteData && state.noteData.data && state.noteData.data.noteData) ||
      (state.note && state.note.noteCard) ||
      null;
    if (!note) {
      throw new Error('未找到笔记内容，链接可能已失效或需要登录');
    }

    const video = note.video;
    if (!video) {
      throw new Error('该笔记不是视频笔记（可能是图文），无法提取视频');
    }

    // 4) 无水印原片：video.consumer.originVideoKey
    let ovk = video.consumer && video.consumer.originVideoKey;
    if (!ovk && video.mediaV2) {
      try { ovk = JSON.parse(video.mediaV2).consumer?.originVideoKey; } catch (e) {}
    }

    let videoUrl = '';
    let watermarked = false;
    if (ovk) {
      videoUrl = `https://sns-video-bd.xhscdn.com/${ovk}`;
    } else {
      // 兜底：带水印的转码版（h264 优先）
      const h264 = (video.media && video.media.stream && video.media.stream.h264) || [];
      const h265 = (video.media && video.media.stream && video.media.stream.h265) || [];
      const m = (h264[0] && h264[0].masterUrl) || (h265[0] && h265[0].masterUrl) || '';
      if (m) {
        videoUrl = m.replace(/^http:/, 'https:');
        watermarked = true;
      }
    }
    if (!videoUrl) throw new Error('未找到视频地址');

    const title = cleanText(note.title || note.desc || 'xhs_video');
    const author = cleanText(
      (note.user && (note.user.nickname || note.user.nickName || note.user.name)) || ''
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        author,
        videoUrl,
        type: 'mp4',
        watermarked,
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
