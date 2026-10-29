/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { API_CONFIG } from '@/lib/config';
import { buildCleanPath, verifyHlsUrl } from '@/lib/hlsSign';
import { filterAdsFromM3U8 } from '@/lib/m3u8AdFilter';

export const runtime = 'nodejs';

/**
 * 隔空播放（AirPlay）用的播放列表清理接口。
 * 电视不经过 iPad 上的 hls.js，直接访问这里：取原始 m3u8，
 * 用与播放页相同的规则删除广告分段和多余的分隔标记，
 * 再把切片地址改成绝对地址（切片仍由电视直接从采集站下载），
 * 并去掉经核对确属多余的分隔标记（防止电视每隔几十秒卡一下画面）。
 * 主播放列表里的子列表同样改为经过本接口。
 * 任何失败都重定向回原始地址，保证至少能正常播放。
 */
const FETCH_TIMEOUT_MS = 10000;

function absolutize(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

function rewriteUriAttr(line: string, map: (uri: string) => string): string {
  return line.replace(/URI="([^"]+)"/, (_, uri) => `URI="${map(uri)}"`);
}

/** 读取 TS 切片开头的最小 PTS（秒）；读不到（加密、非 TS 等）返回 null */
async function firstPts(url: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': API_CONFIG.search.headers['User-Agent'],
        Range: 'bytes=0-65535',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 65536) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => undefined);
    const buf = new Uint8Array(size);
    let pos = 0;
    for (const c of chunks) {
      buf.set(c, pos);
      pos += c.length;
    }
    // 跳过伪装头（部分资源站在 TS 前加图片头），找到连续的 0x47 同步字节
    let off = 0;
    while (
      off < buf.length - 376 &&
      !(buf[off] === 0x47 && buf[off + 188] === 0x47 && buf[off + 376] === 0x47)
    ) {
      off++;
    }
    let min: number | null = null;
    const seen = new Set<number>();
    for (let p = off; p + 188 <= buf.length && seen.size < 2; p += 188) {
      if (buf[p] !== 0x47) break;
      const pusi = buf[p + 1] & 0x40;
      const pid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
      const afc = (buf[p + 3] >> 4) & 3;
      if (!pusi || seen.has(pid) || !(afc & 1)) continue;
      let q = p + 4;
      if (afc & 2) q += 1 + buf[q];
      if (
        buf[q] === 0 &&
        buf[q + 1] === 0 &&
        buf[q + 2] === 1 &&
        buf[q + 7] & 0x80
      ) {
        const b = buf.subarray(q + 9, q + 14);
        const pts =
          (b[0] & 0x0e) * 536870912 +
          b[1] * 4194304 +
          (b[2] & 0xfe) * 16384 +
          b[3] * 128 +
          (b[4] >> 1);
        seen.add(pid);
        const sec = pts / 90000;
        min = min === null ? sec : Math.min(min, sec);
      }
    }
    return min;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 去掉多余的 #EXT-X-DISCONTINUITY。
 * 部分资源站（如如意）每隔几个切片就插一个分隔标记，但前后时间戳其实是连续的；
 * 电视（三星等）每遇到一个就会重新初始化解码器，表现为画面卡 1～2 秒、声音照常。
 * 做法：按 EXTINF 推算各分隔点的预期时间戳，抽样下载切片开头核对，
 * 全部吻合才去掉所有分隔标记；有任何一处对不上或读不到，原样保留。
 */
const PTS_SAMPLES = 6;
const PTS_TOLERANCE = 0.5;

async function dropSpuriousDiscontinuities(playlist: string): Promise<string> {
  if (/#EXT-X-KEY:(?!.*METHOD=NONE)/.test(playlist)) return playlist;
  const lines = playlist.split(/\r?\n/);
  const segs: { url: string; start: number; disc: boolean }[] = [];
  let t = 0;
  let pendingDur = 0;
  let disc = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-DISCONTINUITY')) disc = true;
    else if (line.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(line.slice(8)) || 0;
    } else if (line.trim() && !line.startsWith('#')) {
      segs.push({ url: line.trim(), start: t, disc });
      t += pendingDur;
      disc = false;
    }
  }
  const boundaries = segs
    .map((s, i) => (s.disc && i > 0 ? i : -1))
    .filter((i) => i > 0);
  if (boundaries.length < 3 || segs.length === 0) return playlist;

  // 均匀抽样分隔点
  const picks = new Set<number>();
  for (let k = 0; k < PTS_SAMPLES; k++) {
    picks.add(
      boundaries[Math.floor(((k + 0.5) * boundaries.length) / PTS_SAMPLES)]
    );
  }
  const sampled = Array.from(picks);
  const [base, ...actual] = await Promise.all([
    firstPts(segs[0].url),
    ...sampled.map((i) => firstPts(segs[i].url)),
  ]);
  if (base === null) return playlist;
  for (let k = 0; k < sampled.length; k++) {
    const got = actual[k];
    const expected = base + segs[sampled[k]].start;
    if (got === null || Math.abs(got - expected) > PTS_TOLERANCE) {
      return playlist;
    }
  }
  console.log(`隔空播放：去掉 ${boundaries.length} 个多余的分隔标记`);
  return lines.filter((l) => !l.startsWith('#EXT-X-DISCONTINUITY')).join('\n');
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('u') || '';
  const sig = request.nextUrl.searchParams.get('s') || '';

  if (!/^https?:\/\//i.test(url) || !(await verifyHlsUrl(url, sig))) {
    return NextResponse.json({ error: '签名无效' }, { status: 403 });
  }

  const fallback = () => NextResponse.redirect(url, 302);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': API_CONFIG.search.headers['User-Agent'] },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return fallback();
    const text = await res.text();
    if (!text.trimStart().startsWith('#EXTM3U')) return fallback();

    const base = res.url || url;
    const origin = request.nextUrl.origin;
    let output: string;

    if (text.includes('#EXT-X-STREAM-INF')) {
      // 主播放列表：子列表改为经过本接口（带签名）
      const lines = text.split(/\r?\n/);
      const proxied = async (uri: string) => {
        const abs = absolutize(uri, base);
        const path = await buildCleanPath(abs);
        return path ? `${origin}${path}` : abs;
      };
      const out: string[] = [];
      for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA') && line.includes('URI="')) {
          const m = line.match(/URI="([^"]+)"/);
          const target = m ? await proxied(m[1]) : '';
          out.push(m ? line.replace(m[0], `URI="${target}"`) : line);
        } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
          out.push(rewriteUriAttr(line, (u) => absolutize(u, base)));
        } else if (line.trim() && !line.startsWith('#')) {
          out.push(await proxied(line.trim()));
        } else {
          out.push(line);
        }
      }
      output = out.join('\n');
    } else {
      // 媒体播放列表：去广告后把切片、密钥、初始化分片改为绝对地址
      const filtered = filterAdsFromM3U8(text);
      const absolute = filtered
        .split(/\r?\n/)
        .map((line) => {
          if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
            return rewriteUriAttr(line, (u) => absolutize(u, base));
          }
          if (line.trim() && !line.startsWith('#')) {
            return absolutize(line.trim(), base);
          }
          return line;
        })
        .join('\n');
      output = await dropSpuriousDiscontinuities(absolute);
    }

    return new NextResponse(output, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (error) {
    console.error('隔空播放列表清理失败:', error);
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}
