import { createCipheriv, randomBytes, randomInt } from "node:crypto";

const AES_GCM_MODE = 1; // 0 = legacy CBC (deprecated by ZEGO), 1 = GCM

// ZEGOCLOUD token04, byte layout of the official zego_server_assistant (token/nodejs/token04):
// "04" + base64(expire:int64BE | nonceLen:uint16BE | nonce | cipherLen:uint16BE | AES-256-GCM(json)+authTag | mode:uint8)
export function generateToken04(appId: number, userId: string, secret: string, ttlSeconds: number, payload = "") {
  const ctime = Math.floor(Date.now() / 1000);
  const info = { app_id: appId, user_id: userId, nonce: randomInt(-(2 ** 31), 2 ** 31 - 1), ctime, expire: ctime + ttlSeconds, payload };
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, nonce);
  const enc = Buffer.concat([cipher.update(JSON.stringify(info), "utf8"), cipher.final(), cipher.getAuthTag()]);

  const buf = Buffer.alloc(8 + 2 + nonce.length + 2 + enc.length + 1);
  let o = buf.writeBigInt64BE(BigInt(info.expire), 0);
  o = buf.writeUInt16BE(nonce.length, o);
  o += nonce.copy(buf, o);
  o = buf.writeUInt16BE(enc.length, o);
  o += enc.copy(buf, o);
  buf.writeUInt8(AES_GCM_MODE, o);
  return "04" + buf.toString("base64");
}

// Privilege payload for strict auth mode: 1 = login room, 2 = publish stream.
export const roomPrivilege = (zegoRoomId: string, canPublish: boolean) =>
  JSON.stringify({ room_id: zegoRoomId, privilege: { 1: 1, 2: canPublish ? 1 : 0 }, stream_id_list: null });
