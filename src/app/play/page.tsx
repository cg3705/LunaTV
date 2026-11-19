/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { Download, Heart } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import {
  deleteFavorite,
  deletePlayRecord,
  deleteSkipConfig,
  generateStorageKey,
  getAllPlayRecords,
  getSkipConfig,
  isFavorited,
  saveFavorite,
  savePlayRecord,
  saveSkipConfig,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { filterAdsFromM3U8 } from '@/lib/m3u8AdFilter';
import {
  downloadEpisode,
  DownloadOption,
  formatBytes,
  getOfflineVideo,
  isDownloading,
  offlineId,
  pauseDownload,
  probeDownloadOptions,
} from '@/lib/offline';
import { SearchResult } from '@/lib/types';
import { getVideoResolutionFromM3u8, processImageUrl } from '@/lib/utils';

import EpisodeSelector from '@/components/EpisodeSelector';
import PageLayout from '@/components/PageLayout';

// 扩展 HTMLVideoElement 类型以支持 hls 属性
declare global {
  interface HTMLVideoElement {
    hls?: any;
    __airplayHandler?: () => void;
  }
}

// Wake Lock API 类型声明
interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

// ---------- 片名匹配（豆瓣片名 ↔ 采集站片名） ----------
const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const cnToNum = (s: string) => {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (CN_NUM[s[1]] || 0);
  if (s.endsWith('十')) return (CN_NUM[s[0]] || 0) * 10;
  if (s.includes('十')) return (CN_NUM[s[0]] || 0) * 10 + (CN_NUM[s[2]] || 0);
  return CN_NUM[s] || 0;
};
/** 拆出季数（没写季数视为第 1 季）和去掉季数后的片名 */
const splitSeason = (raw: string) => {
  let season = 1;
  const t = raw.replace(
    /第\s*([一二两三四五六七八九十\d]+)\s*[季部]|season\s*(\d+)|\bs(\d+)\b/gi,
    (_m, a, b, c) => {
      season = a ? cnToNum(a) : parseInt(b || c, 10) || 1;
      return '';
    }
  );
  return { base: t, season };
};
/** 归一化：全角转半角、去空格和标点、统一季数写法、去掉片尾等于年份的数字 */
const normalizeTitleForMatch = (title: string, year?: string) => {
  const half = (title || '').normalize('NFKC').toLowerCase();
  const split = splitSeason(half);
  let season = split.season;
  let t = split.base.replace(/[\s\p{P}\p{S}]+/gu, '');
  if (year) {
    const y = String(year).trim();
    if (t.length > y.length && t.endsWith(y)) t = t.slice(0, -y.length);
  }
  // "沙丘2"="沙丘 第二部"：片名末尾单个数字 2～9 视为季数/部数
  const tail = /\D([2-9])$/.exec(t);
  if (season === 1 && tail) {
    season = parseInt(tail[1], 10);
    t = t.slice(0, -1);
  }
  return { base: t, season, key: `${t}#s${season}` };
};
/** 片名相似度（字符二元组的 Dice 系数），用于候选排序 */
const titleSimilarity = (a: string, b: string) => {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let common = 0;
  ga.forEach((n, g) => (common += Math.min(n, gb.get(g) || 0)));
  const total = Math.max(1, a.length - 1 + b.length - 1);
  return (2 * common) / total;
};

interface TitleCandidate {
  title: string;
  year: string;
  episodes: number;
  first: SearchResult;
  sourceCount: number;
  score: number;
}

function PlayPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // -----------------------------------------------------------------------------
  // 状态变量（State）
  // -----------------------------------------------------------------------------
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState<
    'searching' | 'preferring' | 'fetching' | 'ready'
  >('searching');
  const [loadingMessage, setLoadingMessage] = useState('正在搜索播放源...');
  const [error, setError] = useState<string | null>(null);
  // 豆瓣片名在采集站里找不到同名资源时，给出的相近候选
  const [titleCandidates, setTitleCandidates] = useState<TitleCandidate[]>([]);
  const [detail, setDetail] = useState<SearchResult | null>(null);

  // 收藏状态
  const [favorited, setFavorited] = useState(false);

  // 跳过片头片尾配置
  const [skipConfig, setSkipConfig] = useState<{
    enable: boolean;
    intro_time: number;
    outro_time: number;
  }>({
    enable: false,
    intro_time: 0,
    outro_time: 0,
  });
  const skipConfigRef = useRef(skipConfig);
  useEffect(() => {
    skipConfigRef.current = skipConfig;
  }, [
    skipConfig,
    skipConfig.enable,
    skipConfig.intro_time,
    skipConfig.outro_time,
  ]);

  // 跳过检查的时间间隔控制
  const lastSkipCheckRef = useRef(0);

  // 去广告开关（从 localStorage 继承，默认 true）
  const [blockAdEnabled, setBlockAdEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_blockad');
      if (v !== null) return v === 'true';
    }
    return true;
  });
  const blockAdEnabledRef = useRef(blockAdEnabled);
  useEffect(() => {
    blockAdEnabledRef.current = blockAdEnabled;
  }, [blockAdEnabled]);

  // 视频基本信息
  const [videoTitle, setVideoTitle] = useState(searchParams.get('title') || '');
  const [videoYear, setVideoYear] = useState(searchParams.get('year') || '');
  const [videoCover, setVideoCover] = useState('');
  const [videoDoubanId, setVideoDoubanId] = useState(0);
  // 当前源和ID
  const [currentSource, setCurrentSource] = useState(
    searchParams.get('source') || ''
  );
  const [currentId, setCurrentId] = useState(searchParams.get('id') || '');

  // 搜索所需信息
  const [searchTitle] = useState(searchParams.get('stitle') || '');
  const [searchType] = useState(searchParams.get('stype') || '');

  // 是否需要优选
  const [needPrefer, setNeedPrefer] = useState(
    searchParams.get('prefer') === 'true'
  );
  const needPreferRef = useRef(needPrefer);
  useEffect(() => {
    needPreferRef.current = needPrefer;
  }, [needPrefer]);
  // 集数相关
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(0);

  const currentSourceRef = useRef(currentSource);
  const currentIdRef = useRef(currentId);
  const videoTitleRef = useRef(videoTitle);
  const videoYearRef = useRef(videoYear);
  const detailRef = useRef<SearchResult | null>(detail);
  const currentEpisodeIndexRef = useRef(currentEpisodeIndex);

  // 同步最新值到 refs
  useEffect(() => {
    currentSourceRef.current = currentSource;
    currentIdRef.current = currentId;
    detailRef.current = detail;
    currentEpisodeIndexRef.current = currentEpisodeIndex;
    videoTitleRef.current = videoTitle;
    videoYearRef.current = videoYear;
  }, [
    currentSource,
    currentId,
    detail,
    currentEpisodeIndex,
    videoTitle,
    videoYear,
  ]);

  // 视频播放地址
  const [videoUrl, setVideoUrl] = useState('');

  // 总集数
  const totalEpisodes = detail?.episodes?.length || 0;

  // 用于记录是否需要在播放器 ready 后跳转到指定进度
  const resumeTimeRef = useRef<number | null>(null);
  // 上次使用的音量，默认 0.7
  const lastVolumeRef = useRef<number>(0.7);
  // 上次使用的播放速率，默认 1.0
  const lastPlaybackRateRef = useRef<number>(1.0);

  // 换源相关状态
  const [availableSources, setAvailableSources] = useState<SearchResult[]>([]);
  const [sourceSearchLoading, setSourceSearchLoading] = useState(false);
  const [sourceSearchError, setSourceSearchError] = useState<string | null>(
    null
  );

  // 优选和测速开关
  const [optimizationEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('enableOptimization');
      if (saved !== null) {
        try {
          return JSON.parse(saved);
        } catch {
          /* ignore */
        }
      }
    }
    return true;
  });

  // 保存优选时的测速结果，避免EpisodeSelector重复测速
  const [precomputedVideoInfo, setPrecomputedVideoInfo] = useState<
    Map<string, { quality: string; loadSpeed: string; pingTime: number }>
  >(new Map());

  // 折叠状态（仅在 lg 及以上屏幕有效）
  const [isEpisodeSelectorCollapsed, setIsEpisodeSelectorCollapsed] =
    useState(false);

  // 换源加载状态
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [videoLoadingStage, setVideoLoadingStage] = useState<
    'initing' | 'sourceChanging'
  >('initing');

  // 播放进度保存相关
  const saveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSaveTimeRef = useRef<number>(0);

  const artPlayerRef = useRef<any>(null);
  // 自动连播时保持全屏：记录用户是否处于全屏（含 iOS 原生全屏、网页全屏）
  const keepFullscreenRef = useRef(false);
  // 定时暂停（睡眠定时）：0 = 关闭，>0 = 分钟数，-1 = 播完本集
  const sleepModeRef = useRef<number>(0);
  const sleepDeadlineRef = useRef<number>(0);
  const sleepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sleepWarnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 弹幕档位：off 关闭 / low 少量 / mid 适中 / full 满屏（按设备记住，默认关闭）
  const danmakuModeRef = useRef<string>(
    typeof window === 'undefined'
      ? 'off'
      : localStorage.getItem('danmaku_mode') ||
          (localStorage.getItem('enable_danmaku') === 'true' ? 'low' : 'off')
  );
  // 当前这一集的完整弹幕（切换档位时直接重新抽样，不用重新下载）
  const danmakuCacheRef = useRef<{ key: string; list: any[] } | null>(null);
  const danmakuLoadSeqRef = useRef(0);
  const danmakuScriptRef = useRef<Promise<any> | null>(null);
  const artRef = useRef<HTMLDivElement | null>(null);

  // Wake Lock 相关
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // -----------------------------------------------------------------------------
  // 工具函数（Utils）
  // -----------------------------------------------------------------------------

  // 播放源优选函数
  const preferBestSource = async (
    sources: SearchResult[]
  ): Promise<SearchResult> => {
    if (sources.length === 1) return sources[0];

    // 固定并发数测速，避免源数量多时同时创建大量 hls 实例拖垮设备
    const MAX_CONCURRENT_TEST = 4;
    const allResults: Array<{
      source: SearchResult;
      testResult: { quality: string; loadSpeed: string; pingTime: number };
    } | null> = new Array(sources.length).fill(null);

    const testOne = async (index: number) => {
      const source = sources[index];
      try {
        // 检查是否有第一集的播放地址
        if (!source.episodes || source.episodes.length === 0) {
          console.warn(`播放源 ${source.source_name} 没有可用的播放地址`);
          return;
        }

        const episodeUrl =
          source.episodes.length > 1 ? source.episodes[1] : source.episodes[0];
        const testResult = await getVideoResolutionFromM3u8(episodeUrl);

        allResults[index] = { source, testResult };
      } catch (error) {
        allResults[index] = null;
      }
    };

    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_TEST, sources.length) },
      async () => {
        while (cursor < sources.length) {
          const current = cursor++;
          await testOne(current);
        }
      }
    );
    await Promise.all(workers);

    // 等待所有测速完成，包含成功和失败的结果
    // 保存所有测速结果到 precomputedVideoInfo，供 EpisodeSelector 使用（包含错误结果）
    const newVideoInfoMap = new Map<
      string,
      {
        quality: string;
        loadSpeed: string;
        pingTime: number;
        hasError?: boolean;
      }
    >();
    allResults.forEach((result, index) => {
      const source = sources[index];
      const sourceKey = `${source.source}-${source.id}`;

      if (result) {
        // 成功的结果
        newVideoInfoMap.set(sourceKey, result.testResult);
      }
    });

    // 过滤出成功的结果用于优选计算
    const successfulResults = allResults.filter(Boolean) as Array<{
      source: SearchResult;
      testResult: { quality: string; loadSpeed: string; pingTime: number };
    }>;

    setPrecomputedVideoInfo(newVideoInfoMap);

    if (successfulResults.length === 0) {
      console.warn('所有播放源测速都失败，使用第一个播放源');
      return sources[0];
    }

    // 找出所有有效速度的最大值，用于线性映射
    const validSpeeds = successfulResults
      .map((result) => {
        const speedStr = result.testResult.loadSpeed;
        if (speedStr === '未知' || speedStr === '测量中...') return 0;

        const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
        if (!match) return 0;

        const value = parseFloat(match[1]);
        const unit = match[2];
        return unit === 'MB/s' ? value * 1024 : value; // 统一转换为 KB/s
      })
      .filter((speed) => speed > 0);

    const maxSpeed = validSpeeds.length > 0 ? Math.max(...validSpeeds) : 1024; // 默认1MB/s作为基准

    // 找出所有有效延迟的最小值和最大值，用于线性映射
    const validPings = successfulResults
      .map((result) => result.testResult.pingTime)
      .filter((ping) => ping > 0);

    const minPing = validPings.length > 0 ? Math.min(...validPings) : 50;
    const maxPing = validPings.length > 0 ? Math.max(...validPings) : 1000;

    // 计算每个结果的评分
    const resultsWithScore = successfulResults.map((result) => ({
      ...result,
      score: calculateSourceScore(
        result.testResult,
        maxSpeed,
        minPing,
        maxPing
      ),
    }));

    // 按综合评分排序，选择最佳播放源
    resultsWithScore.sort((a, b) => b.score - a.score);

    console.log('播放源评分排序结果:');
    resultsWithScore.forEach((result, index) => {
      console.log(
        `${index + 1}. ${result.source.source_name
        } - 评分: ${result.score.toFixed(2)} (${result.testResult.quality}, ${result.testResult.loadSpeed
        }, ${result.testResult.pingTime}ms)`
      );
    });

    return resultsWithScore[0].source;
  };

  // 计算播放源综合评分
  const calculateSourceScore = (
    testResult: {
      quality: string;
      loadSpeed: string;
      pingTime: number;
    },
    maxSpeed: number,
    minPing: number,
    maxPing: number
  ): number => {
    let score = 0;

    // 分辨率评分 (40% 权重)
    const qualityScore = (() => {
      switch (testResult.quality) {
        case '4K':
          return 100;
        case '2K':
          return 85;
        case '1080p':
          return 75;
        case '720p':
          return 60;
        case '480p':
          return 40;
        case 'SD':
          return 20;
        default:
          return 0;
      }
    })();
    score += qualityScore * 0.4;

    // 下载速度评分 (40% 权重) - 基于最大速度线性映射
    const speedScore = (() => {
      const speedStr = testResult.loadSpeed;
      if (speedStr === '未知' || speedStr === '测量中...') return 30;

      // 解析速度值
      const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
      if (!match) return 30;

      const value = parseFloat(match[1]);
      const unit = match[2];
      const speedKBps = unit === 'MB/s' ? value * 1024 : value;

      // 基于最大速度线性映射，最高100分
      const speedRatio = speedKBps / maxSpeed;
      return Math.min(100, Math.max(0, speedRatio * 100));
    })();
    score += speedScore * 0.4;

    // 网络延迟评分 (20% 权重) - 基于延迟范围线性映射
    const pingScore = (() => {
      const ping = testResult.pingTime;
      if (ping <= 0) return 0; // 无效延迟给默认分

      // 如果所有延迟都相同，给满分
      if (maxPing === minPing) return 100;

      // 线性映射：最低延迟=100分，最高延迟=0分
      const pingRatio = (maxPing - ping) / (maxPing - minPing);
      return Math.min(100, Math.max(0, pingRatio * 100));
    })();
    score += pingScore * 0.2;

    return Math.round(score * 100) / 100; // 保留两位小数
  };

  // 更新视频地址
  const updateVideoUrl = (
    detailData: SearchResult | null,
    episodeIndex: number
  ) => {
    if (
      !detailData ||
      !detailData.episodes ||
      episodeIndex >= detailData.episodes.length
    ) {
      setVideoUrl('');
      return;
    }
    const newUrl = detailData?.episodes[episodeIndex] || '';
    if (newUrl !== videoUrl) {
      setVideoUrl(newUrl);
    }
  };

  const ensureVideoSource = (video: HTMLVideoElement | null, url: string) => {
    if (!video || !url) return;
    // 只管理自己添加的备用 source（供 AirPlay 投送使用），不能动其它 source：
    // iPad/iPhone 上 hls.js 用 ManagedMediaSource，是通过一个 blob: 的 <source> 挂载视频流的，
    // 删掉它 Safari 会改用原始 m3u8 自己播放，去广告就失效了
    const ours = Array.from(
      video.querySelectorAll<HTMLSourceElement>('source[data-airplay]')
    );
    if (!ours.some((s) => s.src === url)) {
      ours.forEach((s) => s.remove());
      const sourceEl = document.createElement('source');
      sourceEl.src = url;
      sourceEl.type = 'application/x-mpegURL';
      sourceEl.setAttribute('data-airplay', '1');
      // 追加在最后：Safari 优先用排在前面的 hls.js 视频流，投送时才用这个备用地址
      video.appendChild(sourceEl);
    }

    // 始终允许远程播放（AirPlay / Cast）
    video.disableRemotePlayback = false;
    // 如果曾经有禁用属性，移除之
    if (video.hasAttribute('disableRemotePlayback')) {
      video.removeAttribute('disableRemotePlayback');
    }
  };

  // Wake Lock 相关函数
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request(
          'screen'
        );
        console.log('Wake Lock 已启用');
      }
    } catch (err) {
      console.warn('Wake Lock 请求失败:', err);
    }
  };

  const releaseWakeLock = async () => {
    try {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        console.log('Wake Lock 已释放');
      }
    } catch (err) {
      console.warn('Wake Lock 释放失败:', err);
    }
  };

  // 清理播放器资源的统一函数
  const isPlayerFullscreen = () => {
    const a = artPlayerRef.current;
    if (!a) return false;
    const v = a.video as any;
    return !!(a.fullscreen || a.fullscreenWeb || v?.webkitDisplayingFullscreen);
  };

  // 切集后恢复全屏。浏览器不允许无用户操作时进入真全屏，所以用网页全屏（铺满屏幕）代替
  const restoreFullscreen = () => {
    const a = artPlayerRef.current;
    if (!a || !keepFullscreenRef.current || isPlayerFullscreen()) return;
    try {
      a.fullscreenWeb = true;
    } catch (e) {
      console.warn('恢复网页全屏失败:', e);
    }
  };

  // ---------- 定时暂停 ----------
  const SLEEP_OPTIONS = [
    { label: '关闭', value: 0 },
    { label: '15 分钟', value: 15 },
    { label: '30 分钟', value: 30 },
    { label: '45 分钟', value: 45 },
    { label: '60 分钟', value: 60 },
    { label: '90 分钟', value: 90 },
    { label: '播完本集', value: -1 },
  ];

  const sleepLabel = () => {
    const v = sleepModeRef.current;
    if (v === 0) return '关闭';
    if (v === -1) return '播完本集';
    const left = Math.max(
      1,
      Math.ceil((sleepDeadlineRef.current - Date.now()) / 60000)
    );
    return `剩 ${left} 分钟`;
  };

  const clearSleepTimers = () => {
    if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current);
    if (sleepWarnTimerRef.current) clearTimeout(sleepWarnTimerRef.current);
    sleepTimerRef.current = null;
    sleepWarnTimerRef.current = null;
  };

  // 设置菜单里的"定时暂停"选项（新建播放器和状态变化时都用它，保证显示一致）
  const buildSleepSetting = () => ({
    name: '定时暂停',
    html: '定时暂停',
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg>',
    tooltip: sleepLabel(),
    selector: SLEEP_OPTIONS.map((o) => ({
      html: o.label,
      value: o.value,
      default: o.value === sleepModeRef.current,
    })),
    onSelect: function (item: any) {
      setSleepTimer(item.value);
      const a = artPlayerRef.current;
      if (a) {
        a.notice.show =
          item.value === 0
            ? '已关闭定时暂停'
            : item.value === -1
            ? '本集播完后将自动暂停'
            : `${item.value} 分钟后将自动暂停`;
      }
      return sleepLabel();
    },
  });

  const refreshSleepSetting = () => {
    try {
      artPlayerRef.current?.setting.update(buildSleepSetting());
    } catch (_) {
      // ignore
    }
  };

  const triggerSleepPause = (message: string) => {
    clearSleepTimers();
    sleepModeRef.current = 0;
    const a = artPlayerRef.current;
    if (a) {
      a.pause();
      a.notice.show = message;
    }
    releaseWakeLock();
    refreshSleepSetting();
  };

  const setSleepTimer = (value: number) => {
    clearSleepTimers();
    sleepModeRef.current = value;
    if (value > 0) {
      sleepDeadlineRef.current = Date.now() + value * 60000;
      sleepTimerRef.current = setTimeout(
        () => triggerSleepPause('定时结束，已自动暂停'),
        value * 60000
      );
      if (value > 1) {
        sleepWarnTimerRef.current = setTimeout(() => {
          if (artPlayerRef.current) {
            artPlayerRef.current.notice.show = '1 分钟后将自动暂停';
          }
        }, (value - 1) * 60000);
      }
    }
  };

  // ---------- 弹幕 ----------
  const DANMAKU_PLUGIN_URL =
    'https://cdn.jsdelivr.net/npm/artplayer-plugin-danmuku@5.1.8/dist/artplayer-plugin-danmuku.js';
  const isMobileDevice = () =>
    typeof navigator !== 'undefined' &&
    /Mobi|iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  // 弹幕插件只在打开弹幕时才从 CDN 加载
  const loadDanmakuPlugin = (): Promise<any> => {
    const w = window as any;
    if (w.artplayerPluginDanmuku) return Promise.resolve(w.artplayerPluginDanmuku);
    if (!danmakuScriptRef.current) {
      danmakuScriptRef.current = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = DANMAKU_PLUGIN_URL;
        script.async = true;
        script.onload = () =>
          w.artplayerPluginDanmuku
            ? resolve(w.artplayerPluginDanmuku)
            : reject(new Error('弹幕插件加载失败'));
        script.onerror = () => {
          danmakuScriptRef.current = null;
          reject(new Error('弹幕插件加载失败'));
        };
        document.head.appendChild(script);
      });
    }
    return danmakuScriptRef.current;
  };

  const DANMAKU_PRESETS: Record<
    string,
    { label: string; bottom: number | `${number}%`; mobile: number; desktop: number }
  > = {
    low: { label: '少量（顶部 1/4）', bottom: '75%', mobile: 600, desktop: 1500 },
    mid: { label: '适中（上半屏）', bottom: '50%', mobile: 1200, desktop: 3000 },
    full: { label: '满屏', bottom: 10, mobile: 3000, desktop: 8000 },
  };
  const DANMAKU_OPTIONS = [
    { value: 'off', label: '关闭' },
    { value: 'low', label: DANMAKU_PRESETS.low.label },
    { value: 'mid', label: DANMAKU_PRESETS.mid.label },
    { value: 'full', label: DANMAKU_PRESETS.full.label },
  ];
  const danmakuLabel = () =>
    DANMAKU_OPTIONS.find((o) => o.value === danmakuModeRef.current)?.label ||
    '关闭';

  // 按时间均匀抽样，控制弹幕密度
  const sampleDanmaku = (list: any[], max: number) => {
    if (list.length <= max) return list;
    const step = list.length / max;
    const sampled: any[] = [];
    for (let i = 0; i < max; i++) sampled.push(list[Math.floor(i * step)]);
    return sampled;
  };

  // 按"剧名 + 第几集"匹配并获取当前这一集的弹幕
  const fetchDanmakuList = async (): Promise<any[]> => {
    const year = String(videoYearRef.current || '').trim();
    let title = (videoTitleRef.current || '').trim();
    // 去掉部分源加在片名末尾的年份（如"美人余2026"）
    if (year && title.length > 4) {
      title = title.replace(new RegExp(`[（(【\\[]?${year}[）)】\\]]?$`), '').trim();
    }
    if (!title) return [];
    const total = detailRef.current?.episodes?.length || 1;
    const idx = currentEpisodeIndexRef.current;
    const fileName =
      total > 1 ? `${title} S01E${String(idx + 1).padStart(2, '0')}` : title;
    if (danmakuCacheRef.current?.key === fileName) {
      return danmakuCacheRef.current.list;
    }

    const match = await fetch(
      `/api/danmu?action=match&fileName=${encodeURIComponent(fileName)}`
    ).then((r) => r.json());
    const episodeId = match?.matches?.[0]?.episodeId;
    if (!episodeId) return [];

    const data = await fetch(`/api/danmu?action=comment&id=${episodeId}`).then(
      (r) => r.json()
    );
    const list = (data?.comments || [])
      .map((c: any) => {
        const [t, mode, color] = String(c.p || '').split(',');
        const m = Number(mode);
        const colorNum = Number(color);
        return {
          text: String(c.m || ''),
          time: parseFloat(t) || 0,
          // 弹弹play：1 滚动 / 4 底部 / 5 顶部；插件：0 滚动 / 1 顶部 / 2 底部
          mode: m === 5 ? 1 : m === 4 ? 2 : 0,
          color:
            '#' +
            (Number.isFinite(colorNum) && colorNum > 0 ? colorNum : 16777215)
              .toString(16)
              .padStart(6, '0'),
        };
      })
      .filter((d: any) => d.text)
      .sort((a: any, b: any) => a.time - b.time);
    danmakuCacheRef.current = { key: fileName, list };
    return list;
  };

  // 给当前播放器加载 / 刷新弹幕（切集、换源、新建播放器后都调用）
  const applyDanmaku = async () => {
    const art = artPlayerRef.current;
    if (!art) return;
    const seq = ++danmakuLoadSeqRef.current;
    const mode = danmakuModeRef.current;
    const preset = DANMAKU_PRESETS[mode];
    if (!preset) {
      art.plugins?.artplayerPluginDanmuku?.hide();
      return;
    }
    try {
      const [plugin, fullList] = await Promise.all([
        loadDanmakuPlugin(),
        fetchDanmakuList(),
      ]);
      // 期间切了集或改了档位，就丢弃这次结果
      if (
        seq !== danmakuLoadSeqRef.current ||
        artPlayerRef.current !== art ||
        danmakuModeRef.current !== mode
      ) {
        return;
      }
      const list = sampleDanmaku(
        fullList,
        isMobileDevice() ? preset.mobile : preset.desktop
      );
      const options = {
        speed: 7,
        opacity: 0.75,
        fontSize: isMobileDevice() ? 16 : 22,
        // 上边距 10px，下边距决定弹幕只显示在画面上方多大的区域
        margin: [10, preset.bottom] as [number, number | `${number}%`],
        antiOverlap: true,
        synchronousPlayback: true,
        emitter: false,
        heatmap: false,
      };
      const existing = art.plugins?.artplayerPluginDanmuku;
      if (existing) {
        existing.config({ ...options, danmuku: list });
        // 不带参数：先清空再按 config 里的新列表重新加载。
        // 带参数的 load(list) 是"追加"，切集/换档位后会让弹幕成倍重复
        await existing.load();
        existing.show();
      } else {
        art.plugins.add(plugin({ ...options, danmuku: list }));
      }
      art.notice.show = list.length
        ? `已加载 ${list.length} 条弹幕`
        : '没有找到这一集的弹幕';
    } catch (e) {
      console.warn('弹幕加载失败:', e);
      if (seq === danmakuLoadSeqRef.current && artPlayerRef.current === art) {
        art.notice.show = '弹幕加载失败';
      }
    }
  };

  const buildDanmakuSetting = () => ({
    name: '弹幕',
    html: '弹幕',
    tooltip: danmakuLabel(),
    selector: DANMAKU_OPTIONS.map((o) => ({
      html: o.label,
      value: o.value,
      default: o.value === danmakuModeRef.current,
    })),
    onSelect: function (item: any) {
      danmakuModeRef.current = item.value;
      try {
        localStorage.setItem('danmaku_mode', item.value);
      } catch (_) {
        // ignore
      }
      const a = artPlayerRef.current;
      if (item.value === 'off') {
        danmakuLoadSeqRef.current++;
        a?.plugins?.artplayerPluginDanmuku?.hide();
        if (a) a.notice.show = '已关闭弹幕';
      } else {
        if (a) a.notice.show = '正在加载弹幕…';
        applyDanmaku();
      }
      return item.html;
    },
    icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/><path d="M7 9h6M7 12h9" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/></svg>',
  });

  const cleanupPlayer = () => {
    if (artPlayerRef.current) {
      try {
        // 销毁 HLS 实例
        if (artPlayerRef.current.video && artPlayerRef.current.video.hls) {
          artPlayerRef.current.video.hls.destroy();
        }

        // 销毁 ArtPlayer 实例
        artPlayerRef.current.destroy();
        artPlayerRef.current = null;

        console.log('播放器资源已清理');
      } catch (err) {
        console.warn('清理播放器资源时出错:', err);
        artPlayerRef.current = null;
      }
    }
  };

  // 去广告规则见 @/lib/m3u8AdFilter（filterAdsFromM3U8）

  // 跳过片头片尾配置相关函数
  const handleSkipConfigChange = async (newConfig: {
    enable: boolean;
    intro_time: number;
    outro_time: number;
  }) => {
    if (!currentSourceRef.current || !currentIdRef.current) return;

    try {
      setSkipConfig(newConfig);
      if (!newConfig.enable && !newConfig.intro_time && !newConfig.outro_time) {
        await deleteSkipConfig(currentSourceRef.current, currentIdRef.current);
        artPlayerRef.current.setting.update({
          name: '跳过片头片尾',
          html: '跳过片头片尾',
          switch: skipConfigRef.current.enable,
          onSwitch: function (item: any) {
            const newConfig = {
              ...skipConfigRef.current,
              enable: !item.switch,
            };
            handleSkipConfigChange(newConfig);
            return !item.switch;
          },
        });
        artPlayerRef.current.setting.update({
          name: '设置片头',
          html: '设置片头',
          icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
          tooltip:
            skipConfigRef.current.intro_time === 0
              ? '设置片头时间'
              : `${formatTime(skipConfigRef.current.intro_time)}`,
          onClick: function () {
            const currentTime = artPlayerRef.current?.currentTime || 0;
            if (currentTime > 0) {
              const newConfig = {
                ...skipConfigRef.current,
                intro_time: currentTime,
              };
              handleSkipConfigChange(newConfig);
              return `${formatTime(currentTime)}`;
            }
          },
        });
        artPlayerRef.current.setting.update({
          name: '设置片尾',
          html: '设置片尾',
          icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
          tooltip:
            skipConfigRef.current.outro_time >= 0
              ? '设置片尾时间'
              : `-${formatTime(-skipConfigRef.current.outro_time)}`,
          onClick: function () {
            const outroTime =
              -(
                artPlayerRef.current?.duration -
                artPlayerRef.current?.currentTime
              ) || 0;
            if (outroTime < 0) {
              const newConfig = {
                ...skipConfigRef.current,
                outro_time: outroTime,
              };
              handleSkipConfigChange(newConfig);
              return `-${formatTime(-outroTime)}`;
            }
          },
        });
      } else {
        await saveSkipConfig(
          currentSourceRef.current,
          currentIdRef.current,
          newConfig
        );
      }
      console.log('跳过片头片尾配置已保存:', newConfig);
    } catch (err) {
      console.error('保存跳过片头片尾配置失败:', err);
    }
  };

  const formatTime = (seconds: number): string => {
    if (seconds === 0) return '00:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.round(seconds % 60);

    if (hours === 0) {
      // 不到一小时，格式为 00:00
      return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
        .toString()
        .padStart(2, '0')}`;
    } else {
      // 超过一小时，格式为 00:00:00
      return `${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
  };

  class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);
      this.load = function (context: any, config: any, callbacks: any) {
        // 拦截manifest和level请求
        if (
          (context as any).type === 'manifest' ||
          (context as any).type === 'level'
        ) {
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = function (
            response: any,
            stats: any,
            context: any
          ) {
            // 如果是m3u8文件，处理内容以移除广告分段
            if (response.data && typeof response.data === 'string') {
              // 过滤掉广告段 - 实现更精确的广告过滤逻辑
              response.data = filterAdsFromM3U8(response.data);
            }
            return onSuccess(response, stats, context, null);
          };
        }
        // 执行原始load方法
        load(context, config, callbacks);
      };
    }
  }

  // 当集数索引变化时自动更新视频地址
  useEffect(() => {
    updateVideoUrl(detail, currentEpisodeIndex);
  }, [detail, currentEpisodeIndex]);

  // 进入页面时直接获取全部源信息
  useEffect(() => {
    const fetchSourceDetail = async (
      source: string,
      id: string
    ): Promise<SearchResult[]> => {
      try {
        const detailResponse = await fetch(
          `/api/detail?source=${source}&id=${id}`
        );
        if (!detailResponse.ok) {
          throw new Error('获取视频详情失败');
        }
        const detailData = (await detailResponse.json()) as SearchResult;
        setAvailableSources([detailData]);
        return [detailData];
      } catch (err) {
        console.error('获取视频详情失败:', err);
        return [];
      } finally {
        setSourceSearchLoading(false);
      }
    };
    const fetchSourcesData = async (query: string): Promise<SearchResult[]> => {
      // 根据搜索词获取全部源信息
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query.trim())}`
        );
        if (!response.ok) {
          throw new Error('搜索失败');
        }
        const data = await response.json();

        // 片名归一化：全角半角、空格标点、季数写法（第二季/第2季/Season 2/S2）、
        // 片尾年份（如"美人余2026""美人余(2026)"）都统一后再比较
        const target = normalizeTitleForMatch(
          videoTitleRef.current,
          videoYearRef.current
        );
        const year = (videoYearRef.current || '').toLowerCase();
        const typeOk = (result: SearchResult) =>
          searchType
            ? (searchType === 'tv' && result.episodes.length > 1) ||
            (searchType === 'movie' && result.episodes.length === 1)
            : true;

        // 处理搜索结果，根据规则过滤
        const results = data.results.filter(
          (result: SearchResult) =>
            normalizeTitleForMatch(result.title, result.year).key ===
            target.key &&
            (year ? result.year.toLowerCase() === year : true) &&
            typeOk(result)
        );

        // 没有同名资源时（常见于译名不同，如"转生就是剑"↔"转生成为魔剑了"），
        // 列出同季数、年份相近、类型一致的结果让用户选择
        if (results.length === 0) {
          const groups = new Map<string, TitleCandidate>();
          data.results.forEach((result: SearchResult) => {
            const n = normalizeTitleForMatch(result.title, result.year);
            const y = parseInt(result.year, 10);
            const ty = parseInt(year, 10);
            if (n.season !== target.season) return;
            if (ty && y && Math.abs(y - ty) > 1) return;
            if (!typeOk(result)) return;
            const k = `${n.key}|${result.year}`;
            const existed = groups.get(k);
            if (existed) {
              existed.sourceCount++;
              existed.episodes = Math.max(existed.episodes, result.episodes.length);
            } else {
              groups.set(k, {
                title: result.title,
                year: result.year,
                episodes: result.episodes.length,
                first: result,
                sourceCount: 1,
                score: titleSimilarity(n.base, target.base),
              });
            }
          });
          setTitleCandidates(
            Array.from(groups.values())
              // 片名毫无相同字词的结果（搜索引擎凑数返回的）不列出
              .filter((c) => c.score > 0)
              .sort((a, b) => b.score - a.score)
              .slice(0, 8)
          );
        }
        setAvailableSources(results);
        return results;
      } catch (err) {
        setSourceSearchError(err instanceof Error ? err.message : '搜索失败');
        setAvailableSources([]);
        return [];
      } finally {
        setSourceSearchLoading(false);
      }
    };

    const initAll = async () => {
      if (!currentSource && !currentId && !videoTitle && !searchTitle) {
        setError('缺少必要参数');
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadingStage(currentSource && currentId ? 'fetching' : 'searching');
      setLoadingMessage(
        currentSource && currentId
          ? '🎬 正在获取视频详情...'
          : '🔍 正在搜索播放源...'
      );

      let sourcesInfo = await fetchSourcesData(searchTitle || videoTitle);
      if (
        currentSource &&
        currentId &&
        !sourcesInfo.some(
          (source) => source.source === currentSource && source.id === currentId
        )
      ) {
        sourcesInfo = await fetchSourceDetail(currentSource, currentId);
      }
      if (sourcesInfo.length === 0) {
        setError('未找到匹配结果');
        setLoading(false);
        return;
      }

      let detailData: SearchResult = sourcesInfo[0];
      // 指定源和id且无需优选
      if (currentSource && currentId && !needPreferRef.current) {
        const target = sourcesInfo.find(
          (source) => source.source === currentSource && source.id === currentId
        );
        if (target) {
          detailData = target;
        } else {
          setError('未找到匹配结果');
          setLoading(false);
          return;
        }
      }

      // 未指定源和 id 或需要优选，且开启优选开关
      if (
        (!currentSource || !currentId || needPreferRef.current) &&
        optimizationEnabled
      ) {
        setLoadingStage('preferring');
        setLoadingMessage('⚡ 正在优选最佳播放源...');

        detailData = await preferBestSource(sourcesInfo);
      }

      console.log(detailData.source, detailData.id);

      setNeedPrefer(false);
      setCurrentSource(detailData.source);
      setCurrentId(detailData.id);
      setVideoYear(detailData.year);
      setVideoTitle(detailData.title || videoTitleRef.current);
      setVideoCover(detailData.poster);
      setVideoDoubanId(detailData.douban_id || 0);
      setDetail(detailData);
      if (currentEpisodeIndex >= detailData.episodes.length) {
        setCurrentEpisodeIndex(0);
      }

      // 规范URL参数
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', detailData.source);
      newUrl.searchParams.set('id', detailData.id);
      newUrl.searchParams.set('year', detailData.year);
      newUrl.searchParams.set('title', detailData.title);
      newUrl.searchParams.delete('prefer');
      window.history.replaceState({}, '', newUrl.toString());

      setLoadingStage('ready');
      setLoadingMessage('✨ 准备就绪，即将开始播放...');

      // 短暂延迟让用户看到完成状态
      setTimeout(() => {
        setLoading(false);
      }, 1000);
    };

    initAll();
  }, []);

  // 播放记录处理
  useEffect(() => {
    // 仅在初次挂载时检查播放记录
    const initFromHistory = async () => {
      if (!currentSource || !currentId) return;

      try {
        const allRecords = await getAllPlayRecords();
        const key = generateStorageKey(currentSource, currentId);
        const record = allRecords[key];

        if (record) {
          const targetIndex = record.index - 1;
          const targetTime = record.play_time;

          // 更新当前选集索引
          if (targetIndex !== currentEpisodeIndex) {
            setCurrentEpisodeIndex(targetIndex);
          }

          // 保存待恢复的播放进度，待播放器就绪后跳转
          resumeTimeRef.current = targetTime;
        }
      } catch (err) {
        console.error('读取播放记录失败:', err);
      }
    };

    initFromHistory();
  }, []);

  // 跳过片头片尾配置处理
  useEffect(() => {
    // 仅在初次挂载时检查跳过片头片尾配置
    const initSkipConfig = async () => {
      if (!currentSource || !currentId) return;

      try {
        const config = await getSkipConfig(currentSource, currentId);
        if (config) {
          setSkipConfig(config);
        }
      } catch (err) {
        console.error('读取跳过片头片尾配置失败:', err);
      }
    };

    initSkipConfig();
  }, []);

  // 处理换源
  const handleSourceChange = async (
    newSource: string,
    newId: string,
    newTitle: string
  ) => {
    try {
      // 显示换源加载状态
      setVideoLoadingStage('sourceChanging');
      setIsVideoLoading(true);

      // 记录当前播放进度（仅在同一集数切换时恢复）
      const currentPlayTime = artPlayerRef.current?.currentTime || 0;
      console.log('换源前当前播放时间:', currentPlayTime);

      // 清除前一个历史记录
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deletePlayRecord(
            currentSourceRef.current,
            currentIdRef.current
          );
          console.log('已清除前一个播放记录');
        } catch (err) {
          console.error('清除播放记录失败:', err);
        }
      }

      // 清除并设置下一个跳过片头片尾配置
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deleteSkipConfig(
            currentSourceRef.current,
            currentIdRef.current
          );
          await saveSkipConfig(newSource, newId, skipConfigRef.current);
        } catch (err) {
          console.error('清除跳过片头片尾配置失败:', err);
        }
      }

      const newDetail = availableSources.find(
        (source) => source.source === newSource && source.id === newId
      );
      if (!newDetail) {
        setError('未找到匹配结果');
        return;
      }

      // 尝试跳转到当前正在播放的集数
      let targetIndex = currentEpisodeIndex;

      // 如果当前集数超出新源的范围，则跳转到第一集
      if (!newDetail.episodes || targetIndex >= newDetail.episodes.length) {
        targetIndex = 0;
      }

      // 如果仍然是同一集数且播放进度有效，则在播放器就绪后恢复到原始进度
      if (targetIndex !== currentEpisodeIndex) {
        resumeTimeRef.current = 0;
      } else if (
        (!resumeTimeRef.current || resumeTimeRef.current === 0) &&
        currentPlayTime > 1
      ) {
        resumeTimeRef.current = currentPlayTime;
      }

      // 更新URL参数（不刷新页面）
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', newSource);
      newUrl.searchParams.set('id', newId);
      newUrl.searchParams.set('year', newDetail.year);
      window.history.replaceState({}, '', newUrl.toString());

      setVideoTitle(newDetail.title || newTitle);
      setVideoYear(newDetail.year);
      setVideoCover(newDetail.poster);
      setVideoDoubanId(newDetail.douban_id || 0);
      setCurrentSource(newSource);
      setCurrentId(newId);
      setDetail(newDetail);
      setCurrentEpisodeIndex(targetIndex);
    } catch (err) {
      // 隐藏换源加载状态
      setIsVideoLoading(false);
      setError(err instanceof Error ? err.message : '换源失败');
    }
  };

  useEffect(() => {
    document.addEventListener('keydown', handleKeyboardShortcuts);
    return () => {
      document.removeEventListener('keydown', handleKeyboardShortcuts);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 集数切换
  // ---------------------------------------------------------------------------
  // 处理集数切换
  const handleEpisodeChange = (episodeNumber: number) => {
    if (episodeNumber >= 0 && episodeNumber < totalEpisodes) {
      // 在更换集数前保存当前播放进度
      if (artPlayerRef.current && artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      setCurrentEpisodeIndex(episodeNumber);
    }
  };

  const handlePreviousEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx > 0) {
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      setCurrentEpisodeIndex(idx - 1);
    }
  };

  const handleNextEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx < d.episodes.length - 1) {
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        saveCurrentPlayProgress();
      }
      setCurrentEpisodeIndex(idx + 1);
    }
  };

  // ---------------------------------------------------------------------------
  // 键盘快捷键
  // ---------------------------------------------------------------------------
  // 处理全局快捷键
  const handleKeyboardShortcuts = (e: KeyboardEvent) => {
    // 忽略输入框中的按键事件
    if (
      (e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'TEXTAREA'
    )
      return;

    // Alt + 左箭头 = 上一集
    if (e.altKey && e.key === 'ArrowLeft') {
      if (detailRef.current && currentEpisodeIndexRef.current > 0) {
        handlePreviousEpisode();
        e.preventDefault();
      }
    }

    // Alt + 右箭头 = 下一集
    if (e.altKey && e.key === 'ArrowRight') {
      const d = detailRef.current;
      const idx = currentEpisodeIndexRef.current;
      if (d && idx < d.episodes.length - 1) {
        handleNextEpisode();
        e.preventDefault();
      }
    }

    // 左箭头 = 快退
    if (!e.altKey && e.key === 'ArrowLeft') {
      if (artPlayerRef.current && artPlayerRef.current.currentTime > 5) {
        artPlayerRef.current.currentTime -= 10;
        e.preventDefault();
      }
    }

    // 右箭头 = 快进
    if (!e.altKey && e.key === 'ArrowRight') {
      if (
        artPlayerRef.current &&
        artPlayerRef.current.currentTime < artPlayerRef.current.duration - 5
      ) {
        artPlayerRef.current.currentTime += 10;
        e.preventDefault();
      }
    }

    // 上箭头 = 音量+
    if (e.key === 'ArrowUp') {
      if (artPlayerRef.current && artPlayerRef.current.volume < 1) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume + 0.1) * 10) / 10;
        artPlayerRef.current.notice.show = `音量: ${Math.round(
          artPlayerRef.current.volume * 100
        )}`;
        e.preventDefault();
      }
    }

    // 下箭头 = 音量-
    if (e.key === 'ArrowDown') {
      if (artPlayerRef.current && artPlayerRef.current.volume > 0) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume - 0.1) * 10) / 10;
        artPlayerRef.current.notice.show = `音量: ${Math.round(
          artPlayerRef.current.volume * 100
        )}`;
        e.preventDefault();
      }
    }

    // 空格 = 播放/暂停
    if (e.key === ' ') {
      if (artPlayerRef.current) {
        artPlayerRef.current.toggle();
        e.preventDefault();
      }
    }

    // f 键 = 切换全屏
    if (e.key === 'f' || e.key === 'F') {
      if (artPlayerRef.current) {
        artPlayerRef.current.fullscreen = !artPlayerRef.current.fullscreen;
        e.preventDefault();
      }
    }
  };

  // ---------------------------------------------------------------------------
  // 播放记录相关
  // ---------------------------------------------------------------------------
  // 保存播放进度
  const saveCurrentPlayProgress = async () => {
    if (
      !artPlayerRef.current ||
      !currentSourceRef.current ||
      !currentIdRef.current ||
      !videoTitleRef.current ||
      !detailRef.current?.source_name
    ) {
      return;
    }

    const player = artPlayerRef.current;
    const currentTime = player.currentTime || 0;
    const duration = player.duration || 0;

    // 如果播放时间太短（少于5秒）或者视频时长无效，不保存
    if (currentTime < 1 || !duration) {
      return;
    }

    try {
      await savePlayRecord(currentSourceRef.current, currentIdRef.current, {
        title: videoTitleRef.current,
        source_name: detailRef.current?.source_name || '',
        year: detailRef.current?.year,
        cover: detailRef.current?.poster || '',
        index: currentEpisodeIndexRef.current + 1, // 转换为1基索引
        total_episodes: detailRef.current?.episodes.length || 1,
        play_time: Math.floor(currentTime),
        total_time: Math.floor(duration),
        save_time: Date.now(),
        search_title: searchTitle,
      });

      lastSaveTimeRef.current = Date.now();
      console.log('播放进度已保存:', {
        title: videoTitleRef.current,
        episode: currentEpisodeIndexRef.current + 1,
        year: detailRef.current?.year,
        progress: `${Math.floor(currentTime)}/${Math.floor(duration)}`,
      });
    } catch (err) {
      console.error('保存播放进度失败:', err);
    }
  };

  // 离开播放页时清理定时暂停的计时器
  useEffect(() => {
    return () => clearSleepTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // 页面即将卸载时保存播放进度和清理资源
    const handleBeforeUnload = () => {
      saveCurrentPlayProgress();
      releaseWakeLock();
      cleanupPlayer();
    };

    // 页面可见性变化时保存播放进度和释放 Wake Lock
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentPlayProgress();
        releaseWakeLock();
      } else if (document.visibilityState === 'visible') {
        // 页面重新可见时，如果正在播放则重新请求 Wake Lock
        if (artPlayerRef.current && !artPlayerRef.current.paused) {
          requestWakeLock();
        }
      }
    };

    // 添加事件监听器
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      // 清理事件监听器
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentEpisodeIndex, detail, artPlayerRef.current]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 收藏相关
  // ---------------------------------------------------------------------------
  // 每当 source 或 id 变化时检查收藏状态
  useEffect(() => {
    if (!currentSource || !currentId) return;
    (async () => {
      try {
        const fav = await isFavorited(currentSource, currentId);
        setFavorited(fav);
      } catch (err) {
        console.error('检查收藏状态失败:', err);
      }
    })();
  }, [currentSource, currentId]);

  // 监听收藏数据更新事件
  useEffect(() => {
    if (!currentSource || !currentId) return;

    const unsubscribe = subscribeToDataUpdates(
      'favoritesUpdated',
      (favorites: Record<string, any>) => {
        const key = generateStorageKey(currentSource, currentId);
        const isFav = !!favorites[key];
        setFavorited(isFav);
      }
    );

    return unsubscribe;
  }, [currentSource, currentId]);

  // 切换收藏
  // ---------- 离线下载（本集） ----------
  const [offlineState, setOfflineState] = useState<{
    status: 'none' | 'downloading' | 'paused' | 'done' | 'error';
    pct: number;
    speed?: number;
  }>({ status: 'none', pct: 0 });
  // 下载前选择清晰度的弹窗
  const [downloadDialog, setDownloadDialog] = useState<{
    loading: boolean;
    options: DownloadOption[];
    error?: string;
  } | null>(null);
  const offlineTargetRef = useRef('');

  useEffect(() => {
    if (!currentSource || !currentId) return;
    const id = offlineId(currentSource, currentId, currentEpisodeIndex);
    offlineTargetRef.current = id;
    if (isDownloading(id)) return;
    let cancelled = false;
    getOfflineVideo(id)
      .then((v) => {
        if (cancelled) return;
        if (!v) return setOfflineState({ status: 'none', pct: 0 });
        const pct = v.partCount
          ? Math.floor((v.doneParts / v.partCount) * 100)
          : 0;
        setOfflineState({
          status:
            v.status === 'done'
              ? 'done'
              : v.status === 'error'
                ? 'error'
                : 'paused',
          pct,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentSource, currentId, currentEpisodeIndex]);

  const handleDownload = async () => {
    const url = detailRef.current?.episodes?.[currentEpisodeIndex];
    if (!url || !currentSource || !currentId) return;
    const id = offlineId(currentSource, currentId, currentEpisodeIndex);
    if (isDownloading(id)) {
      pauseDownload(id);
      return;
    }
    if (offlineState.status === 'done') {
      router.push('/offline');
      return;
    }
    // 继续下载沿用上次选的清晰度；新下载先分析清晰度和大小让用户选
    if (offlineState.status === 'paused' || offlineState.status === 'error') {
      startDownload();
      return;
    }
    setDownloadDialog({ loading: true, options: [] });
    try {
      const { options } = await probeDownloadOptions(url);
      setDownloadDialog({ loading: false, options });
    } catch (e) {
      setDownloadDialog({
        loading: false,
        options: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const startDownload = async (option?: DownloadOption) => {
    setDownloadDialog(null);
    const url = detailRef.current?.episodes?.[currentEpisodeIndex];
    if (!url || !currentSource || !currentId) return;
    const id = offlineId(currentSource, currentId, currentEpisodeIndex);
    if (isDownloading(id)) return;
    let lock: any = null;
    try {
      // 下载期间保持屏幕常亮（Safari 锁屏后会暂停下载）
      lock = await (navigator as any).wakeLock?.request('screen');
    } catch {
      // ignore
    }
    setOfflineState({ status: 'downloading', pct: 0 });
    try {
      const v = await downloadEpisode(
        {
          source: currentSource,
          videoId: currentId,
          episodeIndex: currentEpisodeIndex,
          episodeCount: detailRef.current?.episodes?.length || 1,
          title: videoTitleRef.current || videoTitle,
          sourceName: detailRef.current?.source_name || '',
          poster: videoCover,
          url,
          variantUrl: option?.variantUrl,
          quality: option?.label,
        },
        (p) => {
          if (offlineTargetRef.current !== id) return;
          setOfflineState({
            status: 'downloading',
            pct: p.partCount ? Math.floor((p.doneParts / p.partCount) * 100) : 0,
            speed: p.speed,
          });
        }
      );
      if (offlineTargetRef.current === id) {
        setOfflineState({
          status: v.status === 'done' ? 'done' : 'paused',
          pct: v.partCount ? Math.floor((v.doneParts / v.partCount) * 100) : 0,
        });
      }
    } catch (e) {
      console.error('离线下载失败:', e);
      if (offlineTargetRef.current === id) {
        setOfflineState({ status: 'error', pct: 0 });
      }
    } finally {
      lock?.release?.().catch(() => undefined);
    }
  };

  const handleToggleFavorite = async () => {
    if (
      !videoTitleRef.current ||
      !detailRef.current ||
      !currentSourceRef.current ||
      !currentIdRef.current
    )
      return;

    try {
      if (favorited) {
        // 如果已收藏，删除收藏
        await deleteFavorite(currentSourceRef.current, currentIdRef.current);
        setFavorited(false);
      } else {
        // 如果未收藏，添加收藏
        await saveFavorite(currentSourceRef.current, currentIdRef.current, {
          title: videoTitleRef.current,
          source_name: detailRef.current?.source_name || '',
          year: detailRef.current?.year,
          cover: detailRef.current?.poster || '',
          total_episodes: detailRef.current?.episodes.length || 1,
          save_time: Date.now(),
          search_title: searchTitle,
        });
        setFavorited(true);
      }
    } catch (err) {
      console.error('切换收藏失败:', err);
    }
  };

  useEffect(() => {
    if (
      !Artplayer ||
      !Hls ||
      !videoUrl ||
      loading ||
      currentEpisodeIndex === null ||
      !artRef.current
    ) {
      return;
    }

    // 确保选集索引有效
    if (
      !detail ||
      !detail.episodes ||
      currentEpisodeIndex >= detail.episodes.length ||
      currentEpisodeIndex < 0
    ) {
      setError(`选集索引无效，当前共 ${totalEpisodes} 集`);
      return;
    }

    if (!videoUrl) {
      setError('视频地址无效');
      return;
    }
    console.log(videoUrl);

    // 检测是否为WebKit浏览器
    const isWebkit =
      typeof window !== 'undefined' &&
      typeof (window as any).webkitConvertPointFromNodeToPage === 'function';

    // 切集前记下是否处于全屏（销毁旧播放器时会触发退出全屏事件，所以要提前记录）
    const wantFullscreen = keepFullscreenRef.current || isPlayerFullscreen();

    // 非WebKit浏览器且播放器已存在，使用switch方法切换；
    // WebKit（Safari）在全屏时也复用播放器，避免销毁重建导致退出全屏
    if ((!isWebkit || wantFullscreen) && artPlayerRef.current) {
      artPlayerRef.current.switch = videoUrl;
      // 切集后刷新弹幕
      if (danmakuModeRef.current !== 'off') setTimeout(applyDanmaku, 500);
      if (wantFullscreen) {
        keepFullscreenRef.current = true;
        setTimeout(restoreFullscreen, 800);
      }
      artPlayerRef.current.title = `${videoTitle} - 第${currentEpisodeIndex + 1
        }集`;
      artPlayerRef.current.poster = videoCover;
      if (artPlayerRef.current?.video) {
        ensureVideoSource(
          artPlayerRef.current.video as HTMLVideoElement,
          videoUrl
        );
      }
      return;
    }

    // WebKit浏览器或首次创建：销毁之前的播放器实例并创建新的
    if (artPlayerRef.current) {
      cleanupPlayer();
    }

    try {
      // 创建新的播放器实例
      Artplayer.PLAYBACK_RATE = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
      Artplayer.USE_RAF = false;
      Artplayer.FULLSCREEN_WEB_IN_BODY = true;

      keepFullscreenRef.current = wantFullscreen;
      artPlayerRef.current = new Artplayer({
        container: artRef.current,
        url: videoUrl,
        poster: videoCover,
        volume: 0.7,
        isLive: false,
        muted: false,
        autoplay: true,
        pip: true,
        autoSize: false,
        autoMini: false,
        screenshot: false,
        setting: true,
        loop: false,
        flip: false,
        playbackRate: true,
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        subtitleOffset: false,
        miniProgressBar: false,
        mutex: true,
        playsInline: true,
        autoPlayback: false,
        airplay: true,
        theme: '#22c55e',
        lang: 'zh-cn',
        hotkey: false,
        fastForward: true,
        autoOrientation: true,
        lock: true,
        moreVideoAttr: {
          crossOrigin: 'anonymous',
        },
        // HLS 支持配置
        customType: {
          m3u8: function (video: HTMLVideoElement, url: string) {
            if (!Hls) {
              console.error('HLS.js 未加载');
              return;
            }

            if (video.hls) {
              video.hls.destroy();
            }
            if (video.__airplayHandler) {
              video.removeEventListener(
                'webkitcurrentplaybacktargetiswirelesschanged',
                video.__airplayHandler
              );
              video.__airplayHandler = undefined;
            }
            const hls = new Hls({
              debug: false, // 关闭日志
              enableWorker: true, // WebWorker 解码，降低主线程压力
              lowLatencyMode: false, // 点播无需低延迟，关闭后缓冲更充足，弱网下不易卡顿

              /* 缓冲/内存相关 */
              maxBufferLength: 60, // 前向缓冲最大 60s，出网带宽小的源可提前缓冲，减少卡顿
              maxMaxBufferLength: 120, // 网络较差时允许缓冲区扩大到 120s
              backBufferLength: 30, // 仅保留 30s 已播放内容，避免内存占用
              maxBufferSize: 100 * 1000 * 1000, // 约 100MB，超出后触发清理

              /* 自定义loader */
              loader: blockAdEnabledRef.current
                ? CustomHlsJsLoader
                : Hls.DefaultConfig.loader,
            });

            hls.loadSource(url);
            hls.attachMedia(video);
            video.hls = hls;

            ensureVideoSource(video, url);

            // 去广告开启时，隔空播放用的备用地址换成服务器端清理过的播放列表，
            // 电视播放时同样去掉广告分段和多余的分隔标记（失败则保留原始地址）
            if (blockAdEnabledRef.current && /^https?:\/\//i.test(url)) {
              fetch(`/api/sign-hls?u=${encodeURIComponent(url)}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((data) => {
                  if (data?.url && video.hls === hls) {
                    ensureVideoSource(
                      video,
                      new URL(data.url, window.location.origin).href
                    );
                  }
                })
                .catch(() => undefined);
            }

            // 隔空播放（AirPlay 投送）期间由电视直接播放原始地址，
            // hls.js 停止加载、不做错误恢复，避免 iPad 锁屏/合盖后
            // hls.js 恢复时重新接管视频，导致投送会话被中断
            const isWireless = () =>
              Boolean((video as any).webkitCurrentPlaybackTargetIsWireless);
            const onAirplayChange = () => {
              if (video.hls !== hls) return;
              if (isWireless()) {
                console.log('隔空播放开始：hls.js 停止加载');
                hls.stopLoad();
              } else {
                console.log('隔空播放结束：hls.js 从当前进度恢复加载');
                hls.startLoad(video.currentTime);
              }
            };
            video.__airplayHandler = onAirplayChange;
            video.addEventListener(
              'webkitcurrentplaybacktargetiswirelesschanged',
              onAirplayChange
            );

            hls.on(Hls.Events.ERROR, function (event: any, data: any) {
              console.error('HLS Error:', event, data);
              if (isWireless()) {
                console.log('隔空播放中，忽略 HLS 错误恢复');
                return;
              }
              if (data.fatal) {
                switch (data.type) {
                  case Hls.ErrorTypes.NETWORK_ERROR:
                    console.log('网络错误，尝试恢复...');
                    hls.startLoad();
                    break;
                  case Hls.ErrorTypes.MEDIA_ERROR:
                    console.log('媒体错误，尝试恢复...');
                    hls.recoverMediaError();
                    break;
                  default:
                    console.log('无法恢复的错误');
                    hls.destroy();
                    break;
                }
              }
            });
          },
        },
        icons: {
          loading:
            '<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDUwIDUwIj48cGF0aCBkPSJNMjUuMjUxIDYuNDYxYy0xMC4zMTggMC0xOC42ODMgOC4zNjUtMTguNjgzIDE4LjY4M2g0LjA2OGMwLTguMDcgNi41NDUtMTQuNjE1IDE0LjYxNS0xNC42MTVWNi40NjF6IiBmaWxsPSIjMDA5Njg4Ij48YW5pbWF0ZVRyYW5zZm9ybSBhdHRyaWJ1dGVOYW1lPSJ0cmFuc2Zvcm0iIGF0dHJpYnV0ZVR5cGU9IlhNTCIgZHVyPSIxcyIgZnJvbT0iMCAyNSAyNSIgcmVwZWF0Q291bnQ9ImluZGVmaW5pdGUiIHRvPSIzNjAgMjUgMjUiIHR5cGU9InJvdGF0ZSIvPjwvcGF0aD48L3N2Zz4=">',
        },
        settings: [
          {
            html: '去广告',
            icon: '<text x="50%" y="50%" font-size="20" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#ffffff">AD</text>',
            tooltip: blockAdEnabled ? '已开启' : '已关闭',
            onClick() {
              const newVal = !blockAdEnabled;
              try {
                localStorage.setItem('enable_blockad', String(newVal));
                if (artPlayerRef.current) {
                  resumeTimeRef.current = artPlayerRef.current.currentTime;
                  if (
                    artPlayerRef.current.video &&
                    artPlayerRef.current.video.hls
                  ) {
                    artPlayerRef.current.video.hls.destroy();
                  }
                  artPlayerRef.current.destroy();
                  artPlayerRef.current = null;
                }
                setBlockAdEnabled(newVal);
              } catch (_) {
                // ignore
              }
              return newVal ? '当前开启' : '当前关闭';
            },
          },
          buildSleepSetting(),
          buildDanmakuSetting(),
          {
            name: '跳过片头片尾',
            html: '跳过片头片尾',
            switch: skipConfigRef.current.enable,
            onSwitch: function (item) {
              const newConfig = {
                ...skipConfigRef.current,
                enable: !item.switch,
              };
              handleSkipConfigChange(newConfig);
              return !item.switch;
            },
          },
          {
            html: '删除跳过配置',
            onClick: function () {
              handleSkipConfigChange({
                enable: false,
                intro_time: 0,
                outro_time: 0,
              });
              return '';
            },
          },
          {
            name: '设置片头',
            html: '设置片头',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
            tooltip:
              skipConfigRef.current.intro_time === 0
                ? '设置片头时间'
                : `${formatTime(skipConfigRef.current.intro_time)}`,
            onClick: function () {
              const currentTime = artPlayerRef.current?.currentTime || 0;
              if (currentTime > 0) {
                const newConfig = {
                  ...skipConfigRef.current,
                  intro_time: currentTime,
                };
                handleSkipConfigChange(newConfig);
                return `${formatTime(currentTime)}`;
              }
            },
          },
          {
            name: '设置片尾',
            html: '设置片尾',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
            tooltip:
              skipConfigRef.current.outro_time >= 0
                ? '设置片尾时间'
                : `-${formatTime(-skipConfigRef.current.outro_time)}`,
            onClick: function () {
              const outroTime =
                -(
                  artPlayerRef.current?.duration -
                  artPlayerRef.current?.currentTime
                ) || 0;
              if (outroTime < 0) {
                const newConfig = {
                  ...skipConfigRef.current,
                  outro_time: outroTime,
                };
                handleSkipConfigChange(newConfig);
                return `-${formatTime(-outroTime)}`;
              }
            },
          },
        ],
        // 控制栏配置
        controls: [
          {
            position: 'left',
            index: 13,
            html: '<i class="art-icon flex"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" fill="currentColor"/></svg></i>',
            tooltip: '播放下一集',
            click: function () {
              handleNextEpisode();
            },
          },
        ],
      });

      // 监听播放器事件
      artPlayerRef.current.on('ready', () => {
        if (danmakuModeRef.current !== 'off') applyDanmaku();
        setError(null);
        restoreFullscreen();

        // 播放器就绪后，如果正在播放则请求 Wake Lock
        if (artPlayerRef.current && !artPlayerRef.current.paused) {
          requestWakeLock();
        }
      });

      // 跟踪全屏状态，用于自动连播时保持全屏
      artPlayerRef.current.on('fullscreen', (state: boolean) => {
        keepFullscreenRef.current =
          state || !!artPlayerRef.current?.fullscreenWeb;
      });
      artPlayerRef.current.on('fullscreenWeb', (state: boolean) => {
        keepFullscreenRef.current = state || !!artPlayerRef.current?.fullscreen;
      });
      {
        const vEl = artPlayerRef.current.video as HTMLVideoElement;
        vEl.addEventListener('webkitbeginfullscreen', () => {
          keepFullscreenRef.current = true;
        });
        vEl.addEventListener('webkitendfullscreen', () => {
          // iOS 在一集播完时会自动退出原生全屏，这种情况保留"全屏意图"
          const nearEnd =
            vEl.ended ||
            (vEl.duration > 0 && vEl.currentTime >= vEl.duration - 1);
          if (!nearEnd) keepFullscreenRef.current = false;
        });
      }

      // 监听播放状态变化，控制 Wake Lock
      artPlayerRef.current.on('play', () => {
        requestWakeLock();
      });

      artPlayerRef.current.on('pause', () => {
        releaseWakeLock();
        saveCurrentPlayProgress();
      });

      // 如果播放器初始化时已经在播放状态，则请求 Wake Lock
      if (artPlayerRef.current && !artPlayerRef.current.paused) {
        requestWakeLock();
      }

      artPlayerRef.current.on('video:volumechange', () => {
        lastVolumeRef.current = artPlayerRef.current.volume;
      });
      artPlayerRef.current.on('video:ratechange', () => {
        lastPlaybackRateRef.current = artPlayerRef.current.playbackRate;
      });

      // 监听视频可播放事件，这时恢复播放进度更可靠
      artPlayerRef.current.on('video:canplay', () => {
        // 若存在需要恢复的播放进度，则跳转
        if (resumeTimeRef.current && resumeTimeRef.current > 0) {
          try {
            const duration = artPlayerRef.current.duration || 0;
            let target = resumeTimeRef.current;
            if (duration && target >= duration - 2) {
              target = Math.max(0, duration - 5);
            }
            artPlayerRef.current.currentTime = target;
            console.log('成功恢复播放进度到:', resumeTimeRef.current);
          } catch (err) {
            console.warn('恢复播放进度失败:', err);
          }
        }
        resumeTimeRef.current = null;

        setTimeout(() => {
          if (
            Math.abs(artPlayerRef.current.volume - lastVolumeRef.current) > 0.01
          ) {
            artPlayerRef.current.volume = lastVolumeRef.current;
          }
          if (
            Math.abs(
              artPlayerRef.current.playbackRate - lastPlaybackRateRef.current
            ) > 0.01 &&
            isWebkit
          ) {
            artPlayerRef.current.playbackRate = lastPlaybackRateRef.current;
          }
          artPlayerRef.current.notice.show = '';
        }, 0);

        // 隐藏换源加载状态
        setIsVideoLoading(false);
      });

      // 监听视频时间更新事件，实现跳过片头片尾
      artPlayerRef.current.on('video:timeupdate', () => {
        if (!skipConfigRef.current.enable) return;

        const currentTime = artPlayerRef.current.currentTime || 0;
        const duration = artPlayerRef.current.duration || 0;
        const now = Date.now();

        // 限制跳过检查频率为1.5秒一次
        if (now - lastSkipCheckRef.current < 1500) return;
        lastSkipCheckRef.current = now;

        // 跳过片头
        if (
          skipConfigRef.current.intro_time > 0 &&
          currentTime < skipConfigRef.current.intro_time
        ) {
          artPlayerRef.current.currentTime = skipConfigRef.current.intro_time;
          artPlayerRef.current.notice.show = `已跳过片头 (${formatTime(
            skipConfigRef.current.intro_time
          )})`;
        }

        // 跳过片尾
        if (
          skipConfigRef.current.outro_time < 0 &&
          duration > 0 &&
          currentTime >
          artPlayerRef.current.duration + skipConfigRef.current.outro_time
        ) {
          if (sleepModeRef.current === -1) {
            // 定时暂停选了"播完本集"：跳过片尾后停下，不进入下一集
            triggerSleepPause('本集已播完，已自动暂停');
          } else if (
            currentEpisodeIndexRef.current <
            (detailRef.current?.episodes?.length || 1) - 1
          ) {
            handleNextEpisode();
          } else {
            artPlayerRef.current.pause();
          }
          artPlayerRef.current.notice.show = `已跳过片尾 (${formatTime(
            skipConfigRef.current.outro_time
          )})`;
        }
      });

      artPlayerRef.current.on('error', (err: any) => {
        console.error('播放器错误:', err);
        if (artPlayerRef.current.currentTime > 0) {
          return;
        }
      });

      // 监听视频播放结束事件：释放 Wake Lock 并自动播放下一集
      artPlayerRef.current.on('video:ended', () => {
        releaseWakeLock();

        // 定时暂停选了"播完本集"：停在这里，不自动播放下一集
        if (sleepModeRef.current === -1) {
          triggerSleepPause('本集已播完，已自动暂停');
          return;
        }

        const d = detailRef.current;
        const idx = currentEpisodeIndexRef.current;
        if (d && d.episodes && idx < d.episodes.length - 1) {
          setTimeout(() => {
            setCurrentEpisodeIndex(idx + 1);
          }, 1000);
        }
      });

      artPlayerRef.current.on('video:timeupdate', () => {
        const now = Date.now();
        let interval = 5000;
        if (process.env.NEXT_PUBLIC_STORAGE_TYPE === 'upstash') {
          interval = 20000;
        }
        if (now - lastSaveTimeRef.current > interval) {
          saveCurrentPlayProgress();
          lastSaveTimeRef.current = now;
        }
      });

      if (artPlayerRef.current?.video) {
        ensureVideoSource(
          artPlayerRef.current.video as HTMLVideoElement,
          videoUrl
        );
      }
    } catch (err) {
      console.error('创建播放器失败:', err);
      setError('播放器初始化失败');
    }
  }, [Artplayer, Hls, videoUrl, loading, blockAdEnabled]);

  // 当组件卸载时清理定时器、Wake Lock 和播放器资源
  useEffect(() => {
    return () => {
      // 清理定时器
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }

      // 释放 Wake Lock
      releaseWakeLock();

      // 销毁播放器实例
      cleanupPlayer();
    };
  }, []);

  if (loading) {
    return (
      <PageLayout activePath='/play'>
        <div className='flex items-center justify-center min-h-screen bg-transparent'>
          <div className='text-center max-w-md mx-auto px-6'>
            {/* 动画影院图标 */}
            <div className='relative mb-8'>
              <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
                <div className='text-white text-4xl'>
                  {loadingStage === 'searching' && '🔍'}
                  {loadingStage === 'preferring' && '⚡'}
                  {loadingStage === 'fetching' && '🎬'}
                  {loadingStage === 'ready' && '✨'}
                </div>
                {/* 旋转光环 */}
                <div className='absolute -inset-2 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl opacity-20 animate-spin'></div>
              </div>

              {/* 浮动粒子效果 */}
              <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
                <div className='absolute top-2 left-2 w-2 h-2 bg-green-400 rounded-full animate-bounce'></div>
                <div
                  className='absolute top-4 right-4 w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce'
                  style={{ animationDelay: '0.5s' }}
                ></div>
                <div
                  className='absolute bottom-3 left-6 w-1 h-1 bg-lime-400 rounded-full animate-bounce'
                  style={{ animationDelay: '1s' }}
                ></div>
              </div>
            </div>

            {/* 进度指示器 */}
            <div className='mb-6 w-80 mx-auto'>
              <div className='flex justify-center space-x-2 mb-4'>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${loadingStage === 'searching' || loadingStage === 'fetching'
                    ? 'bg-green-500 scale-125'
                    : loadingStage === 'preferring' ||
                      loadingStage === 'ready'
                      ? 'bg-green-500'
                      : 'bg-gray-300'
                    }`}
                ></div>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${loadingStage === 'preferring'
                    ? 'bg-green-500 scale-125'
                    : loadingStage === 'ready'
                      ? 'bg-green-500'
                      : 'bg-gray-300'
                    }`}
                ></div>
                <div
                  className={`w-3 h-3 rounded-full transition-all duration-500 ${loadingStage === 'ready'
                    ? 'bg-green-500 scale-125'
                    : 'bg-gray-300'
                    }`}
                ></div>
              </div>

              {/* 进度条 */}
              <div className='w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden'>
                <div
                  className='h-full bg-gradient-to-r from-green-500 to-emerald-600 rounded-full transition-all duration-1000 ease-out'
                  style={{
                    width:
                      loadingStage === 'searching' ||
                        loadingStage === 'fetching'
                        ? '33%'
                        : loadingStage === 'preferring'
                          ? '66%'
                          : '100%',
                  }}
                ></div>
              </div>
            </div>

            {/* 加载消息 */}
            <div className='space-y-2'>
              <p className='text-xl font-semibold text-gray-800 dark:text-gray-200 animate-pulse'>
                {loadingMessage}
              </p>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  // 没有同名资源但有相近候选：横向卡片布局
  if (error && titleCandidates.length > 0) {
    return (
      <PageLayout activePath='/play'>
        <div className='px-4 sm:px-10 py-6 max-w-6xl'>
          <div className='flex flex-wrap items-start justify-between gap-3 mb-5'>
            <div className='min-w-0'>
              <h2 className='text-xl font-bold text-gray-800 dark:text-gray-100'>
                没找到《{videoTitle}》的同名资源
              </h2>
              <p className='text-sm text-gray-500 dark:text-gray-400 mt-1'>
                不同片源的译名可能不一样，下面是名字相近的结果，点一下即可播放
              </p>
            </div>
            <div className='flex gap-2 flex-shrink-0'>
              <button
                onClick={() =>
                  router.push(`/search?q=${encodeURIComponent(videoTitle)}`)
                }
                className='px-4 py-2 text-sm rounded-lg bg-green-500 text-white hover:bg-green-600'
              >
                去搜索
              </button>
              <button
                onClick={() => window.location.reload()}
                className='px-4 py-2 text-sm rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:opacity-80'
              >
                重试
              </button>
            </div>
          </div>
          <div className='grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
            {titleCandidates.map((c) => (
              <button
                key={`${c.first.source}-${c.first.id}`}
                onClick={() => {
                  const params = new URLSearchParams({
                    source: c.first.source,
                    id: c.first.id,
                    title: c.title,
                    year: c.year,
                  });
                  if (searchType) params.set('stype', searchType);
                  window.location.href = `/play?${params.toString()}`;
                }}
                className='flex items-center gap-3 p-3 text-left rounded-xl bg-gray-100 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 hover:border-green-500 hover:bg-green-500/10 transition-colors'
              >
                <div className='w-12 h-16 flex-shrink-0 rounded overflow-hidden bg-gray-300 dark:bg-gray-700'>
                  {c.first.poster && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={processImageUrl(c.first.poster)}
                      alt={c.title}
                      className='w-full h-full object-cover'
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  )}
                </div>
                <div className='min-w-0'>
                  <div className='font-medium text-gray-900 dark:text-gray-100 line-clamp-2'>
                    {c.title}
                  </div>
                  <div className='text-xs text-gray-500 dark:text-gray-400 mt-1 whitespace-nowrap'>
                    {c.year} · {c.episodes} 集 · {c.first.source_name}
                    {c.sourceCount > 1 ? ` 等 ${c.sourceCount} 个源` : ''}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout activePath='/play'>
        <div className='flex items-center justify-center min-h-screen bg-transparent'>
          <div className='text-center max-w-md mx-auto px-6'>
            {/* 错误图标 */}
            <div className='relative mb-8'>
              <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-red-500 to-orange-500 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
                <div className='text-white text-4xl'>😵</div>
                {/* 脉冲效果 */}
                <div className='absolute -inset-2 bg-gradient-to-r from-red-500 to-orange-500 rounded-2xl opacity-20 animate-pulse'></div>
              </div>

              {/* 浮动错误粒子 */}
              <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
                <div className='absolute top-2 left-2 w-2 h-2 bg-red-400 rounded-full animate-bounce'></div>
                <div
                  className='absolute top-4 right-4 w-1.5 h-1.5 bg-orange-400 rounded-full animate-bounce'
                  style={{ animationDelay: '0.5s' }}
                ></div>
                <div
                  className='absolute bottom-3 left-6 w-1 h-1 bg-yellow-400 rounded-full animate-bounce'
                  style={{ animationDelay: '1s' }}
                ></div>
              </div>
            </div>

            {/* 错误信息 */}
            <div className='space-y-4 mb-8'>
              <h2 className='text-2xl font-bold text-gray-800 dark:text-gray-200'>
                哎呀，出现了一些问题
              </h2>
              <div className='bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4'>
                <p className='text-red-600 dark:text-red-400 font-medium'>
                  {error}
                </p>
              </div>
              <p className='text-sm text-gray-500 dark:text-gray-400'>
                请检查网络连接或尝试刷新页面
              </p>
            </div>

            {/* 操作按钮 */}
            <div className='space-y-3'>
              <button
                onClick={() =>
                  videoTitle
                    ? router.push(`/search?q=${encodeURIComponent(videoTitle)}`)
                    : router.back()
                }
                className='w-full px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-medium hover:from-green-600 hover:to-emerald-700 transform hover:scale-105 transition-all duration-200 shadow-lg hover:shadow-xl'
              >
                {videoTitle ? '🔍 返回搜索' : '← 返回上页'}
              </button>

              <button
                onClick={() => window.location.reload()}
                className='w-full px-6 py-3 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200'
              >
                🔄 重新尝试
              </button>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout activePath='/play'>
      <div className='flex flex-col gap-3 py-4 px-5 lg:px-[3rem] 2xl:px-20'>
        {/* 第一行：影片标题 */}
        <div className='py-1'>
          <h1 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
            {videoTitle || '影片标题'}
            {totalEpisodes > 1 && (
              <span className='text-gray-500 dark:text-gray-400'>
                {` > ${detail?.episodes_titles?.[currentEpisodeIndex] || `第 ${currentEpisodeIndex + 1} 集`}`}
              </span>
            )}
          </h1>
        </div>
        {/* 第二行：播放器和选集 */}
        <div className='space-y-2'>
          {/* 折叠控制 - 仅在 lg 及以上屏幕显示 */}
          <div className='hidden lg:flex justify-end'>
            <button
              onClick={() =>
                setIsEpisodeSelectorCollapsed(!isEpisodeSelectorCollapsed)
              }
              className='group relative flex items-center space-x-1.5 px-3 py-1.5 rounded-full bg-white/80 hover:bg-white dark:bg-gray-800/80 dark:hover:bg-gray-800 backdrop-blur-sm border border-gray-200/50 dark:border-gray-700/50 shadow-sm hover:shadow-md transition-all duration-200'
              title={
                isEpisodeSelectorCollapsed ? '显示选集面板' : '隐藏选集面板'
              }
            >
              <svg
                className={`w-3.5 h-3.5 text-gray-500 dark:text-gray-400 transition-transform duration-200 ${isEpisodeSelectorCollapsed ? 'rotate-180' : 'rotate-0'
                  }`}
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M9 5l7 7-7 7'
                />
              </svg>
              <span className='text-xs font-medium text-gray-600 dark:text-gray-300'>
                {isEpisodeSelectorCollapsed ? '显示' : '隐藏'}
              </span>

              {/* 精致的状态指示点 */}
              <div
                className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full transition-all duration-200 ${isEpisodeSelectorCollapsed
                  ? 'bg-orange-400 animate-pulse'
                  : 'bg-green-400'
                  }`}
              ></div>
            </button>
          </div>

          <div
            className={`grid gap-4 lg:h-[500px] xl:h-[650px] 2xl:h-[750px] transition-all duration-300 ease-in-out ${isEpisodeSelectorCollapsed
              ? 'grid-cols-1'
              : 'grid-cols-1 md:grid-cols-4'
              }`}
          >
            {/* 播放器 */}
            <div
              className={`h-full transition-all duration-300 ease-in-out rounded-xl border border-white/0 dark:border-white/30 ${isEpisodeSelectorCollapsed ? 'col-span-1' : 'md:col-span-3'
                }`}
            >
              <div className='relative w-full h-[300px] lg:h-full'>
                <div
                  ref={artRef}
                  className='bg-black w-full h-full rounded-xl overflow-hidden shadow-lg'
                ></div>

                {/* 换源加载蒙层 */}
                {isVideoLoading && (
                  <div className='absolute inset-0 bg-black/85 backdrop-blur-sm rounded-xl flex items-center justify-center z-[500] transition-all duration-300'>
                    <div className='text-center max-w-md mx-auto px-6'>
                      {/* 动画影院图标 */}
                      <div className='relative mb-8'>
                        <div className='relative mx-auto w-24 h-24 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl shadow-2xl flex items-center justify-center transform hover:scale-105 transition-transform duration-300'>
                          <div className='text-white text-4xl'>🎬</div>
                          {/* 旋转光环 */}
                          <div className='absolute -inset-2 bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl opacity-20 animate-spin'></div>
                        </div>

                        {/* 浮动粒子效果 */}
                        <div className='absolute top-0 left-0 w-full h-full pointer-events-none'>
                          <div className='absolute top-2 left-2 w-2 h-2 bg-green-400 rounded-full animate-bounce'></div>
                          <div
                            className='absolute top-4 right-4 w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce'
                            style={{ animationDelay: '0.5s' }}
                          ></div>
                          <div
                            className='absolute bottom-3 left-6 w-1 h-1 bg-lime-400 rounded-full animate-bounce'
                            style={{ animationDelay: '1s' }}
                          ></div>
                        </div>
                      </div>

                      {/* 换源消息 */}
                      <div className='space-y-2'>
                        <p className='text-xl font-semibold text-white animate-pulse'>
                          {videoLoadingStage === 'sourceChanging'
                            ? '🔄 切换播放源...'
                            : '🔄 视频加载中...'}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 选集和换源 - 在移动端始终显示，在 lg 及以上可折叠 */}
            <div
              className={`h-[300px] lg:h-full md:overflow-hidden transition-all duration-300 ease-in-out ${isEpisodeSelectorCollapsed
                ? 'md:col-span-1 lg:hidden lg:opacity-0 lg:scale-95'
                : 'md:col-span-1 lg:opacity-100 lg:scale-100'
                }`}
            >
              <EpisodeSelector
                totalEpisodes={totalEpisodes}
                episodes_titles={detail?.episodes_titles || []}
                value={currentEpisodeIndex + 1}
                onChange={handleEpisodeChange}
                onSourceChange={handleSourceChange}
                currentSource={currentSource}
                currentId={currentId}
                videoTitle={searchTitle || videoTitle}
                availableSources={availableSources}
                sourceSearchLoading={sourceSearchLoading}
                sourceSearchError={sourceSearchError}
                precomputedVideoInfo={precomputedVideoInfo}
              />
            </div>
          </div>
        </div>

        {/* 详情展示 */}
        <div className='grid grid-cols-1 md:grid-cols-4 gap-4'>
          {/* 文字区 */}
          <div className='md:col-span-3'>
            <div className='p-6 flex flex-col min-h-0'>
              {/* 标题 */}
              <h1 className='text-3xl font-bold mb-2 tracking-wide flex items-center flex-shrink-0 text-center md:text-left w-full'>
                {videoTitle || '影片标题'}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleFavorite();
                  }}
                  className='ml-3 flex-shrink-0 hover:opacity-80 transition-opacity'
                >
                  <FavoriteIcon filled={favorited} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDownload();
                  }}
                  title='下载本集到本设备，离线观看'
                  className='ml-3 flex-shrink-0 flex items-center gap-1 text-sm font-normal px-3 py-1 rounded-full border border-gray-400/60 text-gray-600 dark:text-gray-300 hover:opacity-80 transition-opacity whitespace-nowrap'
                >
                  <Download className='w-4 h-4' />
                  {offlineState.status === 'downloading'
                    ? `下载中 ${offlineState.pct}%${
                        offlineState.speed
                          ? ` · ${formatBytes(offlineState.speed)}/s`
                          : ''
                      }`
                    : offlineState.status === 'paused'
                      ? `继续下载 ${offlineState.pct}%`
                      : offlineState.status === 'done'
                        ? '已下载'
                        : offlineState.status === 'error'
                          ? '下载失败，重试'
                          : '下载本集'}
                </button>
                {downloadDialog && (
                  <div
                    className='fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4'
                    onClick={() => setDownloadDialog(null)}
                  >
                    <div
                      className='w-full max-w-sm rounded-xl bg-white dark:bg-gray-800 p-5 text-base font-normal text-gray-800 dark:text-gray-100 shadow-xl'
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className='text-lg font-semibold mb-1'>
                        下载第 {currentEpisodeIndex + 1} 集
                      </div>
                      <div className='text-xs text-gray-500 dark:text-gray-400 mb-4'>
                        当前源：{detail?.source_name || currentSource}
                      </div>
                      {downloadDialog.loading ? (
                        <div className='text-sm text-gray-500 py-4'>
                          正在分析清晰度和大小…
                        </div>
                      ) : downloadDialog.error ? (
                        <div className='text-sm text-red-500 py-2'>
                          分析失败：{downloadDialog.error}
                          <br />
                          这个源可能不支持下载，可以换一个源再试。
                        </div>
                      ) : (
                        <div className='space-y-2'>
                          {downloadDialog.options.map((o, i) => (
                            <button
                              key={i}
                              onClick={() => startDownload(o)}
                              className='w-full flex items-center justify-between px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-green-500/10'
                            >
                              <span className='font-medium'>{o.label}</span>
                              <span className='text-sm text-gray-500 dark:text-gray-400'>
                                {o.estBytes > 0
                                  ? `约 ${formatBytes(o.estBytes)}`
                                  : '大小未知'}
                              </span>
                            </button>
                          ))}
                          {downloadDialog.options.length === 1 && (
                            <div className='text-xs text-gray-500 dark:text-gray-400 pt-1'>
                              这个源只提供一种清晰度。想要更清晰，可以在右侧"换源"里选标注 1080p
                              的源，再回来下载。
                            </div>
                          )}
                        </div>
                      )}
                      <button
                        onClick={() => setDownloadDialog(null)}
                        className='mt-4 w-full py-2 text-sm text-gray-500'
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </h1>

              {/* 关键信息行 */}
              <div className='flex flex-wrap items-center gap-3 text-base mb-4 opacity-80 flex-shrink-0'>
                {detail?.class && (
                  <span className='text-green-600 font-semibold'>
                    {detail.class}
                  </span>
                )}
                {(detail?.year || videoYear) && (
                  <span>{detail?.year || videoYear}</span>
                )}
                {detail?.source_name && (
                  <span className='border border-gray-500/60 px-2 py-[1px] rounded'>
                    {detail.source_name}
                  </span>
                )}
                {detail?.type_name && <span>{detail.type_name}</span>}
              </div>
              {/* 剧情简介 */}
              {detail?.desc && (
                <div
                  className='mt-0 text-base leading-relaxed opacity-90 overflow-y-auto pr-2 flex-1 min-h-0 scrollbar-hide'
                  style={{ whiteSpace: 'pre-line' }}
                >
                  {detail.desc}
                </div>
              )}
            </div>
          </div>

          {/* 封面展示 */}
          <div className='hidden md:block md:col-span-1 md:order-first'>
            <div className='pl-0 py-4 pr-6'>
              <div className='relative bg-gray-300 dark:bg-gray-700 aspect-[2/3] flex items-center justify-center rounded-xl overflow-hidden'>
                {videoCover ? (
                  <>
                    <img
                      src={processImageUrl(videoCover)}
                      alt={videoTitle}
                      className='w-full h-full object-cover'
                    />

                    {/* 豆瓣链接按钮 */}
                    {videoDoubanId !== 0 && (
                      <a
                        href={`https://movie.douban.com/subject/${videoDoubanId.toString()}`}
                        target='_blank'
                        rel='noopener noreferrer'
                        className='absolute top-3 left-3'
                      >
                        <div className='bg-green-500 text-white text-xs font-bold w-8 h-8 rounded-full flex items-center justify-center shadow-md hover:bg-green-600 hover:scale-[1.1] transition-all duration-300 ease-out'>
                          <svg
                            width='16'
                            height='16'
                            viewBox='0 0 24 24'
                            fill='none'
                            stroke='currentColor'
                            strokeWidth='2'
                            strokeLinecap='round'
                            strokeLinejoin='round'
                          >
                            <path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'></path>
                            <path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'></path>
                          </svg>
                        </div>
                      </a>
                    )}
                  </>
                ) : (
                  <span className='text-gray-600 dark:text-gray-400'>
                    封面图片
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}

// FavoriteIcon 组件
const FavoriteIcon = ({ filled }: { filled: boolean }) => {
  if (filled) {
    return (
      <svg
        className='h-7 w-7'
        viewBox='0 0 24 24'
        xmlns='http://www.w3.org/2000/svg'
      >
        <path
          d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
          fill='#ef4444' /* Tailwind red-500 */
          stroke='#ef4444'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    );
  }
  return (
    <Heart className='h-7 w-7 stroke-[1] text-gray-600 dark:text-gray-300' />
  );
};

export default function PlayPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PlayPageClient />
    </Suspense>
  );
}
