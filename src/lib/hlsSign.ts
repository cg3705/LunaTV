/**
 * 隔空播放清理接口（/api/hls-clean）的地址签名。
 * 电视通过 AirPlay 直接访问这个接口、不带登录 Cookie，所以用 HMAC 签名
 * 限定只能清理本站签发过的播放地址，避免被当成公开代理使用。
 * 密钥取站点密码（只在服务器端使用，不会下发到浏览器）。
 */

function getSecret(): string {
  return process.env.PASSWORD || '';
}

function toBase64Url(bytes: ArrayBuffer): string {
  let bin = '';
  new Uint8Array(bytes).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signHlsUrl(url: string): Promise<string | null> {
  const secret = getSecret();
  if (!secret) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`hls-clean:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(url)
  );
  return toBase64Url(sig).slice(0, 32);
}

export async function verifyHlsUrl(url: string, sig: string): Promise<boolean> {
  if (!url || !sig) return false;
  const expected = await signHlsUrl(url);
  if (!expected || expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

/** 生成清理接口的站内相对地址 */
export async function buildCleanPath(url: string): Promise<string | null> {
  const sig = await signHlsUrl(url);
  if (!sig) return null;
  return `/api/hls-clean?u=${encodeURIComponent(url)}&s=${sig}`;
}
