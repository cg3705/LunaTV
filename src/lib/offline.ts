/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
'use client';

import Hls from 'hls.js';

import { filterAdsFromM3U8 } from '@/lib/m3u8AdFilter';
import { getVideoResolutionFromM3u8 } from '@/lib/utils';

/**
 * 离线下载（第一版：单集下载 + 离线播放）
 *
 * - 下载：取播放列表 → 用去广告规则删掉广告段 → 逐个下载切片（以及加密密钥、初始化分片）
 *   存进 IndexedDB；播放列表里的地址改写成 offline://<id>/<序号>。
 * - 播放：hls.js 使用 OfflineLoader，遇到 offline:// 地址时从 IndexedDB 读取。
 * - 页面离线可打开：由 /offline-sw.js 缓存 /offline 页面及其脚本。
 *
 * Safari 不支持后台下载，下载期间需要保持页面打开；中断后再次点击下载会从断点继续。
 */

const DB_NAME = 'mtv-offline';
const DB_VERSION = 1;
const STORE_VIDEOS = 'videos';
const STORE_PARTS = 'parts';
const CONCURRENCY = 4;
const RETRY = 3;

export interface OfflineVideo {
  id: string; // `${source}+${videoId}+${episodeIndex}`
  title: string;
  episodeIndex: number; // 从 0 开始
  episodeCount: number;
  sourceName: string;
  poster: string;
  sourceUrl: string; // 原始 m3u8 地址
  variantUrl?: string; // 选定的清晰度对应的子播放列表（主列表有多个清晰度时）
  quality?: string; // 如 1080p
  playlist: string; // 改写后的播放列表
  partCount: number; // 需要下载的文件数（切片 + 密钥 + 初始化分片）
  doneParts: number;
  bytes: number;
  duration: number; // 秒
  status: 'downloading' | 'paused' | 'done' | 'error';
  error?: string;
  createdAt: number;
  updatedAt: number;
  playTime?: number; // 上次看到的位置（秒）
}

export interface DownloadProgress {
  doneParts: number;
  partCount: number;
  bytes: number;
  speed: number; // 字节/秒（最近几秒的平均）
}

export interface DownloadOption {
  label: string; // 如 1080p
  variantUrl?: string;
  estBytes: number; // 预计大小
  bandwidth?: number;
}

// ---------------- IndexedDB ----------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
        db.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PARTS)) {
        db.createObjectStore(STORE_PARTS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

export async function listOfflineVideos(): Promise<OfflineVideo[]> {
  const s = await store(STORE_VIDEOS, 'readonly');
  const all = (await reqToPromise(s.getAll())) as OfflineVideo[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getOfflineVideo(
  id: string
): Promise<OfflineVideo | undefined> {
  const s = await store(STORE_VIDEOS, 'readonly');
  return (await reqToPromise(s.get(id))) as OfflineVideo | undefined;
}

async function putOfflineVideo(v: OfflineVideo) {
  const s = await store(STORE_VIDEOS, 'readwrite');
  await reqToPromise(s.put({ ...v, updatedAt: Date.now() }));
}

export async function saveOfflinePlayTime(id: string, playTime: number) {
  const v = await getOfflineVideo(id);
  if (v) await putOfflineVideo({ ...v, playTime });
}

const partKey = (id: string, index: number) => `${id}/${index}`;

async function getPart(
  id: string,
  index: number
): Promise<ArrayBuffer | undefined> {
  const s = await store(STORE_PARTS, 'readonly');
  const v = (await reqToPromise(s.get(partKey(id, index)))) as
    | ArrayBuffer
    | Blob
    | undefined;
  if (!v) return undefined;
  return v instanceof Blob ? await v.arrayBuffer() : v;
}

async function hasPart(id: string, index: number) {
  const s = await store(STORE_PARTS, 'readonly');
  const n = await reqToPromise(s.count(partKey(id, index)));
  return n > 0;
}

async function putPart(id: string, index: number, data: ArrayBuffer) {
  const s = await store(STORE_PARTS, 'readwrite');
  // 以 Blob 存储：Safari 会把它存成独立文件，删除时能真正释放空间
  // （存 ArrayBuffer 时数据写在数据库文件里，删除后文件不会缩小）
  await reqToPromise(s.put(new Blob([data]), partKey(id, index)));
}

export async function deleteOfflineVideo(id: string) {
  const db = await openDb();
  const tx = db.transaction([STORE_VIDEOS, STORE_PARTS], 'readwrite');
  tx.objectStore(STORE_VIDEOS).delete(id);
  // 键形如 `${id}/${n}`，'/' 后紧跟的字符都 < '\uffff'
  tx.objectStore(STORE_PARTS).delete(
    IDBKeyRange.bound(`${id}/`, `${id}/\uffff`)
  );
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 删除整个离线数据库（用于回收 Safari 未释放的空间） */
export async function wipeAllOffline() {
  running.forEach((c) => c.abort());
  const db = await dbPromise?.catch(() => null);
  db?.close();
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

export async function getStorageEstimate(): Promise<{
  usage: number;
  quota: number;
} | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e) return null;
    return { usage: e.usage || 0, quota: e.quota || 0 };
  } catch {
    return null;
  }
}

// ---------------- 下载 ----------------

export function offlineId(source: string, videoId: string, ep: number) {
  return `${source}+${videoId}+${ep}`;
}

async function fetchText(url: string): Promise<{ text: string; url: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`播放列表请求失败（${res.status}）`);
  return { text: await res.text(), url: res.url || url };
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  let lastErr: unknown = null;
  for (let i = 0; i < RETRY; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('下载失败');
}

const abs = (uri: string, base: string) => new URL(uri, base).href;
// 离线地址里的 id 需要编码，避免特殊字符被当成路径
const enc = (id: string) => encodeURIComponent(id);

/** 取媒体播放列表（主列表时选最高码率的子列表），并改写成离线地址 */
async function buildOfflinePlaylist(
  sourceUrl: string,
  id: string,
  variantUrl?: string
) {
  let { text, url } = await fetchText(variantUrl || sourceUrl);
  if (!text.trimStart().startsWith('#EXTM3U'))
    throw new Error('不是有效的播放列表');

  if (text.includes('#EXT-X-STREAM-INF')) {
    const lines = text.split(/\r?\n/);
    let best = { bw: -1, uri: '' };
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bw = parseInt(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1] || '0', 10);
        const uri = (lines[i + 1] || '').trim();
        if (uri && !uri.startsWith('#') && bw >= best.bw) best = { bw, uri };
      }
    }
    if (!best.uri) throw new Error('主播放列表里没有可用的子列表');
    ({ text, url } = await fetchText(abs(best.uri, url)));
  }

  // 与在线播放相同的去广告规则
  text = filterAdsFromM3U8(text);

  const parts: string[] = [];
  let duration = 0;
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m && !/METHOD=NONE/.test(line)) {
        parts.push(abs(m[1], url));
        out.push(
          line.replace(m[0], `URI="offline://${enc(id)}/${parts.length - 1}"`)
        );
      } else {
        out.push(line);
      }
    } else if (line.startsWith('#EXTINF:')) {
      duration += parseFloat(line.slice(8)) || 0;
      out.push(line);
    } else if (line.startsWith('#')) {
      out.push(line);
    } else {
      parts.push(abs(line, url));
      out.push(`offline://${enc(id)}/${parts.length - 1}`);
    }
  }
  if (!out.some((l) => l.startsWith('#EXT-X-ENDLIST')))
    out.push('#EXT-X-ENDLIST');
  return { playlist: out.join('\n'), parts, duration };
}

function parseVariants(text: string, base: string) {
  const lines = text.split(/\r?\n/);
  const out: {
    url: string;
    bandwidth: number;
    width: number;
    height: number;
  }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = (lines[i + 1] || '').trim();
    if (!uri || uri.startsWith('#')) continue;
    const bw = parseInt(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1] || '0', 10);
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    out.push({
      url: abs(uri, base),
      bandwidth: bw,
      width: res ? parseInt(res[1], 10) : 0,
      height: res ? parseInt(res[2], 10) : 0,
    });
  }
  return out;
}

const qualityLabel = (width: number, height = 0) => {
  const w = Math.max(width, Math.round((height * 16) / 9));
  if (!w) return '';
  return w >= 3840
    ? '4K'
    : w >= 2560
    ? '2K'
    : w >= 1920
    ? '1080p'
    : w >= 1280
    ? '720p'
    : w >= 854
    ? '480p'
    : 'SD';
};

async function mediaStats(mediaUrl: string) {
  const { text, url } = await fetchText(mediaUrl);
  const filtered = filterAdsFromM3U8(text);
  let duration = 0;
  let pending = 0;
  const segs: { url: string; dur: number }[] = [];
  for (const raw of filtered.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) pending = parseFloat(line.slice(8)) || 0;
    else if (line && !line.startsWith('#')) {
      duration += pending;
      segs.push({ url: abs(line, url), dur: pending });
    }
  }
  // 取中间位置的切片：开头常有低分辨率的片头/标识，不具代表性
  const mid = segs[Math.floor(segs.length / 2)];
  const encrypted = /#EXT-X-KEY:(?!.*METHOD=NONE)/.test(filtered);
  return {
    duration,
    sampleSeg: mid?.url || '',
    sampleDur: mid?.dur || 0,
    encrypted,
  };
}

/**
 * 分析一集可下载的清晰度和预计大小。
 * 主列表有多个清晰度时按 BANDWIDTH 估算；只有一个时下载首个切片来估算大小。
 */
export async function probeDownloadOptions(
  sourceUrl: string
): Promise<{ options: DownloadOption[]; duration: number }> {
  const { text, url } = await fetchText(sourceUrl);
  const variants = text.includes('#EXT-X-STREAM-INF')
    ? parseVariants(text, url)
    : [];

  if (variants.length > 1) {
    const { duration } = await mediaStats(variants[0].url);
    const options = variants
      .sort((a, b) => b.bandwidth - a.bandwidth)
      .map((v) => ({
        label:
          qualityLabel(v.width, v.height) ||
          `${Math.round(v.bandwidth / 1000)} kbps`,
        variantUrl: v.url,
        bandwidth: v.bandwidth,
        estBytes: (v.bandwidth / 8) * duration,
      }));
    return { options, duration };
  }

  const mediaUrl = variants[0]?.url || sourceUrl;
  const { duration, sampleSeg, sampleDur, encrypted } = await mediaStats(
    mediaUrl
  );
  let estBytes = 0;
  if (sampleSeg && sampleDur > 0) {
    try {
      const buf = await fetchBuffer(sampleSeg);
      estBytes = (buf.byteLength / sampleDur) * duration;
    } catch {
      estBytes = 0;
    }
  }
  // 只有一种清晰度时不信任主列表里声明的 RESOLUTION
  // （如意资源统一写成 1080x608，实际是 1920x1080），直接读视频本身
  let label = '';
  {
    // 用只含中间那个切片的临时播放列表来检测分辨率
    let probeUrl = mediaUrl;
    if (sampleSeg && !encrypted) {
      probeUrl = URL.createObjectURL(
        new Blob(
          [
            `#EXTM3U\n#EXT-X-TARGETDURATION:${
              Math.ceil(sampleDur) || 10
            }\n#EXTINF:${sampleDur},\n${sampleSeg}\n#EXT-X-ENDLIST\n`,
          ],
          { type: 'application/vnd.apple.mpegurl' }
        )
      );
    }
    try {
      const info = await getVideoResolutionFromM3u8(probeUrl);
      label = info.quality !== '未知' ? info.quality : '';
    } catch {
      label = '';
    } finally {
      if (probeUrl.startsWith('blob:')) URL.revokeObjectURL(probeUrl);
    }
  }
  return {
    options: [
      {
        label: label || '原画',
        variantUrl: variants[0]?.url,
        estBytes,
      },
    ],
    duration,
  };
}

const running = new Map<string, AbortController>();

export function isDownloading(id: string) {
  return running.has(id);
}

export function pauseDownload(id: string) {
  running.get(id)?.abort();
}

/**
 * 下载一集。已存在的文件会跳过，所以中断后再次调用即可续传。
 */
export async function downloadEpisode(
  meta: {
    source: string;
    videoId: string;
    episodeIndex: number;
    episodeCount: number;
    title: string;
    sourceName: string;
    poster: string;
    url: string;
    variantUrl?: string;
    quality?: string;
  },
  onProgress?: (p: DownloadProgress) => void
): Promise<OfflineVideo> {
  const id = offlineId(meta.source, meta.videoId, meta.episodeIndex);
  if (running.has(id)) throw new Error('这一集正在下载');
  const controller = new AbortController();
  running.set(id, controller);

  try {
    // 尽量申请持久存储，避免被系统清理
    try {
      await navigator.storage?.persist?.();
    } catch {
      // ignore
    }
    registerOfflineServiceWorker();

    const existing = await getOfflineVideo(id);
    const variantUrl = meta.variantUrl ?? existing?.variantUrl;
    const quality = meta.quality ?? existing?.quality;
    const { playlist, parts, duration } = await buildOfflinePlaylist(
      meta.url,
      id,
      variantUrl
    );
    let video: OfflineVideo = {
      id,
      title: meta.title,
      episodeIndex: meta.episodeIndex,
      episodeCount: meta.episodeCount,
      sourceName: meta.sourceName,
      poster: meta.poster,
      sourceUrl: meta.url,
      variantUrl,
      quality,
      playlist,
      partCount: parts.length,
      doneParts: 0,
      bytes: existing?.bytes || 0,
      duration,
      status: 'downloading',
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      playTime: existing?.playTime,
    };
    // 播放列表变了（换了切片）就从头下载
    if (existing && existing.playlist !== playlist) {
      await deleteOfflineVideo(id);
      video.bytes = 0;
    }
    await putOfflineVideo(video);

    // 统计已下载的部分
    const todo: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (await hasPart(id, i)) video.doneParts++;
      else todo.push(i);
    }
    // 下载速度：最近约 5 秒内下载的字节数
    const recent: { t: number; n: number }[] = [];
    const speed = () => {
      const now = Date.now();
      while (recent.length && now - recent[0].t > 5000) recent.shift();
      if (!recent.length) return 0;
      const total = recent.reduce((a, r) => a + r.n, 0);
      return total / Math.max(1, (now - recent[0].t) / 1000);
    };
    onProgress?.({
      doneParts: video.doneParts,
      partCount: parts.length,
      bytes: video.bytes,
      speed: 0,
    });

    let cursor = 0;
    let lastSave = Date.now();
    const worker = async () => {
      while (cursor < todo.length) {
        if (controller.signal.aborted) return;
        const i = todo[cursor++];
        const data = await fetchBuffer(parts[i]);
        if (controller.signal.aborted) return;
        await putPart(id, i, data);
        video.doneParts++;
        video.bytes += data.byteLength;
        recent.push({ t: Date.now(), n: data.byteLength });
        onProgress?.({
          doneParts: video.doneParts,
          partCount: parts.length,
          bytes: video.bytes,
          speed: speed(),
        });
        if (Date.now() - lastSave > 3000) {
          lastSave = Date.now();
          await putOfflineVideo(video);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    video = {
      ...video,
      status: controller.signal.aborted
        ? 'paused'
        : video.doneParts >= parts.length
        ? 'done'
        : 'paused',
    };
    await putOfflineVideo(video);
    return video;
  } catch (e) {
    const v = await getOfflineVideo(id);
    if (v) {
      await putOfflineVideo({
        ...v,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  } finally {
    running.delete(id);
  }
}

// ---------------- 离线播放 ----------------

/** hls.js 加载器：offline:// 地址从 IndexedDB 读取，其他地址走默认加载器 */
export function createOfflineLoader(): any {
  const Base = Hls.DefaultConfig.loader as any;
  return class OfflineLoader extends Base {
    load(context: any, config: any, callbacks: any) {
      const url: string = context.url || '';
      if (!url.startsWith('offline://')) {
        super.load(context, config, callbacks);
        return;
      }
      const stats: any = this.stats;
      stats.loading.start = performance.now();
      const rest = url.slice('offline://'.length);
      const slash = rest.lastIndexOf('/');
      const id = decodeURIComponent(rest.slice(0, slash));
      const tail = rest.slice(slash + 1);
      const done = (data: any, len: number) => {
        const now = performance.now();
        stats.loading.first = now;
        stats.loading.end = now;
        stats.loaded = len;
        stats.total = len;
        callbacks.onSuccess({ url, data }, stats, context, null);
      };
      const fail = (msg: string) =>
        callbacks.onError({ code: 404, text: msg }, context, null, stats);

      (async () => {
        if (tail === 'index.m3u8') {
          const v = await getOfflineVideo(id);
          if (!v) return fail('离线视频不存在');
          done(v.playlist, v.playlist.length);
          return;
        }
        const buf = await getPart(id, parseInt(tail, 10));
        if (!buf) return fail('离线文件缺失');
        done(buf, buf.byteLength);
      })().catch((e) => fail(String(e)));
    }
  };
}

export const offlinePlaylistUrl = (id: string) =>
  `offline://${encodeURIComponent(id)}/index.m3u8`;

// ---------------- Service Worker ----------------

let swRequested = false;

/** 注册离线用的 Service Worker，并缓存 /offline 页面（离线时也能打开） */
export function registerOfflineServiceWorker() {
  if (swRequested || typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  swRequested = true;
  navigator.serviceWorker
    .register('/offline-sw.js', { scope: '/' })
    .then(async (reg) => {
      const sw = reg.active || reg.waiting || reg.installing;
      const send = () =>
        (reg.active || sw)?.postMessage({ type: 'cache-offline-shell' });
      if (reg.active) send();
      else
        sw?.addEventListener('statechange', () => {
          if (reg.active) send();
        });
    })
    .catch((e) => console.warn('离线 Service Worker 注册失败:', e));
}

export function formatBytes(n: number) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}
