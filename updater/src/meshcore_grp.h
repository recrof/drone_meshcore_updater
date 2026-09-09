/*
 * MeshCore group-text (GRP_TXT) packet encoder.
 *
 * Builds one complete LoRa frame carrying a plain-text message on a MeshCore
 * group channel, ready to hand to lora_send(). Transmit only: there is no
 * receive path, no routing table, no mesh state and no acknowledgement. The
 * packet goes out as ROUTE_TYPE_FLOOD with an empty path, which is what makes
 * every repeater in earshot rebroadcast it.
 *
 * ---- What this is not --------------------------------------------------
 *
 * It is not MeshCore. MeshCore is an Arduino/RadioLib C++ codebase and cannot
 * be linked into a Zephyr application; this is a from-scratch encoder for one
 * packet type, written against the wire format rather than the code. Every
 * constant below was read out of MeshCore 1.17.1 and is cited where it is
 * used, because a value that is wrong here produces a packet that transmits
 * successfully and is silently discarded by every node that hears it.
 *
 * ---- The frame ---------------------------------------------------------
 *
 *   off  size  field
 *    0     1   header = (PAYLOAD_TYPE_GRP_TXT << 2) | route
 *                          ROUTE_TYPE_FLOOD (0x01) unscoped -> 0x15, or
 *                          ROUTE_TYPE_TRANSPORT_FLOOD (0x00) scoped -> 0x14,
 *                          which inserts the four bytes below.
 *  [1     4   transport codes, scoped only: two LE uint16. Repeaters match
 *                          code 0; code 1 is written and never read.]
 *    1     1   path_len                bits 7-6 = hash size - 1, bits 5-0 = hop
 *                                       count. Ours starts with no hops; the
 *                                       size is the SENDER's choice and every
 *                                       repeater that relays the packet appends
 *                                       that many bytes of its own hash.
 *    2     1   channel hash            sha256(key)[0]
 *    3     2   MAC                     HMAC-SHA256(key||zeros, ciphertext)[0:2]
 *    5    ..   ciphertext              AES-128-ECB, zero-padded to 16
 *
 * and the plaintext inside the ciphertext:
 *
 *    0     4   timestamp, little-endian, seconds
 *    4     1   flags = 0x00            TXT_TYPE_PLAIN
 *    5    ..   "<sender>: <text>"      no NUL terminator in the counted length
 *
 * Sources: Packet.h (header bit layout), Packet.cpp:52 (writeTo),
 * Mesh.cpp:540 (createGroupDatagram), Utils.cpp:85/127 (encrypt,
 * encryptThenMAC), BaseChatMesh.cpp:487 (sendGroupMessage),
 * helpers/TxtDataHelpers.h (TXT_TYPE_PLAIN).
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

#ifndef MESHCORE_GRP_H
#define MESHCORE_GRP_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* MeshCore's CIPHER_KEY_SIZE for group channels (MeshCore.h). */
#define MESHCORE_KEY_LEN 16

/* MAX_TEXT_LEN, BaseChatMesh.h: 10 * CIPHER_BLOCK_SIZE. This bounds the
 * "<sender>: <text>" string *together*, not the message alone — a long sender
 * name is paid for out of the message. */
#define MESHCORE_MAX_TEXT_LEN 160

/* Longest frame this can emit: 2 header bytes + 1 channel hash + 2 MAC +
 * ciphertext over a 165-byte plaintext rounded up to 176. Comfortably inside
 * MeshCore's MAX_PACKET_PAYLOAD (184) and a LoRa MAX_TRANS_UNIT (255). */
/* Four more than unscoped, for the transport codes. */
#define MESHCORE_GRP_MAX_FRAME 185

/* Path hash width, in bytes, that repeaters will use when relaying our packet.
 *
 * MeshCore packs this into the top two bits of the path_len byte
 * (Packet.h:83, setPathHashSizeAndCount), so it travels with the packet and
 * the relays read it back out — it is not a property of the mesh that has to
 * be agreed in advance. Nodes expose the same thing as the `hash_mode` CLI
 * setting, where mode N means N+1 bytes.
 *
 * 4 is rejected by MeshCore's own isValidPathLen() as reserved, so the usable
 * range is 1 to 3. Wider costs one extra byte per hop and buys attribution:
 * at one byte, two repeaters in the same path collide often enough that a
 * listener cannot always say which of them relayed. */
#define MESHCORE_PATH_HASH_MIN 1
#define MESHCORE_PATH_HASH_MAX 3

/*
 * Derive a hashtag channel's key: the first 16 bytes of SHA-256 over the
 * channel name *including its leading '#'*.
 *
 * A name arriving without the '#' gets one, matching MeshCore's own
 * "implicit auto hashtag" handling (RegionMap.cpp:180), so `drone-updater`
 * and `#drone-updater` in config.txt mean the same channel.
 *
 * ⚠ The '#' is part of the hashed string. Known-answer, from MeshCore's
 * docs/companion_protocol.md:441 — sha256("#test")[0:16] is
 * 9cd8fcf22a47333b591d96a2b848b73f. Hashing "test" instead yields
 * 9f86d081… and a channel nobody is listening on.
 *
 * Returns 0, or -EINVAL for an empty or over-long name.
 */
int meshcore_channel_key_from_name(const char *name,
				   uint8_t key[MESHCORE_KEY_LEN]);

/*
 * The 1-byte channel identifier that rides in clear at the front of the
 * payload: sha256(key)[0]. Receivers use it to pick which keys are worth
 * trying, so it is a hint and not a guarantee — collisions are expected and
 * the MAC is what actually decides.
 *
 * Returns the byte, or 0 on a crypto failure; a caller that needs to tell
 * those apart should call mc_sha256 itself.
 */
uint8_t meshcore_channel_hash(const uint8_t key[MESHCORE_KEY_LEN]);

/*
 * Derive a transport (region) key: sha256(name)[0:16], with a '#' supplied if
 * the name lacks one — MeshCore's RegionMap::getTransportKeysFor() prepends it
 * to a bare region name before hashing, so "YVR" and "#YVR" are the same
 * region and this matches either spelling.
 */
int meshcore_region_key_from_name(const char *name, uint8_t key[MESHCORE_KEY_LEN]);

/*
 * Encode one GRP_TXT frame into `out`.
 *
 * `timestamp`  seconds; MeshCore calls this "mostly an extra blob to help make
 *              packet_hash unique" (BaseChatMesh.cpp:488), but clients render
 *              it as the message time. A device with no RTC should still vary
 *              it per message, or repeaters will suppress two identical
 *              messages as duplicates of one packet.
 * `sender`     the name shown before the colon.
 * `text`       the message. Truncated, with `sender`, at MESHCORE_MAX_TEXT_LEN.
 * `path_hash`  1..3, the hash width relays should append. See above.
 * `region_key` NULL for an ordinary flood. Otherwise a 16-byte region key: the
 *              frame becomes a TRANSPORT_FLOOD carrying a transport code, and a
 *              repeater forwards it only if it holds that region.
 *
 *              ⚠ Enforced by `simple_repeater` only. `simple_room_server`
 *              computes the region and never checks it; `companion_radio` in
 *              repeat mode has no region concept at all. On a mixed mesh this
 *              narrows the flood, it does not gate it.
 *
 * Returns the frame length in bytes, or -EINVAL / -ENOMEM / -EIO.
 */
int meshcore_grp_txt_encode(const uint8_t key[MESHCORE_KEY_LEN],
			    uint32_t timestamp, const char *sender,
			    const char *text, uint8_t path_hash,
			    const uint8_t *region_key, uint8_t *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* MESHCORE_GRP_H */
