# xiao_nrf54_updater

A standalone BLE DFU client that runs on a **Seeed XIAO nRF54LM20A** and flashes Nordic-format firmware bundles to *other* nRF52/nRF54 devices over Bluetooth. Companion to [xiao_nrf52_updater](../xiao_nrf52_updater) — same job, different hardware constraints.

## Why a separate project?

**Not because the chip lacks USB** — the nRF54LM20A actually has native HS-USB, marketed as a first for the nRF54L line. The catch is at the *carrier board* level: on the Seeed XIAO nRF54LM20A, the USB-C connector is wired to an on-board SAMD11 running CMSIS-DAP firmware (used for flashing + debug + a CDC log stream), **not** to the nRF54's native USB pins. The chip's USB peripheral is broken out to the XIAO headers but not to a connector.

So on stock XIAO hardware there's no path from "drop a `.zip` on a USB drive that the nRF54 exposes" — the SAMD11 is in the middle of every USB-C conversation. That's what pushes this project to a different UX than the nRF52 sibling: instead of dropping files onto a USB drive, we expose an **SMP (Simple Management Protocol) transport over BLE**. Firmware zips, `config.txt`, and `LOG.TXT` all live on the on-board 8 MB QSPI flash as LittleFS files. To manage them you use Nordic's official **[nRF Connect Device Manager](https://play.google.com/store/apps/details?id=no.nordicsemi.android.mcumgr)** app (Android/iOS) — file browser, log viewer, and image DFU all built in.

Because SMP is a Zephyr subsystem, this project is built with the **Nordic Connect SDK (NCS)** rather than Arduino / PlatformIO. That's the reason it's a separate repo: the two projects share no build system, no BLE library, and no filesystem layer. If a future custom carrier (or a Seeed variant) ever routes the nRF54's native HS-USB to a USB-C jack, we could add USB MSC + USB CDC transports alongside the BLE one without changing the rest of the stack.

## File-manager UX

The stock nRF Connect Device Manager Files tab is intentionally spartan — SMP's built-in `fs_mgmt` group only supports upload/download/delete/status/hash. There's no `ls`, no `mkdir`, no `mv`, no free-space query.

This project extends SMP with a small custom group — **`fsx_mgmt`** — that fills those gaps. It's a superset: `fs_mgmt` keeps working exactly as before, so nRF Connect Device Manager, AuTerm, and mcumgr CLI are unaffected. Clients that understand the extension get a real file manager on top.

**Server side**: `updater/src/fsx_mgmt.{c,h}`. Registers as MGMT group **64** (`MGMT_GROUP_ID_PERUSER`) with six commands — `list`, `mkdir`, `rmdir`, `move`, `statvfs`, `trigger_dfu`. Wire format is CBOR, same as every other SMP group. See `fsx_mgmt.h` for the per-command request/response schemas.

**Client side**: [`web/`](web/) — a small Vue 3 app that speaks both stock `fs_mgmt` (upload/download/delete) and our `fsx_mgmt` (browse/mkdir/rename), plus the `fsx_stream` fast-upload service and a `config.txt` editor. Uses the browser's Web Bluetooth API, no install, no accounts.

There is **no build step**. It's plain ES modules and a vendored full Vue build (template compiler included), so editing a file and reloading the page is the entire development loop:

```
web/index.html            shell — loads the CSS and js/main.js
web/css/*.css             tokens / base / layout / config
web/js/lib/cbor.js        CBOR codec (the SMP wire format)
web/js/lib/smp-client.js  BLE transport + SMP framing + fsx wrappers — no DOM
web/js/lib/config-file.js config.txt schema, parser, serializer
web/js/store.js           app state + actions
web/js/components/*.js    one file per piece of UI
web/vendor/               Vue 3.5.40, vendored (pinned, works offline)
web/test/*.test.mjs       run with plain `node`
web/tools/build-single.mjs  bundles everything into one self-contained file
```

`lib/smp-client.js` is deliberately UI-free — it emits `log` / `disconnected` / `stream` events instead of touching the DOM, so it can be reused from any front end.

**How to open it**:

- Chrome or Edge on Android / macOS / Windows / Linux (iOS Safari does not implement Web Bluetooth).
- Web Bluetooth needs a secure context, so `file://` won't work. Use the GitHub Pages deployment (`https://<owner>.github.io/<repo>/`, published by [`.github/workflows/web.yml`](.github/workflows/web.yml) on every push to `main`), or serve `web/` over local HTTPS.
- Prefer one file? `node web/tools/build-single.mjs` produces `web/dist/updater.html` with the CSS, JS, and Vue all inlined — no external requests. CI publishes the same file to `…/updater.html` and as a workflow artifact.
- Click `Connect`, pick `XIAO nRF54 updater` from the browser's device picker, browse `/lfs1/`.

**Editing the config**: the `Config…` button, or a click on `config.txt` in the listing, opens a form over `/lfs1/config.txt` showing every key with its description, its firmware default (click the chip to restore it), and live validation. Only the real `/lfs1/config.txt` opens the editor; a copy in another directory still downloads, since that isn't a file the firmware reads. The filename is always lowercase — uploading one named `CONFIG.TXT` is redirected to `config.txt` (and logged), because LittleFS is case-sensitive and the firmware would silently never read the uppercase one. Values the firmware would silently reject are blocked rather than written, and the encoded size is checked against the parser's 1023-byte buffer. Unknown keys in the file are preserved on save.

## Workflow

1. Power up the XIAO nRF54. It advertises as `XIAO nRF54 updater`.
2. Open **nRF Connect Device Manager** on your phone, connect to it.
3. **Files** tab → upload your firmware `.zip` to `/lfs1/` (drag-and-drop equivalent).
4. Trigger the flash explicitly — the web client's per-zip **flash** button, which sends `fsx_mgmt.trigger_dfu`. The updater then scans for the configured `ble_name` and streams the zip to the target using the ported Legacy DFU client. (Auto-arm on upload was removed: it fires on `config.txt` edits and half-finished uploads too.)
5. On success, LED goes solid. The `.zip` stays on the flash (8 MB is plenty; the drone use case likes keeping a library).
6. To read `LOG.TXT` or update `config.txt`, use the same Files tab.
7. Firmware for the *updater itself* is OTA-upgradeable via nRF Connect Device Manager's **Image** tab (MCUboot dual-slot).

## What's in the box

| Component | Role |
|---|---|
| **SMP over BLE** | mcumgr transport — file upload/download/delete + image DFU + log viewer, all via nRF Connect Device Manager |
| **LittleFS** | 8 MB PY25Q64 external flash, mounted at `/lfs1`, wear-leveled |
| **BLE central** | Zephyr `bt_gatt_discover` — Legacy DFU client (ported from nRF52 project) |
| **MCUboot** | Dual-slot bootloader so the updater can update itself over BLE |
| **fsx_stream** | Custom GATT byte-stream service for fast uploads (~59 KB/s vs ~10 KB/s over SMP) |

## Repo layout

Repo root doubles as the **west workspace root** (zephcore-style). The application + `west.yml` live in `updater/`; after `west init -l updater && west update`, the NCS/Zephyr/modules trees appear as siblings of `updater/` at the repo root (all gitignored).

```
xiao_nrf54_updater/                       ← git repo root == west workspace root
  README.md
  build.sh                                # thin west wrapper
  .gitignore                              # ignores .west/, zephyr/, modules/, …
  .github/workflows/build.yml             # CI mirrors the local layout
  updater/                                # the application (manifest project)
    west.yml                              # NCS revision pin (v3.4.0)
    CMakeLists.txt                        # Zephyr app entry, sets BOARD_ROOT=.
    prj.conf                              # BLE + mcumgr + LittleFS + MCUboot Kconfig
    boards/seeed/xiao_nrf54lm20a/         # local board definition (in case NCS doesn't ship one)
      board.yml
      Kconfig.xiao_nrf54lm20a
      xiao_nrf54lm20a.dts
      xiao_nrf54lm20a-pinctrl.dtsi
      xiao_nrf54lm20a_defconfig
    src/
      main.c                              # boot + BLE + state machine loop
      led.c                               # single-LED patterns (idle / smp / dfu / ok / fail)
      storage.c                           # LittleFS confirm + default config.txt seeding
      upload_hook.c                       # SMP fs_mgmt access-hook (auto-arm now a no-op)
      app.h                               # shared types/protos

  # ↓ pulled in by `west update`, all gitignored ↓
  .west/                                  # workspace marker (path=updater)
  zephyr/                                 # Zephyr tree
  modules/                                # HAL, crypto, mbedTLS, …
  bootloader/                             # MCUboot
  nrf/                                    # Nordic Connect SDK
  nrfxlib/                                # Nordic closed-source libs
  tools/                                  # NCS tooling
```

## Development setup

Requires the Nordic Connect SDK v3.4.0 or later (earlier versions lack `nrf54lm20a_cpuapp.dtsi`; v3.0.0 ships it as `_enga_`) and the `west` tool. The setup follows the [zephcore](https://github.com/liquidraver/zephcore) layout: **repo root is the west workspace root**, the app lives in `updater/`, and `west update` populates `zephyr/`, `modules/`, `bootloader/`, `nrf/`, `nrfxlib/`, `tools/` as siblings of `updater/` at the repo root (all gitignored).

### One-time setup

```bash
git clone <this repo url> xiao_nrf54_updater
cd xiao_nrf54_updater

# west init -l points at the manifest project directory (the one containing
# west.yml), NOT at a git URL — no network fetch here, just marks this
# folder as a workspace.
west init -l updater

# Pulls Zephyr, NCS, MCUboot, modules, tools as siblings of updater/.
# Shallow + narrow to keep it under a few GB.
west update --narrow -o=--depth=1

# Optional: export Zephyr's CMake package so out-of-workspace tools can
# find it too. Safe to skip if you only use `./build.sh`.
west zephyr-export
```

> **After bumping `updater/west.yml`** (e.g. NCS revision changes): re-run `west update --narrow -o=--depth=1` — the workspace trees don't self-update.

You should have a Python venv with `west` installed, plus the Zephyr SDK on `PATH`. The [Nordic Connect SDK installation guide](https://docs.nordicsemi.com/bundle/ncs-latest/page/nrf/installation/install_ncs.html) walks through both. Alternatively, install the [nRF Connect for VS Code extension](https://marketplace.visualstudio.com/items?itemName=nordic-semiconductor.nrf-connect); its toolchain manager creates the Python env + SDK for you, and this repo opens directly as an "application" in the extension.

### Everyday build / flash

Via the `build.sh` wrapper:

```bash
./build.sh                # build for xiao_nrf54lm20a/nrf54lm20a/cpuapp (default)
./build.sh -p             # pristine rebuild
./build.sh flash          # flash the last build over the SAMD11 CMSIS-DAP bridge
./build.sh menuconfig     # open Kconfig menuconfig
./build.sh clean          # rm -rf updater/build
```

Or invoke west directly:

```bash
west build -b xiao_nrf54lm20a/nrf54lm20a/cpuapp updater --build-dir updater/build
west flash --build-dir updater/build
```

The board target uses **Zephyr's HW-model-v2 identifier** — `<board>/<soc>/<variant>`. The XIAO nRF54LM20A carrier has one SoC (`nrf54lm20a`) with two cores, but this project only targets the application core (`cpuapp`). Board files under `updater/boards/seeed/xiao_nrf54lm20a/` are vendored from [Seeed-Studio/platform-seeedboards](https://github.com/Seeed-Studio/platform-seeedboards); we make them visible to sysbuild via `updater/sysbuild.cmake` (adds the app dir to `BOARD_ROOT`), which is needed because sysbuild resolves the board *before* the app's own CMakeLists is processed.

### Common pitfall: `west init` in the wrong place

Two mistakes to avoid:

- **`west init` inside `updater/`** — makes the app dir the workspace root; NCS/Zephyr end up cloned as children of `src/`. Recover with `rm -rf updater/.west updater/zephyr updater/modules updater/bootloader updater/tools updater/nrf updater/nrfxlib updater/build`.
- **`west init` at the repo root without `-l updater`** — no `-l` means west tries to fetch its default manifest (upstream Zephyr) instead of ours. Recover with `rm -rf .west zephyr modules bootloader tools nrf nrfxlib build` and rerun with `-l updater`.

`.gitignore` covers all the workspace-created dirs, so an accidental init won't pollute the git tree — it just eats disk.

## Build outputs

`west build` produces (under `build/zephyr/`):

| File | Purpose |
|---|---|
| `zephyr.hex` / `zephyr.bin` | Full-image flash via SWD / CMSIS-DAP |
| `app_update.bin` | MCUboot-signed image for OTA — upload via nRF Connect Device Manager → Image tab |
| `dfu_application.zip` | mcumgr-compatible DFU bundle bundling the signed app image |

## Config knobs

The `config.txt` file on `/lfs1/` mirrors the schema of the nRF52 project — same keys, same semantics — because the ported Legacy DFU client uses the same struct, plus `pkt_gap_ms` (inter-packet pacing) which is nRF54-only. It is reloaded on every retry attempt, so edits apply mid-run. See the [nRF52 project README](../xiao_nrf52_updater/README.md#configtxt) for the full documented list. On first boot the file is seeded with sensible defaults if absent.

## Status of this repo

**Working end-to-end.** Boots, mounts LittleFS, exposes SMP + `fsx_mgmt` + `fsx_stream` over BLE, and runs the full Nordic Legacy DFU client as central — discover, buttonless trigger, MAC+1 rescan, stream, `VALIDATE`, `ACTIVATE`, peer reboot. Verified against a RAK4631. See [CLAUDE.md](CLAUDE.md) for tuning data and known traps.

## TODO

- Port `dfu_legacy` (Legacy DFU control-point + packet-point state machine) from the nRF52 project onto Zephyr `bt_gatt`.
- Port `ble_scanner` name-matching + pipe-delimited filter + MAC+1 fallback.
- Port `firmware_zip.c` (STORE-only manifest walker) — SdFat File objects become Zephyr `fs_file_t`.
- Port `config.c` parser — same format, `fs_read()` instead of `File::fgets()`.
- Wire GH Actions to Nordic's official NCS container.
- Verify the `xiao_nrf54lm20a` board files against the eventual upstream ones and delete the local copy when they match.

## References

- [Nordic nRF Connect Device Manager](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/samples/mcumgr_smp_svr.html) — the phone/PC clients this project targets
- [Zephyr mcumgr subsystem](https://docs.zephyrproject.org/latest/services/device_mgmt/mcumgr.html) — SMP protocol reference
- [MCUboot documentation](https://docs.mcuboot.com/) — dual-slot bootloader used for self-updating
- [xiao_nrf52_updater](../xiao_nrf52_updater) — the USB-native sibling project
