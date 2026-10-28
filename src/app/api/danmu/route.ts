/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * 弹幕中转接口（对接兼容弹弹play 的弹幕服务，例如 LogVar danmu_api）。
 * 弹幕服务地址保存在服务端环境变量 DANMU_API_URL（可选 DANMU_API_TOKEN），不暴露给浏览器。
 *
 * GET /api/danmu?action=match&fileName=美人余%20S01E02   自动匹配剧集
 * GET /api/danmu?action=comment&id=10003                 获取某一集的弹幕
 */
export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const base = (process.env.DANMU_API_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    return NextResponse.json({ error: '未配置弹幕服务' }, { status: 503 });
  }
  const token = (process.env.DANMU_API_TOKEN || '').trim();
  const prefix = token ? `${base}/${encodeURIComponent(token)}` : base;

  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  try {
    let upstream: Response;
    if (action === 'match') {
      const fileName = (searchParams.get('fileName') || '').slice(0, 200);
      if (!fileName) {
        return NextResponse.json({ error: '缺少 fileName' }, { status: 400 });
      }
      upstream = await fetch(`${prefix}/api/v2/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName }),
      });
    } else if (action === 'comment') {
      const id = searchParams.get('id') || '';
      if (!/^\d+$/.test(id)) {
        return NextResponse.json({ error: '无效的 id' }, { status: 400 });
      }
      upstream = await fetch(
        `${prefix}/api/v2/comment/${id}?withRelated=true&chConvert=1`
      );
    } else {
      return NextResponse.json({ error: '无效的 action' }, { status: 400 });
    }

    // 直接把上游响应转发给浏览器（不在服务端解析，节省 CPU）
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, max-age=600',
      },
    });
  } catch (error) {
    console.error('弹幕服务请求失败:', error);
    return NextResponse.json({ error: '弹幕服务请求失败' }, { status: 502 });
  }
}
