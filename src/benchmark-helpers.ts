#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { QuestBenchmarkProvenance } from "./types.js";

export interface ParsedBenchmarkHelperArgs {
	family: string;
	taskId: string;
	inputPath: string;
	outputPath: string;
}

export function nativeBenchmarkHelperArgs(
	benchmark: QuestBenchmarkProvenance | undefined,
): ParsedBenchmarkHelperArgs | null {
	if (!benchmark) return null;
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "chess-best-move") {
		return {
			family: benchmark.benchmark,
			taskId: benchmark.taskId,
			inputPath: "/app/chess_board.png",
			outputPath: "/app/move.txt",
		};
	}
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "qemu-startup") {
		return {
			family: benchmark.benchmark,
			taskId: benchmark.taskId,
			inputPath: "/app/alpine.iso",
			outputPath: "/app/alpine-disk.qcow2",
		};
	}
	return null;
}

function usage(): string {
	return "Usage: node dist/benchmark-helpers.js <family> <task-id> <input-path> <output-path>";
}

export function parseArgs(argv: string[]): ParsedBenchmarkHelperArgs {
	if (argv.length !== 4) {
		throw new Error(usage());
	}
	return {
		family: argv[0],
		taskId: argv[1],
		inputPath: argv[2],
		outputPath: argv[3],
	};
}

const CHESS_BEST_MOVE_PYTHON = String.raw`
from pathlib import Path
import os
import sys

import chess
import numpy as np
from PIL import Image, ImageDraw, ImageFont

LIGHT = (240, 217, 181)
DARK = (181, 136, 99)
PIECE_SYMBOLS = {
    "K": "♔",
    "Q": "♕",
    "R": "♖",
    "B": "♗",
    "N": "♘",
    "P": "♙",
    "k": "♚",
    "q": "♛",
    "r": "♜",
    "b": "♝",
    "n": "♞",
    "p": "♟",
}
FONT_CANDIDATES = [
    "/fonts/noto.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
]


def load_font(size):
    for candidate in FONT_CANDIDATES:
        if not os.path.exists(candidate):
            continue
        try:
            return ImageFont.truetype(candidate, size)
        except Exception:
            continue
    return ImageFont.load_default()


def render_piece(piece, square_size, background):
    img = Image.new("RGB", (square_size, square_size), background)
    if not piece:
        return img
    draw = ImageDraw.Draw(img)
    font = load_font(int(square_size * 0.7))
    draw.text(
        (int(square_size * 0.15), int(square_size * 0.15)),
        PIECE_SYMBOLS[piece],
        fill=(255, 255, 255) if piece.isupper() else (0, 0, 0),
        font=font,
    )
    return img


def mse(square, template):
    margin = max(4, square.size[0] // 8)
    x1 = margin
    y1 = margin
    x2 = square.size[0] - margin
    y2 = square.size[1] - margin
    square_arr = np.asarray(square.crop((x1, y1, x2, y2)), dtype=np.float32)
    template_arr = np.asarray(template.crop((x1, y1, x2, y2)), dtype=np.float32)
    return float(np.mean((square_arr - template_arr) ** 2))


def recover_board(image_path):
    image = Image.open(image_path).convert("RGB")
    square_size = min(image.size) // 8
    candidates = ["", "K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"]
    rows = []
    for row in range(8):
        row_pieces = []
        for col in range(8):
            square = image.crop((col * square_size, row * square_size, (col + 1) * square_size, (row + 1) * square_size))
            background = LIGHT if (row + col) % 2 == 0 else DARK
            best_piece = ""
            best_score = float("inf")
            for piece in candidates:
                template = render_piece(piece, square_size, background)
                score = mse(square, template)
                if score < best_score:
                    best_score = score
                    best_piece = piece
            row_pieces.append(best_piece)
        rows.append(row_pieces)
    return rows


def board_to_fen(rows):
    fen_rows = []
    for row in rows:
        empties = 0
        fen_row = []
        for piece in row:
            if not piece:
                empties += 1
                continue
            if empties:
                fen_row.append(str(empties))
                empties = 0
            fen_row.append(piece)
        if empties:
            fen_row.append(str(empties))
        fen_rows.append("".join(fen_row) or "8")
    return "/".join(fen_rows)


def mate_in_one_moves(fen):
    board = chess.Board(fen + " w - - 0 1")
    winning = []
    for move in board.legal_moves:
        board.push(move)
        if board.is_checkmate():
            winning.append(move.uci())
        board.pop()
    return winning


def main():
    image_path = sys.argv[1]
    output_path = Path(sys.argv[2])
    board_rows = recover_board(image_path)
    fen = board_to_fen(board_rows)
    winning = mate_in_one_moves(fen)
    if not winning:
        raise SystemExit("No mate-in-one moves found from recovered board.")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(winning), encoding="utf-8")
    print("Recovered FEN:", fen)
    print("Winning moves:", " ".join(winning))


if __name__ == "__main__":
    main()
`;

const QEMU_STARTUP_SCRIPT = String.raw`
set -euo pipefail
ISO_PATH="$1"
DISK_PATH="$2"

if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
  echo "qemu-system-x86_64 is required" >&2
  exit 1
fi
if ! command -v expect >/dev/null 2>&1; then
  echo "expect is required" >&2
  exit 1
fi
if ! command -v bsdtar >/dev/null 2>&1 || ! command -v mkfs.vfat >/dev/null 2>&1 || ! command -v mcopy >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "bsdtar, mkfs.vfat, and mcopy are required and apt-get is unavailable to install them" >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update >/dev/null
  apt-get install -y -qq libarchive-tools dosfstools mtools >/dev/null
fi

BOOT_DIR="$(mktemp -d)"
OVERLAY_DIR="$(mktemp -d)"
OVERLAY_IMAGE="$(mktemp).img"
EXPECT_FILE="$(mktemp)"
cleanup() {
  rm -rf "$BOOT_DIR" "$OVERLAY_DIR" "$OVERLAY_IMAGE" "$EXPECT_FILE"
}
trap cleanup EXIT

bsdtar -xOf "$ISO_PATH" boot/vmlinuz-lts > "$BOOT_DIR/vmlinuz-lts"
bsdtar -xOf "$ISO_PATH" boot/initramfs-lts > "$BOOT_DIR/initramfs-lts"

mkdir -p "$OVERLAY_DIR/etc"
cat <<'EOF' > "$OVERLAY_DIR/etc/inittab"
# /etc/inittab

::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default

tty1::respawn:/sbin/getty 38400 tty1
tty2::respawn:/sbin/getty 38400 tty2
tty3::respawn:/sbin/getty 38400 tty3
tty4::respawn:/sbin/getty 38400 tty4
tty5::respawn:/sbin/getty 38400 tty5
tty6::respawn:/sbin/getty 38400 tty6
ttyS0::respawn:/sbin/getty -L ttyS0 115200 vt100

::ctrlaltdel:/sbin/reboot
::shutdown:/sbin/openrc shutdown
EOF
printf 'localhost\n' > "$OVERLAY_DIR/etc/hostname"
cat <<'EOF' > "$OVERLAY_DIR/etc/securetty"
tty1
tty2
tty3
tty4
tty5
tty6
ttyS0
EOF

(cd "$OVERLAY_DIR" && tar -czf "$OVERLAY_DIR/localhost.apkovl.tar.gz" etc)
truncate -s 8M "$OVERLAY_IMAGE"
mkfs.vfat "$OVERLAY_IMAGE" >/dev/null
mcopy -i "$OVERLAY_IMAGE" "$OVERLAY_DIR/localhost.apkovl.tar.gz" ::localhost.apkovl.tar.gz

qemu-system-x86_64 -m 1024 \
  -kernel "$BOOT_DIR/vmlinuz-lts" \
  -initrd "$BOOT_DIR/initramfs-lts" \
  -append "modules=loop,squashfs,sd-mod,usb-storage console=ttyS0 hostname=localhost" \
  -drive file="$ISO_PATH",media=cdrom,readonly=on \
  -drive file="$DISK_PATH",format=qcow2 \
  -drive file="$OVERLAY_IMAGE",format=raw \
  -nic user,hostfwd=tcp::2222-:22 \
  -daemonize -display none -vga none \
  -serial telnet:127.0.0.1:6665,server,nowait

cat <<'EOF' > "$EXPECT_FILE"
set timeout 10
set deadline [expr {[clock seconds] + 780}]
sleep 5
spawn telnet 127.0.0.1 6665
while {1} {
    send "\r"
    expect {
        "login:" { puts "System is booted and ready"; exit 0 }
        timeout {
            if {[clock seconds] >= $deadline} {
                puts "Timed out waiting for system to boot"
                exit 1
            }
            exp_continue
        }
    }
}
EOF
expect -f "$EXPECT_FILE"
`;

async function runPythonScript(script: string, args: string[]): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn("python3", ["-c", script, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		proc.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if ((code ?? 1) !== 0) {
				reject(new Error(stderr.trim() || stdout.trim() || `python3 exited with code ${code ?? 1}`));
				return;
			}
			if (stdout.trim()) console.log(stdout.trimEnd());
			resolvePromise();
		});
	});
}

async function runShellScript(script: string, args: string[]): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const proc = spawn("bash", ["-c", script, "--", ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		proc.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if ((code ?? 1) !== 0) {
				reject(new Error(stderr.trim() || stdout.trim() || `bash exited with code ${code ?? 1}`));
				return;
			}
			if (stdout.trim()) console.log(stdout.trimEnd());
			resolvePromise();
		});
	});
}

export async function runBenchmarkHelper(parsed: ParsedBenchmarkHelperArgs): Promise<void> {
	if (parsed.family === "terminal-bench" && parsed.taskId === "chess-best-move") {
		await runPythonScript(CHESS_BEST_MOVE_PYTHON, [parsed.inputPath, parsed.outputPath]);
		return;
	}
	if (parsed.family === "terminal-bench" && parsed.taskId === "qemu-startup") {
		await runShellScript(QEMU_STARTUP_SCRIPT, [parsed.inputPath, parsed.outputPath]);
		return;
	}
	throw new Error(`No native helper registered for ${parsed.family}/${parsed.taskId}.`);
}

async function main() {
	try {
		await runBenchmarkHelper(parseArgs(process.argv.slice(2)));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = message.startsWith("Usage:") ? 2 : 1;
	}
}

function isMainModule(): boolean {
	return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
	await main();
}
