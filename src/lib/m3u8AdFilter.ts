/* eslint-disable no-console */

// 去广告规则：播放页（hls.js）和隔空播放的服务器端清理接口共用同一份
/**
 * 去除 m3u8 中拼接的广告分段。
 * 采集站把广告视频用 #EXT-X-DISCONTINUITY 拼进正片，有两种可识别的特征：
 * 1. 来源不同：广告切片来自另一个目录/服务器（另一个视频文件），正片切片几乎都来自同一个目录；
 * 2. 规格不同：正片切片时长高度统一时，广告是另外编码的，会出现不合规格的切片。
 * 3. 已知指纹：资源站会反复使用同一批广告视频，分段的切片时长组合与已知广告完全一致的直接删除。
 * 满足任一特征、且分段很短的，判定为广告并整段删除。
 * 保险：删除总量过大（超过 5 分钟或总时长 10%）时放弃过滤，原样返回。
 */
export function filterAdsFromM3U8(m3u8Content: string): string {
  if (!m3u8Content || !m3u8Content.includes('#EXTINF')) return m3u8Content;

  const lines = m3u8Content.split(/\r?\n/);
  const header: string[] = [];
  const footer: string[] = [];
  type Block = { lines: string[]; durs: number[]; dirs: string[] };
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let seenSegment = false;
  let pendingDur = 0;

  // 切片所在目录（去掉文件名和参数），用来判断是否来自同一个视频文件
  const dirOf = (uri: string) => {
    const noQuery = uri.split('?')[0];
    const idx = noQuery.lastIndexOf('/');
    return idx >= 0 ? noQuery.slice(0, idx) : '';
  };

  for (const line of lines) {
    if (line.startsWith('#EXT-X-ENDLIST')) {
      footer.push(line);
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      cur = { lines: [line], durs: [], dirs: [] };
      blocks.push(cur);
      seenSegment = true;
      continue;
    }
    if (
      !seenSegment &&
      !line.startsWith('#EXTINF') &&
      !line.startsWith('#EXT-X-KEY') &&
      !line.startsWith('#EXT-X-MAP')
    ) {
      header.push(line);
      continue;
    }
    seenSegment = true;
    if (!cur) {
      cur = { lines: [], durs: [], dirs: [] };
      blocks.push(cur);
    }
    cur.lines.push(line);
    if (line.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(line.slice(8)) || 0;
    } else if (line.trim() && !line.startsWith('#')) {
      cur.durs.push(pendingDur);
      cur.dirs.push(dirOf(line.trim()));
      pendingDur = 0;
    }
  }

  const segBlocks = blocks.filter((b) => b.durs.length > 0);
  const allDurs = segBlocks.flatMap((b) => b.durs);
  if (segBlocks.length < 2 || allDurs.length < 20) return m3u8Content;
  const total = allDurs.reduce((x, y) => x + y, 0);
  const blockDur = (b: Block) => b.durs.reduce((x, y) => x + y, 0);

  // 特征 1：正片目录（按时长占比最多的目录）
  const dirDur = new Map<string, number>();
  segBlocks.forEach((b) =>
    b.dirs.forEach((d, k) => dirDur.set(d, (dirDur.get(d) || 0) + b.durs[k]))
  );
  const [mainDir, mainDirDur] = Array.from(dirDur.entries()).sort(
    (x, y) => y[1] - x[1]
  )[0];
  const dirReliable = mainDirDur / total >= 0.8;

  // 特征 2：正片的标准切片时长（众数），时长统一（≥90%）时才使用。
  // 精确到 3 位小数：例如正片 4.004 秒（29.97 帧）而广告 4.000 秒（25 帧），两位小数会认不出来
  const counts = new Map<string, number>();
  for (const d of allDurs) {
    const k = d.toFixed(3);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const [modeKey, modeCount] = Array.from(counts.entries()).sort(
    (x, y) => y[1] - x[1]
  )[0];
  const standard = parseFloat(modeKey);
  const durReliable = modeCount / allDurs.length >= 0.9;

  const byDir = blocks.map(
    (b) =>
      dirReliable &&
      b.durs.length > 0 &&
      b.dirs.every((d) => d !== mainDir) &&
      blockDur(b) < 120
  );
  const byDur = blocks.map(
    (b) =>
      durReliable &&
      b.durs.length > 0 &&
      b.durs.some((d) => Math.abs(d - standard) > 0.002) &&
      blockDur(b) < 60
  );
  // 最后一段仅因"规格不同"被判定时，如果前一段是正片，视为正片自然结尾（最后一个切片通常不完整），保留
  const lastIdx = blocks.map((b) => b.durs.length > 0).lastIndexOf(true);
  if (lastIdx >= 0 && byDur[lastIdx] && !byDir[lastIdx]) {
    let prev = lastIdx - 1;
    while (prev >= 0 && blocks[prev].durs.length === 0) prev--;
    if (prev >= 0 && !byDir[prev] && !byDur[prev]) byDur[lastIdx] = false;
  }
  // 特征 3：已知广告指纹（分段内各切片时长，保留两位小数，用逗号连接）。
  // 发现新的广告后把它的指纹加到这里，所有剧集都会受益
  const KNOWN_AD_SIGNATURES = new Set([
    '4.00,5.48,2.68', // 如意资源：片尾广告（《逃避虽可耻但有用》《美人余》）
    '4.00,5.00,4.00,4.24,2.76', // 如意资源：葡京娱乐场
    '4.00,4.00,4.00,4.00,4.00,2.00', // 如意资源：澳门新葡京
    '4.00,5.24,4.72,4.00,3.04', // 如意资源：澳门新葡京（独家赞助）
  ]);
  const signature = (b: Block) => b.durs.map((d) => d.toFixed(2)).join(',');
  const byFingerprint = blocks.map(
    (b) => b.durs.length > 0 && KNOWN_AD_SIGNATURES.has(signature(b))
  );

  const isAd = blocks.map((_, i) => byDir[i] || byDur[i] || byFingerprint[i]);
  // 夹在两段广告之间、不到 3 秒的碎片，也是广告的一部分
  const segIdx = blocks
    .map((b, i) => (b.durs.length > 0 ? i : -1))
    .filter((i) => i >= 0);
  segIdx.forEach((idx, k) => {
    if (k === 0 || k === segIdx.length - 1 || isAd[idx]) return;
    if (
      isAd[segIdx[k - 1]] &&
      isAd[segIdx[k + 1]] &&
      blockDur(blocks[idx]) < 3
    ) {
      isAd[idx] = true;
    }
  });

  const removed = blocks.reduce(
    (sum, b, i) => (isAd[i] ? sum + blockDur(b) : sum),
    0
  );
  // 删除过多说明规则不适用这个源，放弃过滤
  if (removed === 0 || removed > 300 || removed > total * 0.1)
    return m3u8Content;

  // 分段是否来自正片的视频文件
  const isMainBlock = (b: Block) =>
    b.durs.length > 0 && (!dirReliable || b.dirs.every((d) => d === mainDir));

  const out: string[] = [...header];
  let carried: string[] = [];
  let removedSinceLastKept = false;
  let lastKept: Block | null = null;
  blocks.forEach((b, i) => {
    if (isAd[i]) {
      // 删除广告段时保留其中的加密 / 初始化信息，供后面的正片使用
      carried = carried.concat(
        b.lines.filter(
          (l) => l.startsWith('#EXT-X-KEY') || l.startsWith('#EXT-X-MAP')
        )
      );
      removedSinceLastKept = true;
      return;
    }
    let blockLines = b.lines;
    const startsWithDisc = !!blockLines[0]?.startsWith('#EXT-X-DISCONTINUITY');
    // 删掉广告后，前后两段如果都来自正片的同一个视频文件，中间的分隔标记是插广告时才加的，
    // 已经多余；保留它会让播放器重新初始化解码器，造成卡顿，所以一并去掉
    const dropDisc =
      startsWithDisc &&
      removedSinceLastKept &&
      lastKept !== null &&
      isMainBlock(lastKept) &&
      isMainBlock(b);
    if (dropDisc) blockLines = blockLines.slice(1);
    if (carried.length) {
      if (!dropDisc && startsWithDisc) {
        out.push(blockLines[0], ...carried, ...blockLines.slice(1));
      } else {
        out.push(...carried, ...blockLines);
      }
      carried = [];
    } else {
      out.push(...blockLines);
    }
    lastKept = b;
    removedSinceLastKept = false;
  });
  out.push(...footer);
  console.log(`去广告：删除 ${Math.round(removed)} 秒广告分段`);
  return out.join('\n');
}
