/**
 * 图片魔数嗅探与「发送名纠偏」。
 *
 * 背景：im-connect 后端按**文件名后缀**给消息分流（图片/视频/文件），名字与内容不符时会出两种
 * 坏结果 —— 真图片叫错名字，发出去是文件卡片（要点开才能看）；文本改名 .jpg，被当成图片发
 * 出去然后被微信拒收。这里在发送前用内容魔数「验货」，把发送名纠正成与内容一致的后缀。
 *
 * 边界（有意为之）：
 * - 只纠图片：视频格式的魔数位置不固定、场景也少，仍按后缀走。
 * - 只改「发送那一刻的文件名」——上游拿它既做分类依据又当微信里显示的文件名，两者绑死，
 *   无法只改其一；磁盘上的原文件一个字节不动。
 * - 嗅探认不出、名字也不装图片的普通文件，原样发送。
 */
import { Buffer } from 'node:buffer';

/** 图片魔数表：内容开头的「胎记」，改名也装不出来。 */
const IMAGE_SIGNATURES = [
  { kind: 'jpeg', magic: Buffer.from([0xff, 0xd8, 0xff]) },
  { kind: 'png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { kind: 'gif', magic: Buffer.from('GIF8', 'latin1') }, // 覆盖 GIF87a / GIF89a
  // BMP **不在**这张表里：它的签名只有 "BM" 两个字节，光靠它会把文本误判成图片。见 sniffBmp。
];

/** BMP 的 DIB 头大小：BITMAPCOREHEADER(12) / BITMAPCOREHEADER2(16) / INFOHEADER(40) / V2(52) / V3(56) / V4(108) / V5(124)。 */
const BMP_DIB_HEADER_SIZES = new Set([12, 16, 40, 52, 56, 108, 124]);

/**
 * BMP 单独判定（结构校验，不只是签名）。
 *
 * 为什么不能像其它格式那样只比魔数：BMP 的签名是 "BM" 两个字节，任何以 BM 开头的文本
 * （`BMC 集群巡检报告.txt`、一段 Base64、CSV 的第一格）都会被认成图片，接着被改名成
 * `.bmp` 按图片消息发出去 —— 微信那边要么拒收，要么给出一张打不开的"图片"。
 * 2 字节签名在 16 万种两字节组合里撞上的概率并不低，这不是理论风险。
 *
 * 所以再校验 BITMAPFILEHEADER 里两处结构：
 *   · 偏移 6–9 的保留字段必须是 0（真 BMP 一律为 0，文本几乎不可能正好是两个 NUL）；
 *   · 偏移 14–17 的 DIB 头大小必须是上面那几个已知值之一。
 *
 * 取舍：宁可漏认一个畸形 BMP（退回按文件发送，对方照样收得到内容，只是没有预览），
 * 也不要把文本当图片发出去 —— 后者的表现是"发不出去"或"收到一张坏图"，难查得多。
 */
function sniffBmp(bytes) {
  if (bytes.length < 18) return false;
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) return false; // 'BM'
  if (bytes[6] !== 0 || bytes[7] !== 0 || bytes[8] !== 0 || bytes[9] !== 0) return false;
  return BMP_DIB_HEADER_SIZES.has(bytes.readUInt32LE(14));
}

/** 魔数认不出来时的兜底依据（例如上游新增的图片容器）。 */
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/** 嗅探出的图片类型 → 纠偏用的规范后缀。 */
const SNIFFED_EXTENSIONS = {
  jpeg: '.jpg',
  png: '.png',
  gif: '.gif',
  webp: '.webp',
  bmp: '.bmp',
};

/**
 * 按内容认图片类型（jpeg / png / gif / webp / bmp），认不出返回 null。
 *
 * WebP 是 RIFF 容器：前 4 字节 RIFF、第 8–12 字节 WEBP，中间是长度，不能整段比对。
 * BMP 要做结构校验（签名只有 2 字节），也不能只比对魔数 —— 两者都单独判，见各自实现。
 */
export function sniffImageKind(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  for (const { kind, magic } of IMAGE_SIGNATURES) {
    if (bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic)) {
      return kind;
    }
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  if (sniffBmp(bytes)) return 'bmp';
  return null;
}

/** 取扩展名（与上游 guessExt 的规则一致：认不出用 .bin，于是落在「文件」那一支）。 */
export function extensionOf(name) {
  const matched = name.match(/\.([a-zA-Z0-9]+)$/);
  return matched ? `.${matched[1].toLowerCase()}` : '.bin';
}

/** 把文件名的扩展名换成 ext（原名没有扩展名就直接追加）。 */
export function withExtension(fileName, ext) {
  return `${fileName.replace(/\.[a-zA-Z0-9]+$/, '')}${ext}`;
}

/**
 * 验货并纠正「发送名」：让 im-connect 按内容而不是按被误命名的后缀分流。
 *
 * 返回 `{ name, corrected, note }`：name 是建议的发送名（不需要纠时就是原名），
 * corrected 表示是否改了名，note 是给日志的一句话（不需要纠时为空）。
 */
export function correctOutgoingImageName(fileName, bytes) {
  const ext = extensionOf(fileName);
  const sniffed = sniffImageKind(bytes);
  const sniffedExt = sniffed !== null ? SNIFFED_EXTENSIONS[sniffed] : undefined;

  if (sniffedExt !== undefined) {
    // 内容是图片：名字已是图片类（.jpg/.jpeg/.png/…）就不动 —— 上游都按图片发，
    // 微信转码按实际内容识别；强行把 .jpeg「规范」成 .jpg、或把顶着 .jpg 名的 PNG 纠成
    // .png，都只是改名没有收益。名字不像图片才纠正，让它按图片消息发（可直接预览）。
    if (IMAGE_EXTENSIONS.has(ext)) return { name: fileName, corrected: false, note: '' };
    const name = withExtension(fileName, sniffedExt);
    return {
      name,
      corrected: true,
      note: `内容是 ${sniffedExt} 图片但扩展名是 ${ext}，已改按 ${name} 以图片消息发送`,
    };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    // 名字装成图片、内容不是：换 .bin 按文件发，免得被微信当图片拒收（对方点开仍能看内容）。
    const name = withExtension(fileName, '.bin');
    return {
      name,
      corrected: true,
      note: `扩展名 ${ext} 像图片但内容不是，已改按 ${name} 以文件发送`,
    };
  }

  return { name: fileName, corrected: false, note: '' };
}
