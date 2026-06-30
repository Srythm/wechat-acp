/**
 * Send messages via WeChat iLink API.
 */

import crypto from "node:crypto";
import path from "node:path";
import { sendMessage, getUploadUrl } from "./api.js";
import { MessageType, MessageState, MessageItemType, UploadMediaType } from "./types.js";
import { uploadToCdn } from "./media.js";

export interface WeixinSendOpts {
  baseUrl: string;
  token?: string;
  contextToken?: string;
}

export interface WeixinImageSendOpts extends WeixinSendOpts {
  cdnBaseUrl: string;
}

/**
 * 图片扩展名集合，用于从 agent 回复文本中识别本地图片文件引用。
 * 仅识别这些扩展名，避免误把普通文件路径当图片处理。
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

export interface ExtractedImage {
  /** 解析后的绝对路径，用于读取文件 */
  absPath: string;
  /** 在原文本中的完整匹配片段（用于从文本里移除） */
  rawMatch: string;
}

/**
 * 从 agent 回复文本中提取本地图片文件引用。
 *
 * 支持的引用格式（按优先级匹配，先匹配到的优先）：
 *   1. Markdown 图片语法: ![alt](path) 或 ![](path)
 *      路径可以是 file:///abs/path、绝对路径、或相对路径
 *   2. file:// URL: file:///abs/path/to/image.png
 *   3. 裸路径（最后兜底）: /abs/path/to/img.png 或 ./img.png 或 img.png
 *      仅在路径带有图片扩展名时匹配，避免误抓普通单词
 *
 * @param text agent 回复文本
 * @param baseDir 用于解析相对路径的基准目录（通常是 agent 的 cwd）
 * @returns 提取到的图片列表；同一文本中每个唯一路径只返回一次
 */
export function extractImagePaths(text: string, baseDir: string): ExtractedImage[] {
  const results: ExtractedImage[] = [];
  const seen = new Set<string>();
  const push = (absPath: string, rawMatch: string): void => {
    if (seen.has(absPath)) return;
    seen.add(absPath);
    results.push({ absPath, rawMatch });
  };

  // 1. Markdown 图片语法: ![alt](path)
  const mdImageRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdImageRe.exec(text)) !== null) {
    const raw = m[1].trim();
    const abs = resolveImagePath(raw, baseDir);
    if (abs && hasImageExt(abs)) {
      push(abs, m[0]);
    }
  }

  // 2. file:// URL（未被 markdown 语法包裹的）
  const fileUrlRe = /file:\/\/\/([^\s)]+)/g;
  while ((m = fileUrlRe.exec(text)) !== null) {
    const raw = m[0];
    const abs = resolveImagePath(raw, baseDir);
    if (abs && hasImageExt(abs)) {
      push(abs, raw);
    }
  }

  // 3. 裸路径兜底：只匹配明确带分隔符的路径（绝对路径或 ./ ../ 开头的相对路径），
  //    避免误抓普通单词。仅在路径带图片扩展名时才算命中。
  //    支持 Windows 盘符 (C:\...)、Unix 绝对路径 (/home/...)、./ 和 ../ 相对路径。
  const conservativeRe =
    /(^|[\s(])((?:[A-Za-z]:[\\/][^\s)]+)|(?:\/[^\s)]+)|(?:\.\.?[\\/][^\s)]+))/g;
  while ((m = conservativeRe.exec(text)) !== null) {
    const raw = m[2].trim();
    const abs = resolveImagePath(raw, baseDir);
    if (abs && hasImageExt(abs)) {
      push(abs, raw);
    }
  }

  return results;
}

/**
 * 尾部标点字符集合。裸路径正则用 `[^\s)]+` 匹配，会把句尾的句号、
 * 逗号等一并吞入，导致扩展名判断失败（如 `/path/img.png.` 的 ext 是 `.`）。
 * 在解析前 trim 这些字符。
 */
const TRAILING_PUNCT = ".,;:!?)】》」』\"'";

function resolveImagePath(raw: string, baseDir: string): string | null {
  let p = raw.trim();
  // 先去掉可能包裹的成对引号（在剥离尾部标点之前，避免误删配对引号的右半边，
  // 导致 startsWith/endsWith 配对检查失败、左半边引号残留）
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  // 再去掉尾部可能被正则一并吞入的标点（句尾路径场景，也覆盖不成对的孤立尾引号）
  p = p.replace(new RegExp(`[${TRAILING_PUNCT}]+$`), "").trimEnd();
  if (!p) return null;
  // file:// URL
  if (p.startsWith("file:///")) {
    p = p.slice("file:///".length);
    // Windows 上 file:///C:/... → C:/...
  } else if (p.startsWith("file://")) {
    p = p.slice("file://".length);
  }
  if (!p) return null;
  // 解析为绝对路径
  const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
  return abs;
}

function hasImageExt(absPath: string): boolean {
  const ext = path.extname(absPath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

export async function sendTextMessage(
  to: string,
  text: string,
  opts: WeixinSendOpts,
  clientId?: string,
  sendFn: typeof sendMessage = sendMessage,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }

  // Generate a stable idempotency key for this logical send. Callers that
  // retry should pass the same clientId so the iLink gateway de-duplicates
  // repeated deliveries of the same message segment.
  const id = clientId ?? `wechat-acp-${crypto.randomUUID()}`;
  await sendFn({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: id,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: opts.contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    },
  });
  return id;
}

/**
 * Send an image message via WeChat iLink API.
 *
 * Flow:
 *   1. Generate a per-message AES-128 key + unique filekey.
 *   2. Ask iLink for an upload URL (`getuploadurl`, media_type=IMAGE).
 *   3. AES-128-ECB encrypt the raw image bytes and POST to the CDN.
 *      The CDN responds with an opaque `encrypt_query_param` that
 *      identifies the stored (encrypted) image.
 *   4. Send a BOT message whose `item_list` carries an `image_item`
 *      referencing that CDN media, so the recipient's WeChat client
 *      fetches and decrypts it for display.
 *
 * Thumbnails are skipped (`no_need_thumb: true`) to avoid pulling in an
 * image-processing dependency; the full image is enough for display.
 */
export async function sendImageMessage(
  to: string,
  imageBuffer: Buffer,
  opts: WeixinImageSendOpts,
  clientId?: string,
  sendFn: typeof sendMessage = sendMessage,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }
  if (!opts.cdnBaseUrl) {
    throw new Error("cdnBaseUrl is required to send an image");
  }

  const id = clientId ?? `wechat-acp-${crypto.randomUUID()}`;

  // 1. AES key + filekey for this image.
  // Match the official @tencent-weixin/openclaw-weixin field formats:
  //   - aeskey passed to getUploadUrl is hex-encoded (32 chars)
  //   - filekey is 32 hex chars (16 random bytes)
  //   - aes_key in the BOT message's image_item.media is base64(hexString)
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString("hex");
  const aesKeyB64 = Buffer.from(aesKeyHex, "ascii").toString("base64");
  const filekey = crypto.randomBytes(16).toString("hex");
  const rawfilemd5 = crypto.createHash("md5").update(imageBuffer).digest("hex");

  // AES-128-ECB with PKCS7 padding: encrypted length = raw + (16 - raw%16),
  // i.e. a full extra block when raw is already block-aligned. `filesize` is
  // the size actually uploaded (encrypted), `rawsize` is the plaintext size.
  const rawSize = imageBuffer.length;
  const encryptedSize = rawSize + (16 - (rawSize % 16));

  // 2. Request an upload URL from iLink
  const uploadResp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      filekey,
      media_type: UploadMediaType.IMAGE,
      to_user_id: to,
      rawsize: rawSize,
      rawfilemd5,
      filesize: encryptedSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
    },
  });
  const upload_param = uploadResp.upload_param;

  if (!upload_param) {
    throw new Error("getUploadUrl did not return an upload_param");
  }

  // 3. Encrypt and upload the raw image to CDN
  const downloadParam = await uploadToCdn({
    buffer: imageBuffer,
    uploadParam: upload_param,
    aesKey,
    filekey,
    cdnBaseUrl: opts.cdnBaseUrl,
  });

  // 4. Send the BOT message referencing the uploaded CDN media.
  // aes_key must be base64(hexString) to match the format the official
  // client uses (Buffer.from(hexAeskey).toString("base64")), NOT base64(rawBytes).
  // mid_size is the ciphertext size, matching filesize declared to getUploadUrl.
  await sendFn({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: id,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: opts.contextToken,
        item_list: [
          {
            type: MessageItemType.IMAGE,
            image_item: {
              media: {
                encrypt_query_param: downloadParam,
                aes_key: aesKeyB64,
                encrypt_type: 1,
              },
              mid_size: encryptedSize,
            },
          },
        ],
      },
    },
  });

  return id;
}

/**
 * Split text into segments of max length, respecting line breaks where possible.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      segments.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) breakAt = maxLen;

    segments.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).replace(/^\n/, "");
  }

  return segments;
}
