/* eslint-disable no-console, @next/next/no-img-element */
'use client';

import Hls from 'hls.js';
import { Download, Pause, Play, Trash2, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createOfflineLoader,
  deleteOfflineVideo,
  downloadEpisode,
  DownloadProgress,
  formatBytes,
  getStorageEstimate,
  isDownloading,
  listOfflineVideos,
  offlinePlaylistUrl,
  OfflineVideo,
  pauseDownload,
  registerOfflineServiceWorker,
  saveOfflinePlayTime,
} from '@/lib/offline';

import PageLayout from '@/components/PageLayout';

export default function OfflinePage() {
  const [videos, setVideos] = useState<OfflineVideo[]>([]);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>(
    {}
  );
  const [storage, setStorage] = useState<{
    usage: number;
    quota: number;
  } | null>(null);
  const [playing, setPlaying] = useState<OfflineVideo | null>(null);
  const [online, setOnline] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const refresh = useCallback(async () => {
    try {
      setVideos(await listOfflineVideos());
      setStorage(await getStorageEstimate());
    } catch (e) {
      console.error('读取离线视频失败:', e);
    }
  }, []);

  useEffect(() => {
    registerOfflineServiceWorker();
    refresh();
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [refresh]);

  // 播放
  useEffect(() => {
    const video = videoRef.current;
    if (!playing || !video) return;
    const hls = new Hls({ loader: createOfflineLoader() });
    hlsRef.current = hls;
    hls.loadSource(offlinePlaylistUrl(playing.id));
    hls.attachMedia(video);
    const startAt = playing.playTime || 0;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (startAt > 5 && startAt < playing.duration - 10) {
        video.currentTime = startAt;
      }
      video.play().catch(() => undefined);
    });
    let last = 0;
    const onTime = () => {
      const now = Date.now();
      if (now - last > 5000) {
        last = now;
        saveOfflinePlayTime(playing.id, video.currentTime).catch(
          () => undefined
        );
      }
    };
    video.addEventListener('timeupdate', onTime);
    return () => {
      saveOfflinePlayTime(playing.id, video.currentTime).catch(() => undefined);
      video.removeEventListener('timeupdate', onTime);
      hls.destroy();
      hlsRef.current = null;
    };
  }, [playing]);

  const resume = async (v: OfflineVideo) => {
    try {
      await downloadEpisode(
        {
          source: v.id.split('+')[0],
          videoId: v.id.split('+')[1],
          episodeIndex: v.episodeIndex,
          episodeCount: v.episodeCount,
          title: v.title,
          sourceName: v.sourceName,
          poster: v.poster,
          url: v.sourceUrl,
        },
        (p) => setProgress((prev) => ({ ...prev, [v.id]: p }))
      );
    } catch (e) {
      console.error('下载失败:', e);
    }
    refresh();
  };

  const remove = async (v: OfflineVideo) => {
    if (!confirm(`删除离线视频《${v.title}》第 ${v.episodeIndex + 1} 集？`))
      return;
    if (isDownloading(v.id)) pauseDownload(v.id);
    if (playing?.id === v.id) setPlaying(null);
    await deleteOfflineVideo(v.id);
    refresh();
  };

  return (
    <PageLayout activePath='/offline'>
      <div className='px-4 sm:px-10 py-6 max-w-5xl'>
        <div className='flex items-center gap-3 mb-1'>
          <h1 className='text-2xl font-bold text-gray-800 dark:text-gray-200'>
            离线视频
          </h1>
          {!online && (
            <span className='flex items-center gap-1 text-xs text-orange-500'>
              <WifiOff className='w-4 h-4' /> 当前离线
            </span>
          )}
        </div>
        <p className='text-sm text-gray-500 dark:text-gray-400 mb-6'>
          在播放页点"下载"保存到本设备。下载时请保持页面打开； 请从桌面图标打开
          MTV 下载和观看。
          {storage && (
            <>
              {' '}
              已用 {formatBytes(storage.usage)}
              {storage.quota > 0 && ` / 可用约 ${formatBytes(storage.quota)}`}
            </>
          )}
        </p>

        {playing && (
          <div className='mb-6'>
            <div className='text-sm mb-2 text-gray-700 dark:text-gray-300'>
              正在播放：{playing.title} 第 {playing.episodeIndex + 1} 集
            </div>
            <video
              ref={videoRef}
              controls
              playsInline
              className='w-full max-h-[70vh] bg-black rounded-lg'
            />
          </div>
        )}

        {videos.length === 0 ? (
          <div className='text-center text-gray-500 py-16'>还没有离线视频</div>
        ) : (
          <div className='space-y-3'>
            {videos.map((v) => {
              const p = progress[v.id];
              const done = p ? p.doneParts : v.doneParts;
              const total = p ? p.partCount : v.partCount;
              const bytes = p ? p.bytes : v.bytes;
              const pct = total ? Math.floor((done / total) * 100) : 0;
              const downloading = isDownloading(v.id);
              const complete = v.status === 'done' && !downloading;
              return (
                <div
                  key={v.id}
                  className='flex items-center gap-3 p-3 rounded-lg bg-gray-100 dark:bg-gray-800'
                >
                  <div className='w-12 h-16 flex-shrink-0 rounded overflow-hidden bg-gray-300 dark:bg-gray-700'>
                    {v.poster && (
                      <img
                        src={v.poster}
                        alt={v.title}
                        className='w-full h-full object-cover'
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    )}
                  </div>
                  <div className='flex-1 min-w-0'>
                    <div className='font-medium truncate text-gray-900 dark:text-gray-100'>
                      {v.title}
                    </div>
                    <div className='text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap'>
                      第 {v.episodeIndex + 1} 集 · {v.sourceName} ·{' '}
                      {formatBytes(bytes)}
                      {v.duration > 0 &&
                        ` · ${Math.round(v.duration / 60)} 分钟`}
                    </div>
                    {!complete && (
                      <div className='mt-1'>
                        <div className='h-1.5 bg-gray-300 dark:bg-gray-700 rounded'>
                          <div
                            className='h-1.5 bg-green-500 rounded'
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className='text-xs mt-0.5 text-gray-500'>
                          {downloading
                            ? `下载中 ${pct}%`
                            : v.status === 'error'
                            ? `下载出错（${v.error || '未知原因'}），可继续下载`
                            : `已暂停 ${pct}%`}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className='flex items-center gap-2 flex-shrink-0'>
                    {complete ? (
                      <button
                        onClick={() => setPlaying(v)}
                        className='p-2 rounded-full bg-green-500 text-white'
                        aria-label='播放'
                      >
                        <Play className='w-4 h-4' />
                      </button>
                    ) : downloading ? (
                      <button
                        onClick={() => {
                          pauseDownload(v.id);
                          setTimeout(refresh, 500);
                        }}
                        className='p-2 rounded-full bg-gray-500 text-white'
                        aria-label='暂停'
                      >
                        <Pause className='w-4 h-4' />
                      </button>
                    ) : (
                      <button
                        onClick={() => resume(v)}
                        disabled={!online}
                        className='p-2 rounded-full bg-blue-500 text-white disabled:opacity-40'
                        aria-label='继续下载'
                      >
                        <Download className='w-4 h-4' />
                      </button>
                    )}
                    <button
                      onClick={() => remove(v)}
                      className='p-2 rounded-full bg-red-500/80 text-white'
                      aria-label='删除'
                    >
                      <Trash2 className='w-4 h-4' />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
