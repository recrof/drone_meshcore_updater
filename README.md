# Drone MeshCore Updater

Carry a firmware update to a device you cannot reach.

A standalone updater that runs on a **Seeed XIAO** (nRF54LM20A, nRF52840,
ESP32-S3, ESP32-C5 or MG24), holds a library of firmware bundles, and flashes them into *other*
devices over the air. It exists for MeshCore repeaters on rooftops, masts and hilltops —
put it on a drone or in a pocket, get within radio range, and update.

Today it speaks Nordic Legacy DFU over Bluetooth, which covers nRF52 targets.
Drop firmware bundles onto it once, then flash targets in the field with no
laptop — it is a phone, or nothing at all.

## Quick start (no toolchain needed)

Everything below happens in **[the web client](https://recrof.github.io/drone_meshcore_updater/)**.
It needs Chrome or Edge on desktop or Android — Firefox and Safari have neither
Web Bluetooth nor WebUSB. Nothing to install; it is a PWA, so you can install
it and it keeps working with no network.

### 1. Put the updater firmware on the XIAO

Only needed once, or when updating the updater itself.

1. Plug the XIAO into USB.
2. Open the web client and press **Flash updater** — the first button, and the
   only one that works before anything is connected.
3. Pick your board. Each one is reached a different way, and the next step
   changes with it:

   | board | what you do |
   |---|---|
   | XIAO nRF54LM20A | **Connect probe**, then pick it from the browser's chooser. Nothing to press on the board. |
   | XIAO nRF52840 | Double-tap **RESET** (the orange LED pulses), then pick the serial port. |
   | XIAO ESP32-S3 | Hold **BOOT**, tap **RESET**, release **BOOT**, then pick the serial port. |
   | XIAO ESP32-C5 | As the ESP32-S3. Bluetooth only for now — see [notes/boards.md](notes/boards.md). |
   | XIAO MG24 | **Connect probe**, as the nRF54LM20A. Nothing to press on the board. |

4. **Flash newest**. It downloads the current release, checks it against the
   published digest, writes it, reads it back to verify, and restarts the
   board.

Chrome or Edge on desktop only — Firefox and Safari have neither WebUSB nor
Web Serial, and no browser on iOS does.

Nothing here can leave you stranded. The nRF54LM20A's probe is a separate chip
that is always awake; the nRF52840's bootloader is never written by this and
also takes a `.uf2` dropped onto the drive it exposes; the ESP32-S3's ROM
loader is in silicon and cannot be erased. If a write fails, repeat the same
steps.

There is no "pick a file" option, on purpose: the ways to get it wrong all end
with a board that needs rescuing, and the person likeliest to make the mistake
is the one least likely to own a probe. To flash a build of your own, run
`./build.sh` — every build restages `web/firmware/`, so your image *is* what
**Flash newest** writes when you serve the client locally.

### 2. Put firmware bundles on it

1. Everything from here is over Bluetooth, so the XIAO no longer needs a
   computer — only power. See [Powering it](#powering-it) below.
2. Press **Connect** and pick `Drone MeshCore Updater`.
3. **Upload** your Nordic DFU `.zip` bundles. They live on the 8 MB flash, so
   keep a library of them.

### 3. Flash a target

- **Flash** next to a specific `.zip` sends exactly that bundle.
- **Auto flash** scans first and picks the bundle by matching the target's
  advertised name against the rules in `ble_firmware_mapping` — useful when
  one updater carries firmware for several devices. Set the rules under
  **Config** first.

Either way the updater scans, connects, triggers the target's bootloader,
streams the image, validates and activates it.

A progress banner appears while it runs, showing the current step, the target
it found, percentage and transfer rate, and which attempt it is on. It stays
put whether the browser was watching from the start or connected halfway
through, and **Watch log** on it opens the device log streaming live. The LED
says the same thing at a glance: green blinking = running, solid = done.

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
drone_meshcore_updater/                        ← git repo root == west workspace root
  README.md
  build.sh                                # thin west wrapper
  .gitignore                              # ignores .west/, zephyr/, modules/, …
  .github/workflows/build.yml             # firmware CI: builds, merges, drafts a release
  .github/workflows/web.yml               # web CI: tests, GitHub Pages, stages release firmware
  web/                                    # the web client (Vue 3, no build step, PWA)
    js/lib/smp-client.js                  #   BLE/SMP transport, DOM-free
    js/lib/config-file.js                 #   config.txt schema, mirrored from config.c
    js/lib/cmsis-dap.js                   #   WebUSB CMSIS-DAP, for the nRF54L board
    js/lib/nrf54l-flash.js                #   SWD + RRAM programming
    js/lib/serial.js                      #   Web Serial + SLIP, shared by both serial flashers
    js/lib/nordic-dfu-serial.js           #   Legacy DFU, for the nRF52840's bootloader
    js/lib/esptool.js                     #   ESP32-S3 / ESP32-C5 ROM loader
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
git clone <this repo url> drone_meshcore_updater
cd drone_meshcore_updater

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

### Other boards

It also builds for the **XIAO nRF52840**, the **XIAO ESP32S3**, the
**XIAO ESP32-C5** and the **XIAO MG24** — and for the **Sense** variant of the
first two. Set `BOARD`; every target gets its own build directory, so switching
does not force a pristine rebuild:

```bash
./build.sh nrf52              # -> updater/build_xiao_ble_nrf52840
./build.sh xiao_ble/nrf52840/sense
./build.sh esp32s3
./build.sh xiao_esp32s3/esp32s3/procpu/sense
./build.sh esp32c5
./build.sh mg24
```

The MG24 needs its own blob fetch (`west blobs fetch hal_silabs`) for the
Bluetooth link layer, and a non-stock OpenOCD to flash — `build.sh` finds the
Arduino Silicon Labs core's copy on its own. The **MG24 Sense is the same board
target**; there is no separate variant to build.

| | XIAO nRF54LM20A | XIAO nRF52840 | XIAO ESP32S3 | XIAO MG24 |
|---|---|---|---|---|
| Flashing the updater | web client (CMSIS-DAP), or SWD | web client (serial DFU), or drag `merged.uf2` onto the drive a double-tap of RESET exposes | web client (ROM loader), or `./build.sh flash` | web client (CMSIS-DAP), or SWD |
| Room for bundles | 8 MB QSPI, ~16 bundles | 2 MB QSPI, ~4 bundles | 4.3 MB internal, ~10 bundles | 4 MB SPI, ~10 bundles |
| MCUboot slot | 896 KB (31% used) | 368 KB (**80% used**) | 1792 KB (24% used) | 728 KB (43% used) |
| Status LED | RGB | RGB | one LED — failure blinks twice per cycle | one LED — same |
| WiFi | no | no | yes (the point of it) | no |
| Max BLE TX | +8 dBm | +8 dBm | +20 dBm | +20 dBm (build-time only) |

The **ESP32-S3 exists for ESP32 targets.** MeshCore's ESP32 repeaters do not do
BLE DFU at all — they update through ElegantOTA, over a WiFi AP they raise on
command — and no nRF part has WiFi, so no nRF updater can ever reach one. That
transport is not written yet; what works on this board today is everything the
nRF boards do.

Building for it needs one extra step after `west update`, because WiFi and
Bluetooth on ESP32 are closed binary blobs that the manifest does not carry:

```bash
west blobs fetch hal_espressif
```

`build.sh` handles the other Espressif-specific requirement itself — the build
needs `esptool >= 5.0.2`, and if you have PlatformIO installed its own esptool
4.x is first on `PATH` and fails at the very last step of the build. A private
venv is created at `.venv-esptool/` and used only for Espressif boards.

**The nRF52840 and ESP32-S3 builds are untested on hardware.** The nRF52840's
MCUboot is chainloaded from the Adafruit UF2 bootloader that ships on the board,
which stays put as the recovery path; the ESP32-S3's is a normal MCUboot at
offset 0.

Pushing an update for the wrong board over Bluetooth used to be a real foot-gun
— MCUboot checks the signature, not the architecture. The firmware now reports
its board target over `os_mgmt` and the web client refuses a mismatch, so this
is handled. A release still stages only the nRF54L firmware, so the other two
have to be built and flashed locally.

To test a local build through the web client's **Flash newest** button instead
of a probe, stage it where the client looks:

```bash
node web/tools/stage-firmware.mjs   # -> web/firmware/{merged.hex,manifest.json}
```

### Testing an over-the-air update

`updater/VERSION` sets the version imgtool stamps into the MCUboot image
header, and `./build.sh bump` increments its `VERSION_TWEAK` and rebuilds.

You need that because **uploading the image already running is refused**:
mcumgr identifies images by hash, so two byte-identical builds share one, the
lookup resolves to the running slot, and marking that slot "test" is denied.
Two genuinely different builds are the only way to exercise the path.

```bash
./build.sh                          # 1.0.0+0 — flash this over USB
./build.sh bump                     # 1.0.0+1 — a different image
```

Once `web/firmware/` exists, every build refreshes it, so the web client always
offers what you last built. Create it the first time with:

```bash
node web/tools/stage-firmware.mjs
```

The running version is logged at boot and shown in the web client's slot
table, and the version on offer is shown next to both update buttons — so the
two builds are told apart at a glance, before anything is transferred.

An updated image is confirmed automatically once it proves it can still be
reached over Bluetooth, so there is nothing to remember after an update. If
the new firmware cannot bring Bluetooth up, it is never confirmed and MCUboot
restores the previous version at the next reset.

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
| `updater/build_*/merged.uf2` | Same thing as UF2, on boards whose bootloader takes it (the XIAO nRF52840) |
| `updater/build/dfu_application.zip` | OTA bundle for updating the updater over BLE |
| `updater/build/updater/zephyr/zephyr.signed.hex` | Application alone — links at `0x10000`, **does not boot without MCUboot under it** |
| `updater/build/mcuboot/zephyr/zephyr.hex` | Bootloader alone |

Releases publish `merged.hex` and `dfu_application.zip`. `zephyr.hex` is
deliberately *not* published: it is the one people would flash first and then
file a bug about.

## Config knobs

The `config.txt` file on `/lfs1/` holds the scan filter, the retry policy, and the transfer tuning. It is reloaded on every retry attempt, so edits apply mid-run. Every key is documented in the web client's Config dialog, which is generated from the same schema the firmware parses; `web/js/lib/config-file.js` is the single list. On first boot the file is seeded with sensible defaults if absent.

Two keys are worth knowing about before a flight. **`auto_flash`** starts a
flash the moment the device has power, with no browser connected and nothing to
press — this is the setting that makes the device work at the far end of a
flight, since every other way of starting an update needs a client in Bluetooth
range of the updater. It uses `ble_firmware_mapping` to decide which bundle
goes to which target, so it needs one; armed without a mapping, the device says
so at boot instead of quietly flashing nothing. **`ext_antenna`** points the
antenna switch at the external connector on boards that have one — worth about
6 dB on the XIAO MG24, in both directions — and is off by default, because with
nothing plugged into the connector it makes the link worse rather than
better.

### Cutting a release

**The tag is the version.** CI writes `updater/VERSION` from it before
building, so the value baked into the MCUboot image header — shown by the web
client and logged at boot — always matches the release. Nothing to keep in
sync by hand.

```bash
git tag v1.2 && git push --follow-tags
# then publish the draft release GitHub Actions creates
#   -> that fires web.yml, which stages the firmware for "Flash newest"
#      and "Update over Bluetooth"
```

Tags are `vMAJOR.MINOR` or `vMAJOR.MINOR.PATCH`; a missing patch component
means `.0`. `VERSION_TWEAK` is set to 0 for releases, so `v1.2` ships exactly
`1.2.0`.

The `updater/VERSION` committed to git is therefore only the *development*
version — what your local builds report. `./build.sh bump` increments it, which
is how you make two local builds distinguishable for testing an update.

One consequence of doing it this way: a release artifact is not byte-identical
to what building that tag locally produces, since the committed VERSION differs.
The image reports its true version in its own header, so a device can always be
identified regardless.

## TODO

- **Replace the MCUboot signing key.** The build currently signs with
  MCUboot's checked-in `root-ed25519.pem` and warns about it on every run.
  Anyone can sign an update for these devices.
- Verify the vendored `xiao_nrf54lm20a` board files against the eventual
  upstream ones and delete the local copy when they match. Three bugs have
  been found in them so far (RRAM write-buffer commit, LED polarity,
  MCUboot slot alignment) — see the trap index in [CLAUDE.md](CLAUDE.md), and
  `notes/` for the full write-ups.
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

**Server side**: `updater/src/fsx_mgmt.{c,h}`. Registers as MGMT group **64** (`MGMT_GROUP_ID_PERUSER`) with seven commands — `list`, `mkdir`, `rmdir`, `move`, `statvfs`, `trigger_dfu`, `stop_dfu`. Wire format is CBOR, same as every other SMP group. See `fsx_mgmt.h` for the per-command request/response schemas.

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
- Click `Connect`, pick `Drone MeshCore Updater` from the browser's device picker, browse `/lfs1/`.

**Editing the config**: the `Config…` button, or a click on `config.txt` in the listing, opens a form over `/lfs1/config.txt` showing every key with its description, its firmware default (click the chip to restore it), and live validation. Only the real `/lfs1/config.txt` opens the editor; a copy in another directory still downloads, since that isn't a file the firmware reads. The filename is always lowercase — uploading one named `CONFIG.TXT` is redirected to `config.txt` (and logged), because LittleFS is case-sensitive and the firmware would silently never read the uppercase one. Values the firmware would silently reject are blocked rather than written, and the encoded size is checked against the parser's 1023-byte buffer. Unknown keys in the file are preserved on save.

## References

- [Nordic nRF Connect Device Manager](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/samples/mcumgr_smp_svr.html) — the phone/PC clients this project targets
- [Zephyr mcumgr subsystem](https://docs.zephyrproject.org/latest/services/device_mgmt/mcumgr.html) — SMP protocol reference
- [MCUboot documentation](https://docs.mcuboot.com/) — dual-slot bootloader used for self-updating
