/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';

/**
 * TVBox 配置接口：把后台已启用的视频源、直播源转成 TVBox 配置 JSON。
 * 地址：/api/tvbox?token=<TVBOX_TOKEN>
 * 未设置 Secret TVBOX_TOKEN 时接口关闭；令牌不对返回 401。
 */
const DEFAULT_LIVE_URL =
  'https://raw.githubusercontent.com/cg3705/LunaTV/main/live/channels-hd.m3u';

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

    const sites = config.SourceConfig.filter((s) => !s.disabled && s.api).map(
      (s) => ({
        key: s.key,
        name: s.name,
        type: 1,
        api: s.api,
        searchable: 1,
        quickSearch: 1,
        filterable: 1,
      })
    );

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
