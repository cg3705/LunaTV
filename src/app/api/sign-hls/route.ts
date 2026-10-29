import { NextRequest, NextResponse } from 'next/server';

import { buildCleanPath } from '@/lib/hlsSign';

export const runtime = 'nodejs';

/**
 * 为播放地址签发隔空播放清理地址（需登录，受中间件保护）。
 * 播放页在 iPad 上把它挂到 <video> 的备用 <source>，投送到电视时
 * 电视会访问这个地址，拿到去掉广告分段的播放列表。
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('u') || '';
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: '地址无效' }, { status: 400 });
  }
  const path = await buildCleanPath(url);
  if (!path) {
    return NextResponse.json({ error: '未配置站点密码' }, { status: 503 });
  }
  return NextResponse.json(
    { url: path },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
