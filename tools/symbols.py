#!/usr/bin/env python3
"""Pull the ground truth for the gameplay tests out of OUR OWN BUILD.

Nothing in here is copied from a wiki, a guide or a RAM map. Every address comes
from `arm-none-eabi-nm` over the ELF this project just linked, every struct
offset from the comments in the decomp's own headers, every map name from the
decomp's own `include/constants/map_groups.h`, and the player-name decoding from
the decomp's own `charmap.txt`.

That matters because the thing being tested is "did the game reach the
overworld", and the intro is scripted: it shows a title screen, a professor, a
name-entry box and a fade to a bedroom whether or not any of it is interactive.
A screenshot cannot tell those apart. `gMain.callback2 == CB2_Overworld` can.

    python3 tools/symbols.py            # human-readable
    python3 tools/symbols.py --json     # for the test harnesses
"""

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
TREE = os.path.join(PROJ, "upstream")
ELF = os.path.join(TREE, "pokeleafgreen_rev1.elf")
NM = os.path.join(
    os.path.expanduser("~"), "decompfleet/shared/arm-bin/usr/bin/arm-none-eabi-nm"
)

# Data symbols we read through the emulator's bus.
DATA_SYMS = [
    "gMain",
    "gSaveBlock1Ptr",
    "gSaveBlock2Ptr",
    "gSaveBlock1",
    "gSaveBlock2",
    "gPlayerAvatar",
    "gMapHeader",
    "gObjectEvents",
    # Start-menu state, so the save test can navigate to SAVE by reading the
    # menu the game actually built rather than by guessing how many times to
    # press DOWN. The menu is shorter before you own a Pokedex or a party, so a
    # hardcoded count is wrong at exactly the point the test runs.
    "sStartMenuCursorPos",
    "sNumStartMenuItems",
    "sStartMenuOrder",
    "gSaveFileStatus",
    "gDifferentSaveFile",
    # The game's own "the player does not have control right now" flag
    # (src/script.c: sLockFieldControls, read by ArePlayerFieldControlsLocked).
    # This is the strongest available answer to "is this actually playable now",
    # because it is set by the script engine while a message box or cutscene is
    # up -- exactly the states that look like play in a screenshot.
    "sLockFieldControls",
]

# Top-level callbacks. gMain.callback2 holding one of these is the game telling
# us which of its own screens it is on.
CODE_SYMS = [
    "CB2_InitCopyrightScreenAfterBootup",
    "CB2_InitTitleScreen",
    "CB2_MainMenu",
    "CB2_Overworld",
    "CB2_OverworldBasic",
    "CB2_LoadMap",
    "CB2_ReturnToField",
    "CB2_InitBattle",
    "CB2_HandleStartBattle",
    "CB2_NamingScreen",
    "CB2_NewGameBirchSpeech_FromNewMainMenu",
    "CB2_InitMainMenu",
    "CB2_ReturnToFieldContinueScript",
    "CB2_ReturnToFieldFadeFromBlack",
    "CB2_BagMenuRun",
    "CB2_StartMenu",
    "CB2_ShowStartMenu",
]

# Struct offsets, transcribed from the decomp's headers. The source line for
# each is given so a reviewer can check it without trusting this file.
OFFSETS = {
    # include/main.h, struct Main
    "Main.callback1": 0x000,
    "Main.callback2": 0x004,
    "Main.savedCallback": 0x008,
    "Main.heldKeys": 0x02C,
    "Main.newKeys": 0x02E,
    "Main.state": 0x438,
    # include/global.h, struct SaveBlock1 (pos is Coords16, location is WarpData)
    "SaveBlock1.pos.x": 0x0000,
    "SaveBlock1.pos.y": 0x0002,
    "SaveBlock1.location.mapGroup": 0x0004,
    "SaveBlock1.location.mapNum": 0x0005,
    "SaveBlock1.location.warpId": 0x0006,
    "SaveBlock1.mapLayoutId": 0x0032,
    "SaveBlock1.playerPartyCount": 0x0034,
    "SaveBlock1.money": 0x0290,
    # include/global.h, struct SaveBlock2
    "SaveBlock2.playerName": 0x000,
    "SaveBlock2.playerNameLen": 8,  # PLAYER_NAME_LENGTH + 1
    "SaveBlock2.playerGender": 0x008,
    "SaveBlock2.playTimeHours": 0x00E,
    "SaveBlock2.playTimeMinutes": 0x010,
    "SaveBlock2.playTimeSeconds": 0x011,
}

EXPECT_SHA1 = "7862c67bdecbe21d1d69ce082ce34327e1c6ed5e"


def enums():
    """Constants the tests compare against, read from the decomp's own source.

    STARTMENU_* is a plain C enum in src/start_menu.c, so it is parsed rather
    than transcribed; SAVE_STATUS_* are #defines in include/save.h. Either could
    be renumbered upstream, and then this picks up the new value instead of the
    test quietly asserting the old one.
    """
    out = {}

    path = os.path.join(TREE, "src/start_menu.c")
    with open(path) as fh:
        src = fh.read()
    m = re.search(r"enum StartMenuOption\s*\{(.*?)\}", src, re.S)
    if not m:
        sys.exit("could not find enum StartMenuOption in src/start_menu.c")
    nxt = 0
    for raw in m.group(1).split(","):
        raw = raw.split("//")[0].strip()
        if not raw:
            continue
        if "=" in raw:
            name, val = raw.split("=", 1)
            name, nxt = name.strip(), int(val.strip(), 0)
        else:
            name = raw
        out[name] = nxt
        nxt += 1

    path = os.path.join(TREE, "include/save.h")
    with open(path) as fh:
        for line in fh:
            m = re.match(r"#define\s+(SAVE_STATUS_[A-Z_]+)\s+(0x[0-9A-Fa-f]+|\d+)", line)
            if m:
                out[m.group(1)] = int(m.group(2), 0)
    return out


def nm_symbols():
    """name -> (addr, type) for every symbol in our linked ELF."""
    if not os.path.exists(ELF):
        sys.exit(f"no ELF at {ELF} -- run tools/build.sh first")
    nm = NM if os.path.exists(NM) else "arm-none-eabi-nm"
    out = subprocess.run([nm, ELF], capture_output=True, text=True, check=True).stdout
    syms = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 3:
            addr, typ, name = parts
            # Keep the first definition; nm lists locals and globals together.
            syms.setdefault(name, (int(addr, 16), typ))
    return syms


def map_names():
    """(mapGroup, mapNum) -> MAP_* name, from the decomp's own constants."""
    path = os.path.join(TREE, "include/constants/map_groups.h")
    pat = re.compile(r"#define\s+(MAP_[A-Z0-9_]+)\s+\((\d+)\s*\|\s*\((\d+)\s*<<\s*8\)\)")
    out = {}
    with open(path) as fh:
        for line in fh:
            m = pat.search(line)
            if m:
                name, num, group = m.group(1), int(m.group(2)), int(m.group(3))
                out[f"{group}:{num}"] = name
    return out


def charmap():
    """byte -> character, from the decomp's own charmap.txt.

    This is how a player name read out of EWRAM gets turned back into text. The
    game does not store ASCII, and guessing the table would be exactly the kind
    of outside-knowledge shortcut these tests are meant to avoid.
    """
    path = os.path.join(TREE, "charmap.txt")
    table = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("@")[0].rstrip("\n")
            if "=" not in line:
                continue
            lhs, rhs = line.split("=", 1)
            lhs = lhs.strip()
            rhs = rhs.strip()
            if not lhs or not rhs:
                continue
            # Single-byte entries only; the multi-byte ones are control codes.
            # The file writes bytes as bare hex ("41"), not "0x41".
            bytes_ = rhs.split()
            if len(bytes_) != 1:
                continue
            try:
                val = int(bytes_[0], 16)
            except ValueError:
                continue
            if not 0 <= val <= 0xFF:
                continue
            if lhs.startswith("'") and lhs.endswith("'") and len(lhs) >= 3:
                lhs = lhs[1:-1]
            table.setdefault(val, lhs)
    return table


def build():
    syms = nm_symbols()
    missing = [s for s in DATA_SYMS if s not in syms]
    if missing:
        sys.exit(f"these symbols are not in our ELF: {missing}")

    data = {n: syms[n][0] for n in DATA_SYMS}
    code = {n: syms[n][0] for n in CODE_SYMS if n in syms}
    # Reverse lookup for callback2. Thumb pointers have bit 0 set.
    cb_by_addr = {}
    for n, a in code.items():
        cb_by_addr[a & ~1] = n

    return {
        "elf": ELF,
        "expect_rom_sha1": EXPECT_SHA1,
        "data": data,
        "code": code,
        "callback_by_addr": {hex(k): v for k, v in sorted(cb_by_addr.items())},
        "offsets": OFFSETS,
        "enums": enums(),
        "maps": map_names(),
        "charmap": {str(k): v for k, v in sorted(charmap().items())},
    }


if __name__ == "__main__":
    info = build()
    if "--json" in sys.argv:
        json.dump(info, sys.stdout, indent=1)
        print()
    else:
        print(f"ELF: {info['elf']}")
        print("\ndata symbols (read through the emulator bus):")
        for n, a in info["data"].items():
            print(f"  {n:<20} 0x{a:08x}")
        print("\ntop-level callbacks (what gMain.callback2 can hold):")
        for n, a in sorted(info["code"].items(), key=lambda kv: kv[1]):
            print(f"  {n:<42} 0x{a:08x}")
        print("\nconstants from the decomp's own source:")
        for k in ("STARTMENU_SAVE", "STARTMENU_EXIT", "MAX_STARTMENU_ITEMS",
                  "SAVE_STATUS_EMPTY", "SAVE_STATUS_OK"):
            if k in info["enums"]:
                print(f"  {k:<22} {info['enums'][k]}")
        print(f"\n{len(info['maps'])} map constants, {len(info['charmap'])} charmap entries")
        for key in ("3:0", "4:0", "4:1"):
            if key in info["maps"]:
                print(f"  group:num {key} = {info['maps'][key]}")
