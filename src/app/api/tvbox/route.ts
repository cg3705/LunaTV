/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { API_CONFIG, getConfig } from '@/lib/config';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'nodejs';

/**
 * TVBox 配置接口：把后台已启用的视频源、直播源转成 TVBox 配置 JSON。
 * 地址：/api/tvbox?token=<TVBOX_TOKEN>
 * 未设置 Secret TVBOX_TOKEN 时接口关闭；令牌不对返回 401。
 *
 * 很多采集站的视频只挂在小类（如"国产剧"）下，大类（如"连续剧"）为空，
 * TVBox 会显示"没有找到数据"。这里预先读取每个源的分类列表，
 * 只保留没有子分类的末级分类，写入 categories 让 TVBox 只显示这些；
 * 未关闭成人过滤时同时去掉成人分类（与网页版规则一致）。
 */
const DEFAULT_LIVE_URL =
  'https://raw.githubusercontent.com/cg3705/LunaTV/main/live/channels-hd.m3u';

const CATEGORY_TIMEOUT_MS = 5000;
const CATEGORY_CACHE_MS = 6 * 60 * 60 * 1000;

// 只缓存已完成的结果（不缓存在途请求，避免 Workers 跨请求挂起）
const categoryCache = new Map<string, { at: number; names: string[] }>();

interface CmsClass {
  type_id: number | string;
  type_pid?: number | string;
  type_name: string;
}

async function getLeafCategories(
  api: string,
  filterYellow: boolean
): Promise<string[] | null> {
  const cacheKey = `${filterYellow ? 1 : 0}|${api}`;
  const cached = categoryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CATEGORY_CACHE_MS) {
    return cached.names;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATEGORY_TIMEOUT_MS);
  try {
    const sep = api.includes('?') ? '&' : '?';
    const res = await fetch(`${api}${sep}ac=list`, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { class?: CmsClass[] };
    const classes = Array.isArray(data.class) ? data.class : [];
    if (classes.length === 0) return null;

    const parentIds = new Set(
      classes
        .map((c) => String(c.type_pid ?? '0'))
        .filter((pid) => pid !== '0' && pid !== '')
    );
    let names = classes
      .filter((c) => !parentIds.has(String(c.type_id)))
      .map((c) => String(c.type_name || '').trim())
      .filter(Boolean);
    if (filterYellow) {
      names = names.filter((n) => !yellowWords.some((w) => n.includes(w)));
    }
    if (names.length === 0) return null;

    categoryCache.set(cacheKey, { at: Date.now(), names });
    return names;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: NextRequest) {
  const expected = process.env.TVBOX_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'TVBox 接口未启用（未设置 TVBOX_TOKEN）' },
      { status: 403 }
    );
  }

  const token = request.nextUrl.searchParams.get('token') || '';
  if (token !== expected) {
    return NextResponse.json({ error: '令牌无效' }, { status: 401 });
  }

  try {
    const config = await getConfig();
    const filterYellow = !config.SiteConfig.DisableYellowFilter;

    const enabledSites = config.SourceConfig.filter(
      (s) => !s.disabled && s.api
    );
    const categoryLists = await Promise.all(
      enabledSites.map((s) => getLeafCategories(s.api, filterYellow))
    );

    const sites = enabledSites.map((s, i) => ({
      key: s.key,
      name: s.name,
      type: 1,
      api: s.api,
      searchable: 1,
      quickSearch: 1,
      filterable: 1,
      ...(categoryLists[i] ? { categories: categoryLists[i] } : {}),
    }));

    const enabledLives = (config.LiveConfig || []).filter(
      (l) => !l.disabled && l.url
    );
    const lives =
      enabledLives.length > 0
        ? enabledLives.map((l) => ({
            name: l.name,
            type: 0,
            url: l.url,
            ...(l.ua ? { ua: l.ua } : {}),
            ...(l.epg ? { epg: l.epg } : {}),
          }))
        : [{ name: '高清直播', type: 0, url: DEFAULT_LIVE_URL }];

    return NextResponse.json(
      { sites, lives },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('TVBox 配置生成失败:', error);
    return NextResponse.json({ error: '配置生成失败' }, { status: 500 });
  }
}
