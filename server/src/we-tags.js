// Wallpaper Engine 认的标签枚举。
// tags 在 project.json 里不是自由文本，WE 客户端按这些值给分类图标和筛选入口，
// 写别的值它不认。所以本地库分成两层：
//   主标签 primary_tag —— 只能取这里的值（或留空 = 未分类）
//   副标签 tags        —— 自由文本，只在本地用，导出时丢弃
export const WE_TAGS = [
  'Anime', 'Girls', 'Guys', 'Game', 'Fantasy', 'Landscape', 'Nature',
  'Relaxing', 'Cartoon', 'CGI', 'Medieval', 'Technology', 'Sci-Fi',
  'Music', 'Abstract', 'Cyberpunk', 'Unspecified',
];

export const WE_TAG_SET = new Set(WE_TAGS);

export const SUB_TAG_MAX_LEN = 4;      // 按字符（码点）算，中文 4 字 / 英文 4 字母
export const SUB_TAG_MAX_COUNT = 30;   // 只为防超长入库，界面上不提示

// 空 / 非法值一律归为「未分类」，不写脏数据
export function normalizePrimaryTag(value) {
  const s = String(value || '').trim();
  return WE_TAG_SET.has(s) ? s : '';
}

// 拆字符串或数组 → 规整后的副标签数组
// 逗号是同义分隔符也是存储分隔符，标签内不允许出现
export function splitSubTags(raw) {
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const out = [];
  for (const item of arr) {
    let s = String(item || '').replace(/[,，]/g, '').trim();
    if (!s) continue;
    const chars = Array.from(s);
    if (chars.length > SUB_TAG_MAX_LEN) s = chars.slice(0, SUB_TAG_MAX_LEN).join('');
    if (!out.includes(s)) out.push(s);
    if (out.length >= SUB_TAG_MAX_COUNT) break;
  }
  return out;
}

export const joinSubTags = (arr) => splitSubTags(arr).join(',');

// 导出给 WE 用：只有主标签是它认识的值，副标签一律不带
export function projectJsonTags(primaryTag) {
  const p = normalizePrimaryTag(primaryTag);
  return p ? [p] : [];
}
