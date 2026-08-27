# xiao_nrf54_updater

A standalone BLE DFU client that runs on a **Seeed XIAO nRF54LM20A** and flashes Nordic-format firmware bundles to *other* nRF52/nRF54 devices over Bluetooth.

Drop firmware bundles onto it once, then flash targets in the field with no
laptop — it is a phone, or nothing at all.

## Quick start (no toolchain needed)

Everything below happens in **[the web client](https://recrof.github.io/xiao_nrf54_updater/)**.
It needs Chrome or Edge on desktop or Android — Firefox and Safari have neither
Web Bluetooth nor WebUSB. Nothing to install; it is a PWA, so you can install
it and it keeps working with no network.

### 1. Put the updater firmware on the XIAO

Only needed once, or when updating the updater itself.

1. Plug the XIAO into USB.
2. Open the web client and press **Flash updater** — the first button, and the
   only one that works before anything is connected.
3. **Connect probe**, pick the board from the browser's device chooser.
4. **Flash newest**. It downloads the current release, writes it, reads every
   byte back to verify, and resets the board.

To flash a build of your own instead, use **Flash custom .hex** and pick
`merged.hex`. Not `zephyr.hex` — that one has no bootloader under it and will
not boot; the client refuses it and says so.

### 2. Put firmware bundles on it

1. Everything from here is over Bluetooth, so the XIAO no longer needs a
   computer — only power. See [Powering it](#powering-it) below.
2. Press **Connect** and pick `XIAO nRF54 updater`.
3. **Upload** your Nordic DFU `.zip` bundles. They live on the 8 MB flash, so
   keep a library of them.

### 3. Flash a target

- **Flash** next to a specific `.zip` sends exactly that bundle.
- **Auto flash** scans first and picks the bundle by matching the target's
  advertised name against the rules in `ble_firmware_mapping` — useful when
  one updater carries firmware for several devices. Set the rules under
  **Config** first.

Either way the updater scans, connects, triggers the target's bootloader,
streams the image, validates and activates it. Watch the LED (green = running,
solid = done) or open **Log**.

### 4. When something goes wrong

- **Log** reads the device's own log files off the flash — filterable by
  level, and the only record you get when the board is running untethered with
  no serial console attached.
- **Config** edits `config.txt` with every key explained behind its (i). It is
  re-read before *every* DFU attempt, so a fix applies to the next retry
  without a reboot.
- **Reboot** restarts the updater.

The device also speaks standard SMP, so Nordic's
[nRF Connect Device Manager](https://play.google.com/store/apps/details?id=no.nordicsemi.android.mcumgr)
works for file transfer if you prefer it.

### Powering it

Away from a computer the XIAO still needs 5 V on USB-C or a cell on the battery
pads. Two options, and the cheap one has a catch:

- **A USB power bank.** Simplest, and no soldering — but pick one that
  **supports low-power devices** (sometimes sold as a "low-current" or
  "trickle-charge" mode, often with a button to force it on). This board draws
  a few milliamps between transfers, and most power banks watch for a minimum
  load and switch themselves off after 10–30 seconds of seeing less. The
  symptom is a device that works while you set it up and is dead when you come
  back to it, which reads as a firmware fault and is not one.
- **A LiPo cell on the battery pads.** Proper untethered operation, but the
  pads are bare: **a battery is not included and you have to solder leads to
  it.** Observe the polarity marked on the board — these pads go straight to
  the SoC's regulator, with no reverse-protection to save you.

USB-C from a laptop or a phone charger works too, and is the least fuss while
you are still setting things up.

## Repo layout

Repo root doubles as the **west workspace root** (zephcore-style). The application + `west.yml` live in `updater/`; after `west init -l updater && west update`, the NCS/Zephyr/modules trees appear as siblings of `updater/` at the repo root (all gitignored).

```
xiao_nrf54_updater/                       ← git repo root == west workspace root
  README.md
  build.sh                                # thin west wrapper
  .gitignore                              # ignores .west/, zephyr/, modules/, …
  .github/workflows/build.yml             # firmware CI: builds, merges, drafts a release
  .github/workflows/web.yml               # web CI: tests, GitHub Pages, stages release firmware
  web/                                    # the web client (Vue 3, no build step, PWA)
    js/lib/smp-client.js                  #   BLE/SMP transport, DOM-free
    js/lib/config-file.js                 #   config.txt schema, mirrored from config.c
    js/lib/cmsis-dap.js                   #   WebUSB CMSIS-DAP, for flashing this board
    js/lib/nrf54l-flash.js                #   SWD + RRAM programming
    js/lib/log-file.js                    #   /lfs1/LOG.NNNN naming + parsing
    test/                                 #   dependency-free; several cross-check the firmware
  updater/                                # the application (manifest project)
    west.yml                              # NCS revision pin (v3.4.0)
    CMakeLists.txt                        # Zephyr app entry, sets BOARD_ROOT=.
    prj.conf                              # BLE + mcumgr + LittleFS + MCUboot Kconfig
    sysbuild.conf                         # enables MCUboot (prj.conf alone is NOT enough)
    sysbuild/mcuboot.overlay              # bootloader's own DT fixes
    rram_partitions.dtsi                  # corrected slot geometry, shared by both images
    app.overlay                           # external flash, LED polarity fix
    tools/merge_hex.py                    # merged.hex, with overlap detection
    boards/seeed/xiao_nrf54lm20a/         # vendored board definition — treat as suspect,
                                          #   three bugs found in it so far
    modules/nordic-legacy-dfu/            # Legacy DFU protocol, ported from the
                                          #   Android DFU Library (C++, own README)
    src/
      main.c                              # boot + BLE + state machine loop
      led.c                               # single-LED patterns (idle / smp / dfu / ok / fail)
      storage.c                           # LittleFS confirm + default config.txt seeding
      config.c                            # config.txt parser
      ble_scanner.c                       # find a Legacy DFU peer by name / RSSI / UUID
      firmware_zip.c                      # STORED-only ZIP walker + manifest.json
      firmware_map.c                      # ble_firmware_mapping: peer name -> bundle
      dfu_client.cpp                      # connects, adapts zip -> Stream, runs the module
      dfu_runner.c                        # DFU worker thread: scan, run, retry, cooldown
      fsx_mgmt.c                          # custom SMP group 64 (ls/mkdir/rm/mv/statvfs/dfu)
      fsx_stream.c                        # fast-upload GATT service
      upload_hook.c                       # SMP fs_mgmt access-hook (auto-arm now a no-op)
      dfu_client.h                        # enum dfu_result — the C boundary the runner uses
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
./build.sh                # build (also writes updater/build/merged.hex)
./build.sh -p             # pristine rebuild
./build.sh merge          # regenerate merged.hex only
./build.sh flash          # flash both images over the SAMD11 CMSIS-DAP bridge
./build.sh menuconfig     # open Kconfig menuconfig
./build.sh clean          # rm -rf updater/build
```

To test a local build through the web client's **Flash newest** button instead
of a probe, stage it where the client looks:

```bash
node web/tools/stage-firmware.mjs   # -> web/firmware/{merged.hex,manifest.json}
```

Or invoke west directly:

```bash
west build -b xiao_nrf54lm20a/nrf54lm20a/cpuapp updater --build-dir updater/build
west flash --build-dir updater/build   # flashes mcuboot then the app, per domains.yaml
```

The web client needs no build step at all — open `web/index.html` from any
static server. `node web/tools/build-single.mjs` inlines it into one
`web/dist/updater.html` for hosting as a single file.

The board target uses **Zephyr's HW-model-v2 identifier** — `<board>/<soc>/<variant>`. The XIAO nRF54LM20A carrier has one SoC (`nrf54lm20a`) with two cores, but this project only targets the application core (`cpuapp`). Board files under `updater/boards/seeed/xiao_nrf54lm20a/` are vendored from [Seeed-Studio/platform-seeedboards](https://github.com/Seeed-Studio/platform-seeedboards); we make them visible to sysbuild via `updater/sysbuild.cmake` (adds the app dir to `BOARD_ROOT`), which is needed because sysbuild resolves the board *before* the app's own CMakeLists is processed.

## Build outputs

Sysbuild builds two images and nests them per domain, so there is no single
`build/zephyr/` any more:

| File | Purpose |
|---|---|
| `updater/build/merged.hex` | **The one to flash.** MCUboot + the signed application, built by `build.sh` |
| `updater/build/dfu_application.zip` | OTA bundle for updating the updater over BLE |
| `updater/build/updater/zephyr/zephyr.signed.hex` | Application alone — links at `0x10000`, **does not boot without MCUboot under it** |
| `updater/build/mcuboot/zephyr/zephyr.hex` | Bootloader alone |

Releases publish `merged.hex` and `dfu_application.zip`. `zephyr.hex` is
deliberately *not* published: it is the one people would flash first and then
file a bug about.

## Config knobs

The `config.txt` file on `/lfs1/` holds the scan filter, the retry policy, and the transfer tuning. It is reloaded on every retry attempt, so edits apply mid-run. Every key is documented in the web client's Config dialog, which is generated from the same schema the firmware parses; `web/js/lib/config-file.js` is the single list. On first boot the file is seeded with sensible defaults if absent.

## TODO

- **Replace the MCUboot signing key.** The build currently signs with
  MCUboot's checked-in `root-ed25519.pem` and warns about it on every run.
  Anyone can sign an update for these devices.
- Verify the vendored `xiao_nrf54lm20a` board files against the eventual
  upstream ones and delete the local copy when they match. Three bugs have
  been found in them so far (RRAM write-buffer commit, LED polarity,
  MCUboot slot alignment) — see the traps in [CLAUDE.md](CLAUDE.md).
- Exercise the rest of the web client against hardware: large-file upload,
  download, delete, rename. Only the config editor and the DFU trigger have
  been driven end to end.
- Transfer tuning that has never been measured: `erase_pause_ms` at 85 rather
  than 100 (~1.7 s faster per image if the erase really is ~85 ms), and
  `erase_inflight` at 2–3. Both are config-only, so each costs one run.
- Buttonless-trigger handling is flashed but only lightly exercised — it needs
  a target that starts in application mode.

Closed, recorded so they are not re-opened: radio contention was ruled out as
the throughput limiter (it was the peer's 8-slot ring, see Trap 4), and
writing the reboot-inducing op codes without a response is not available — the
target's DFU control point advertises `props=0x18`, with no
`WRITE_WITHOUT_RESPONSE`.

## Background

The rest of this is why the project looks the way it does. None of it is
needed to use the tool.

### Why a separate project?

**Not because the chip lacks USB** — the nRF54LM20A actually has native HS-USB, marketed as a first for the nRF54L line. The catch is at the *carrier board* level: on the Seeed XIAO nRF54LM20A, the USB-C connector is wired to an on-board SAMD11 running CMSIS-DAP firmware (used for flashing + debug + a CDC log stream), **not** to the nRF54's native USB pins. The chip's USB peripheral is broken out to the XIAO headers but not to a connector.

So on stock XIAO hardware there's no path from "drop a `.zip` on a USB drive that the nRF54 exposes" — the SAMD11 is in the middle of every USB-C conversation. That's what pushes this project to a BLE-first UX: instead of dropping files onto a USB drive, we expose an **SMP (Simple Management Protocol) transport over BLE**. Firmware zips, `config.txt`, and the rotating `LOG.0000`–`LOG.0002` files all live on the on-board 8 MB QSPI flash as LittleFS files. To manage them you use the web client, or Nordic's official **[nRF Connect Device Manager](https://play.google.com/store/apps/details?id=no.nordicsemi.android.mcumgr)** app (Android/iOS).

Because SMP is a Zephyr subsystem, this project is built with the **Nordic Connect SDK (NCS)** rather than Arduino / PlatformIO. That's the reason it's a separate repo: the two projects share no build system, no BLE library, and no filesystem layer. If a future custom carrier (or a Seeed variant) ever routes the nRF54's native HS-USB to a USB-C jack, we could add USB MSC + USB CDC transports alongside the BLE one without changing the rest of the stack.

The SAMD11 is not a total loss, though. It speaks CMSIS-DAP, and a CMSIS-DAP
v2 interface is something WebUSB is allowed to claim — which is what lets the
web client flash this board's own firmware with nothing installed.

### File-manager UX

The stock nRF Connect Device Manager Files tab is intentionally spartan — SMP's built-in `fs_mgmt` group only supports upload/download/delete/status/hash. There's no `ls`, no `mkdir`, no `mv`, no free-space query.

This project extends SMP with a small custom group — **`fsx_mgmt`** — that fills those gaps. It's a superset: `fs_mgmt` keeps working exactly as before, so nRF Connect Device Manager, AuTerm, and mcumgr CLI are unaffected. Clients that understand the extension get a real file manager on top — which
is what the web client is.

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

## References

- [Nordic nRF Connect Device Manager](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/samples/mcumgr_smp_svr.html) — the phone/PC clients this project targets
- [Zephyr mcumgr subsystem](https://docs.zephyrproject.org/latest/services/device_mgmt/mcumgr.html) — SMP protocol reference
- [MCUboot documentation](https://docs.mcuboot.com/) — dual-slot bootloader used for self-updating
