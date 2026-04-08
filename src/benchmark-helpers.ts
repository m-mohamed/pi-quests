#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { QuestBenchmarkProvenance } from "./types.js";

const nodeNetModuleName = "node:net";
const nodeNet = (await import(nodeNetModuleName)) as {
	createConnection(options: { host: string; port: number }, listener?: () => void): {
		setEncoding(encoding: string): void;
		on(event: string, listener: (...args: any[]) => void): void;
		once(event: string, listener: (...args: any[]) => void): void;
		write(text: string): void;
		end(): void;
	};
};

type SocketLike = ReturnType<typeof nodeNet.createConnection>;

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
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "build-cython-ext") {
		return {
			family: benchmark.benchmark,
			taskId: benchmark.taskId,
			inputPath: "/app",
			outputPath: "/app/pyknotid",
		};
	}
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "sqlite-with-gcov") {
		return {
			family: benchmark.benchmark,
			taskId: benchmark.taskId,
			inputPath: "/app/vendor/sqlite-fossil-release.tar.gz",
			outputPath: "/app/sqlite",
		};
	}
	if (benchmark.benchmark === "terminal-bench" && benchmark.taskId === "qemu-alpine-ssh") {
		return {
			family: benchmark.benchmark,
			taskId: benchmark.taskId,
			inputPath: "/app/alpine.iso",
			outputPath: "/app/alpine-disk.qcow2",
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
import json
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat

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
    diff = ImageChops.difference(square.crop((x1, y1, x2, y2)), template.crop((x1, y1, x2, y2)))
    rms = ImageStat.Stat(diff).rms
    return float(sum(channel * channel for channel in rms) / max(1, len(rms)))


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


def main():
    image_path = sys.argv[1]
    board_rows = recover_board(image_path)
    print(json.dumps(board_rows))


if __name__ == "__main__":
    main()
`;

type ChessPiece = string | null;
type ChessColor = "white" | "black";

interface ChessMove {
	fromRow: number;
	fromCol: number;
	toRow: number;
	toCol: number;
	promotion?: string;
}

function normalizeBoardRows(rows: readonly (readonly string[])[]): ChessPiece[][] {
	if (rows.length !== 8 || rows.some((row) => row.length !== 8)) {
		throw new Error("Recovered chess board must be 8x8.");
	}
	return rows.map((row) => row.map((piece) => (piece ? piece : null)));
}

function inBounds(row: number, col: number): boolean {
	return row >= 0 && row < 8 && col >= 0 && col < 8;
}

function pieceColor(piece: ChessPiece): ChessColor | null {
	if (!piece) return null;
	return piece === piece.toUpperCase() ? "white" : "black";
}

function oppositeColor(color: ChessColor): ChessColor {
	return color === "white" ? "black" : "white";
}

function cloneBoard(board: ChessPiece[][]): ChessPiece[][] {
	return board.map((row) => [...row]);
}

function pieceAt(board: ChessPiece[][], row: number, col: number): ChessPiece {
	return inBounds(row, col) ? board[row][col] : null;
}

function findKing(board: ChessPiece[][], color: ChessColor): [number, number] {
	const expected = color === "white" ? "K" : "k";
	for (let row = 0; row < 8; row += 1) {
		for (let col = 0; col < 8; col += 1) {
			if (board[row][col] === expected) {
				return [row, col];
			}
		}
	}
	throw new Error(`Recovered board is missing the ${color} king.`);
}

function isSquareAttacked(board: ChessPiece[][], targetRow: number, targetCol: number, byColor: ChessColor): boolean {
	const pawn = byColor === "white" ? "P" : "p";
	const knight = byColor === "white" ? "N" : "n";
	const bishop = byColor === "white" ? "B" : "b";
	const rook = byColor === "white" ? "R" : "r";
	const queen = byColor === "white" ? "Q" : "q";
	const king = byColor === "white" ? "K" : "k";
	const pawnRow = byColor === "white" ? targetRow + 1 : targetRow - 1;
	for (const deltaCol of [-1, 1]) {
		if (pieceAt(board, pawnRow, targetCol + deltaCol) === pawn) {
			return true;
		}
	}
	for (const [deltaRow, deltaCol] of [
		[-2, -1],
		[-2, 1],
		[-1, -2],
		[-1, 2],
		[1, -2],
		[1, 2],
		[2, -1],
		[2, 1],
	] as const) {
		if (pieceAt(board, targetRow + deltaRow, targetCol + deltaCol) === knight) {
			return true;
		}
	}
	for (const [deltaRow, deltaCol] of [
		[-1, -1],
		[-1, 0],
		[-1, 1],
		[0, -1],
		[0, 1],
		[1, -1],
		[1, 0],
		[1, 1],
	] as const) {
		if (pieceAt(board, targetRow + deltaRow, targetCol + deltaCol) === king) {
			return true;
		}
	}
	for (const [deltaRow, deltaCol] of [
		[-1, -1],
		[-1, 1],
		[1, -1],
		[1, 1],
	] as const) {
		let row = targetRow + deltaRow;
		let col = targetCol + deltaCol;
		while (inBounds(row, col)) {
			const piece = board[row][col];
			if (piece) {
				if (piece === bishop || piece === queen) {
					return true;
				}
				break;
			}
			row += deltaRow;
			col += deltaCol;
		}
	}
	for (const [deltaRow, deltaCol] of [
		[-1, 0],
		[1, 0],
		[0, -1],
		[0, 1],
	] as const) {
		let row = targetRow + deltaRow;
		let col = targetCol + deltaCol;
		while (inBounds(row, col)) {
			const piece = board[row][col];
			if (piece) {
				if (piece === rook || piece === queen) {
					return true;
				}
				break;
			}
			row += deltaRow;
			col += deltaCol;
		}
	}
	return false;
}

function isKingInCheck(board: ChessPiece[][], color: ChessColor): boolean {
	const [kingRow, kingCol] = findKing(board, color);
	return isSquareAttacked(board, kingRow, kingCol, oppositeColor(color));
}

function pushMove(moves: ChessMove[], move: ChessMove, piece: ChessPiece): void {
	if (!piece) return;
	if ((piece === "P" && move.toRow === 0) || (piece === "p" && move.toRow === 7)) {
		moves.push({ ...move, promotion: piece === "P" ? "Q" : "q" });
		return;
	}
	moves.push(move);
}

function generatePseudoMoves(board: ChessPiece[][], color: ChessColor): ChessMove[] {
	const moves: ChessMove[] = [];
	for (let row = 0; row < 8; row += 1) {
		for (let col = 0; col < 8; col += 1) {
			const piece = board[row][col];
			if (!piece || pieceColor(piece) !== color) continue;
			switch (piece.toLowerCase()) {
				case "p": {
					const direction = color === "white" ? -1 : 1;
					const startRow = color === "white" ? 6 : 1;
					const oneStepRow = row + direction;
					if (inBounds(oneStepRow, col) && !board[oneStepRow][col]) {
						pushMove(moves, { fromRow: row, fromCol: col, toRow: oneStepRow, toCol: col }, piece);
						const twoStepRow = row + direction * 2;
						if (row === startRow && inBounds(twoStepRow, col) && !board[twoStepRow][col]) {
							moves.push({ fromRow: row, fromCol: col, toRow: twoStepRow, toCol: col });
						}
					}
					for (const deltaCol of [-1, 1]) {
						const captureRow = row + direction;
						const captureCol = col + deltaCol;
						if (!inBounds(captureRow, captureCol)) continue;
						const target = board[captureRow][captureCol];
						if (target && pieceColor(target) === oppositeColor(color)) {
							pushMove(moves, { fromRow: row, fromCol: col, toRow: captureRow, toCol: captureCol }, piece);
						}
					}
					break;
				}
				case "n":
					for (const [deltaRow, deltaCol] of [
						[-2, -1],
						[-2, 1],
						[-1, -2],
						[-1, 2],
						[1, -2],
						[1, 2],
						[2, -1],
						[2, 1],
					] as const) {
						const nextRow = row + deltaRow;
						const nextCol = col + deltaCol;
						if (!inBounds(nextRow, nextCol)) continue;
						const target = board[nextRow][nextCol];
						if (!target || pieceColor(target) === oppositeColor(color)) {
							moves.push({ fromRow: row, fromCol: col, toRow: nextRow, toCol: nextCol });
						}
					}
					break;
				case "b":
				case "r":
				case "q": {
					const directions =
						piece.toLowerCase() === "b"
							? ([
									[-1, -1],
									[-1, 1],
									[1, -1],
									[1, 1],
								] as const)
							: piece.toLowerCase() === "r"
								? ([
										[-1, 0],
										[1, 0],
										[0, -1],
										[0, 1],
									] as const)
								: ([
										[-1, -1],
										[-1, 1],
										[1, -1],
										[1, 1],
										[-1, 0],
										[1, 0],
										[0, -1],
										[0, 1],
									] as const);
					for (const [deltaRow, deltaCol] of directions) {
						let nextRow = row + deltaRow;
						let nextCol = col + deltaCol;
						while (inBounds(nextRow, nextCol)) {
							const target = board[nextRow][nextCol];
							if (!target) {
								moves.push({ fromRow: row, fromCol: col, toRow: nextRow, toCol: nextCol });
							} else {
								if (pieceColor(target) === oppositeColor(color)) {
									moves.push({ fromRow: row, fromCol: col, toRow: nextRow, toCol: nextCol });
								}
								break;
							}
							nextRow += deltaRow;
							nextCol += deltaCol;
						}
					}
					break;
				}
				case "k":
					for (const [deltaRow, deltaCol] of [
						[-1, -1],
						[-1, 0],
						[-1, 1],
						[0, -1],
						[0, 1],
						[1, -1],
						[1, 0],
						[1, 1],
					] as const) {
						const nextRow = row + deltaRow;
						const nextCol = col + deltaCol;
						if (!inBounds(nextRow, nextCol)) continue;
						const target = board[nextRow][nextCol];
						if (!target || pieceColor(target) === oppositeColor(color)) {
							moves.push({ fromRow: row, fromCol: col, toRow: nextRow, toCol: nextCol });
						}
					}
					break;
				default:
					break;
			}
		}
	}
	return moves;
}

function applyMove(board: ChessPiece[][], move: ChessMove): ChessPiece[][] {
	const nextBoard = cloneBoard(board);
	const piece = nextBoard[move.fromRow][move.fromCol];
	if (!piece) {
		throw new Error("Cannot apply a move from an empty square.");
	}
	nextBoard[move.fromRow][move.fromCol] = null;
	nextBoard[move.toRow][move.toCol] = move.promotion ?? piece;
	return nextBoard;
}

function generateLegalMoves(board: ChessPiece[][], color: ChessColor): ChessMove[] {
	return generatePseudoMoves(board, color).filter((move) => !isKingInCheck(applyMove(board, move), color));
}

function moveToUci(move: ChessMove): string {
	const files = "abcdefgh";
	return `${files[move.fromCol]}${8 - move.fromRow}${files[move.toCol]}${8 - move.toRow}`;
}

export function findWhiteMateInOneMoves(rows: readonly (readonly string[])[]): string[] {
	const board = normalizeBoardRows(rows);
	const winningMoves: string[] = [];
	for (const move of generateLegalMoves(board, "white")) {
		const nextBoard = applyMove(board, move);
		if (!isKingInCheck(nextBoard, "black")) continue;
		if (generateLegalMoves(nextBoard, "black").length === 0) {
			winningMoves.push(moveToUci(move));
		}
	}
	return winningMoves.sort();
}

export const chessHelperTestUtils = {
	normalizeBoardRows,
	generateLegalMoves,
	applyMove,
	isKingInCheck,
	isSquareAttacked,
};

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

const QEMU_ALPINE_SSH_SCRIPT = String.raw`
set -euo pipefail
ISO_PATH="$1"
DISK_PATH="$2"

if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
  echo "qemu-system-x86_64 is required" >&2
  exit 1
fi
if ! command -v bsdtar >/dev/null 2>&1 || ! command -v mkfs.vfat >/dev/null 2>&1 || ! command -v mcopy >/dev/null 2>&1 || ! command -v sshpass >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "required helper dependencies are missing and apt-get is unavailable to install them" >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update >/dev/null
  apt-get install -y -qq libarchive-tools dosfstools mtools sshpass >/dev/null
fi

BOOT_DIR="$(mktemp -d)"
OVERLAY_DIR="$(mktemp -d)"
OVERLAY_IMAGE="$(mktemp).img"
cleanup() {
  rm -rf "$BOOT_DIR" "$OVERLAY_DIR" "$OVERLAY_IMAGE"
}
trap cleanup EXIT

bsdtar -xOf "$ISO_PATH" boot/vmlinuz-lts > "$BOOT_DIR/vmlinuz-lts"
bsdtar -xOf "$ISO_PATH" boot/initramfs-lts > "$BOOT_DIR/initramfs-lts"

mkdir -p "$OVERLAY_DIR/etc" "$OVERLAY_DIR/root"
cat <<'EOF' > "$OVERLAY_DIR/etc/inittab"
# /etc/inittab

::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
::once:/root/setup-ssh.sh

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
cat <<'EOF' > "$OVERLAY_DIR/root/setup-ssh.sh"
#!/bin/sh
set -eu

mkdir -p /var/log /var/lib
LOG_FILE="/var/log/setup-ssh.log"
MARKER="/var/lib/setup-ssh.done"
if [ -f "$MARKER" ]; then
  exit 0
fi

{
  echo "Starting setup-ssh"
  sleep 5
  ip link set eth0 up || true
  i=0
  until udhcpc -i eth0; do
    i=$((i + 1))
    if [ "$i" -ge 10 ]; then
      echo "DHCP failed"
      exit 1
    fi
    sleep 2
  done

  apk update
  apk add openssh
  ssh-keygen -A

  if grep -q '^#\?PermitRootLogin' /etc/ssh/sshd_config; then
    sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
  else
    echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config
  fi

  if grep -q '^#\?PasswordAuthentication' /etc/ssh/sshd_config; then
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  else
    echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config
  fi

  echo 'root:password123' | chpasswd
  rc-update add sshd default
  service sshd restart
  touch "$MARKER"
} >>"$LOG_FILE" 2>&1
EOF
chmod +x "$OVERLAY_DIR/root/setup-ssh.sh"

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

deadline=$(( $(date +%s) + 180 ))
while true; do
  if sshpass -p password123 ssh \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 \
    -p 2222 root@localhost uname -r 2>/dev/null | grep -q '6.6.4-1-lts'; then
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "SSH on port 2222 never became ready" >&2
    exit 1
  fi
  sleep 2
done
`;

const QEMU_ALPINE_SSH_BOOT_SCRIPT = String.raw`
set -euo pipefail
ISO_PATH="$1"
DISK_PATH="$2"
SERIAL_PORT="$3"
if [ -z "$SERIAL_PORT" ]; then
  SERIAL_PORT=6665
fi

if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
  echo "qemu-system-x86_64 is required" >&2
  exit 1
fi
if ! command -v bsdtar >/dev/null 2>&1 || ! command -v mkfs.vfat >/dev/null 2>&1 || ! command -v mcopy >/dev/null 2>&1 || ! command -v sshpass >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "required helper dependencies are missing and apt-get is unavailable to install them" >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update >/dev/null
  apt-get install -y -qq libarchive-tools dosfstools mtools sshpass >/dev/null
fi

BOOT_DIR="$(mktemp -d)"
OVERLAY_DIR="$(mktemp -d)"
OVERLAY_IMAGE="$(mktemp).img"
cleanup() {
  rm -rf "$BOOT_DIR" "$OVERLAY_DIR" "$OVERLAY_IMAGE"
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
  -serial tcp:127.0.0.1:$SERIAL_PORT,server,nowait
sleep 2
`;

function delay(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

class SerialConsoleSession {
	private buffer = "";
	private waiters = new Set<() => void>();
	private closed = false;
	private readonly socket: SocketLike;

	constructor(socket: SocketLike) {
		this.socket = socket;
		this.socket.setEncoding("utf8");
		this.socket.on("data", (chunk: string) => {
			this.buffer += String(chunk);
			if (this.buffer.length > 200_000) {
				this.buffer = this.buffer.slice(-200_000);
			}
			for (const resolvePromise of this.waiters) resolvePromise();
			this.waiters.clear();
		});
		this.socket.on("close", () => {
			this.closed = true;
			for (const resolvePromise of this.waiters) resolvePromise();
			this.waiters.clear();
		});
	}

	send(text: string): void {
		this.socket.write(text);
	}

	async waitFor(pattern: RegExp, timeoutMs: number, startIndex = 0): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const slice = this.buffer.slice(startIndex);
			if (pattern.test(slice)) {
				return slice;
			}
			if (this.closed) {
				throw new Error(`Serial console closed while waiting for ${pattern}.`);
			}
			const remaining = deadline - Date.now();
			await new Promise<void>((resolvePromise, reject) => {
				let waiter: (() => void) | undefined;
				const timer = setTimeout(() => {
					if (waiter) this.waiters.delete(waiter);
					reject(new Error(`Timed out waiting for ${pattern}.`));
				}, remaining);
				waiter = () => {
					clearTimeout(timer);
					resolvePromise();
				};
				this.waiters.add(waiter);
			});
		}
		throw new Error(`Timed out waiting for ${pattern}.`);
	}

	async execute(command: string, promptPattern: RegExp, timeoutMs: number): Promise<string> {
		const startIndex = this.buffer.length;
		this.send(`${command}\n`);
		return await this.waitFor(promptPattern, timeoutMs, startIndex);
	}

	close(): void {
		this.socket.end();
	}
}

async function connectSerialConsole(port: number, timeoutMs: number): Promise<SerialConsoleSession> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const socket = await new Promise<SocketLike>((resolvePromise, reject) => {
				const candidate = nodeNet.createConnection({ host: "127.0.0.1", port }, () => resolvePromise(candidate));
				candidate.once("error", reject);
			});
			return new SerialConsoleSession(socket);
		} catch {
			await delay(1_000);
		}
	}
	throw new Error(`Timed out connecting to serial console on port ${port}.`);
}

async function waitForSshReady(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const output = await runCommand("sshpass", [
				"-p",
				"password123",
				"ssh",
				"-o",
				"StrictHostKeyChecking=no",
				"-o",
				"UserKnownHostsFile=/dev/null",
				"-o",
				"ConnectTimeout=5",
				"-p",
				"2222",
				"root@localhost",
				"uname",
				"-r",
			]);
			if (output.includes("6.6.4-1-lts")) {
				return;
			}
		} catch {
			// Retry until the guest-side SSH service comes up.
		}
		await delay(2_000);
	}
	throw new Error("SSH on port 2222 never became ready.");
}

async function runQemuAlpineSshHelper(parsed: ParsedBenchmarkHelperArgs): Promise<void> {
	const serialPort = Number.parseInt(process.env.PI_QUESTS_QEMU_SERIAL_PORT ?? "6665", 10);
	await runShellScript(QEMU_ALPINE_SSH_BOOT_SCRIPT, [parsed.inputPath, parsed.outputPath, String(serialPort)]);
	const consoleSession = await connectSerialConsole(serialPort, 30_000);
	let promptPinger: ReturnType<typeof setInterval> | undefined;
	try {
		consoleSession.send("\rroot\n");
		promptPinger = setInterval(() => consoleSession.send("\rroot\n"), 5_000);
		await consoleSession.waitFor(/# /, 600_000);
		clearInterval(promptPinger);
		promptPinger = undefined;
		await consoleSession.execute("ip link set eth0 up", /# /, 60_000);
		await consoleSession.execute("udhcpc -i eth0", /# /, 120_000);
		await consoleSession.execute("apk update", /# /, 300_000);
		await consoleSession.execute("apk add openssh", /# /, 300_000);
		await consoleSession.execute("ssh-keygen -A", /# /, 60_000);
		await consoleSession.execute(
			"if grep -q '^#\\?PermitRootLogin' /etc/ssh/sshd_config; then sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config; else echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config; fi",
			/# /,
			60_000,
		);
		await consoleSession.execute(
			"if grep -q '^#\\?PasswordAuthentication' /etc/ssh/sshd_config; then sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config; else echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config; fi",
			/# /,
			60_000,
		);
		await consoleSession.execute("echo 'root:password123' | chpasswd", /# /, 60_000);
		await consoleSession.execute("rc-update add sshd default", /# /, 60_000);
		await consoleSession.execute("service sshd restart", /# /, 60_000);
		const unameOutput = await consoleSession.execute("uname -r", /# /, 60_000);
		if (!unameOutput.includes("6.6.4-1-lts")) {
			throw new Error("Guest kernel version check did not match 6.6.4-1-lts.");
		}
	} finally {
		if (promptPinger) clearInterval(promptPinger);
		consoleSession.close();
	}
	await waitForSshReady(300_000);
}

const SQLITE_WITH_GCOV_SCRIPT = [
	"set -euo pipefail",
	'ARCHIVE_PATH="${1:-/app/vendor/sqlite-fossil-release.tar.gz}"',
	'TARGET_DIR="${2:-/app/sqlite}"',
	"export DEBIAN_FRONTEND=noninteractive",
	"apt-get update",
	"apt-get install -y gcc jimsh make tclsh tzdata",
	'rm -rf "$TARGET_DIR"',
	'mkdir -p "$TARGET_DIR"',
	'tar -xzf "$ARCHIVE_PATH" -C "$TARGET_DIR" --strip-components=1',
	'cd "$TARGET_DIR"',
	'CFLAGS="-g -ftest-coverage -fprofile-arcs" ./configure --enable-fts3 --enable-session',
	'make -j"$(nproc)"',
	'ln -sf "$TARGET_DIR/sqlite3" /usr/local/bin/sqlite3',
].join("\n");

async function runPythonScript(script: string, args: string[]): Promise<string> {
	return await new Promise<string>((resolvePromise, reject) => {
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
			resolvePromise(stdout.trim());
		});
	});
}

interface CommandOptions {
	cwd?: string;
}

async function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<string> {
	return await new Promise<string>((resolvePromise, reject) => {
		const proc = spawn(command, args, {
			cwd: options.cwd,
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
				reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code ?? 1}`));
				return;
			}
			resolvePromise(stdout.trim());
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
			resolvePromise();
		});
	});
}

async function replaceInFile(filePath: string, replacements: Array<[RegExp, string]>): Promise<void> {
	const original = await readFile(filePath, "utf-8");
	let updated = original;
	for (const [pattern, replacement] of replacements) {
		updated = updated.replace(pattern, replacement);
	}
	await writeFile(filePath, updated, "utf-8");
}

async function resolvePythonBinary(): Promise<string> {
	for (const candidate of ["python3", "python"]) {
		try {
			await runCommand(candidate, ["--version"]);
			return candidate;
		} catch {
			continue;
		}
	}
	throw new Error("python3 or python is required");
}

async function runBuildCythonExtHelper(parsed: ParsedBenchmarkHelperArgs): Promise<void> {
	const pythonBin = await resolvePythonBinary();
	await rm(parsed.outputPath, { recursive: true, force: true });
	await mkdir(dirname(parsed.outputPath), { recursive: true });
	await runCommand("git", [
		"clone",
		"--depth",
		"1",
		"--branch",
		"0.5.3",
		"https://github.com/SPOCKnots/pyknotid.git",
		parsed.outputPath,
	]);
	await replaceInFile(`${parsed.outputPath}/pyknotid/make/torus.py`, [[/from fractions import gcd/g, "from math import gcd"]]);
	await replaceInFile(`${parsed.outputPath}/pyknotid/spacecurves/spacecurve.py`, [[/n\.float\)/g, "n.float64)"]]);
	await replaceInFile(`${parsed.outputPath}/pyknotid/make/periodic_knot.py`, [[/dtype=n\.float\)/g, "dtype=n.float64)"]]);
	await replaceInFile(`${parsed.outputPath}/pyknotid/invariants.py`, [
		[/n\.complex/g, "n.complex128"],
		[/n\.float(?![0-9])/g, "n.float64"],
	]);
	await replaceInFile(`${parsed.outputPath}/pyknotid/representations/representation.py`, [[/n\.int\(/g, "int("]]);
	await replaceInFile(`${parsed.outputPath}/pyknotid/spacecurves/periodiccell.py`, [[/np\.int/g, "np.int64"]]);
	await replaceInFile(`${parsed.outputPath}/pyknotid/spacecurves/ccomplexity.pyx`, [[/np\.int/g, "np.int64"]]);
	await runCommand(pythonBin, ["-m", "pip", "install", "--disable-pip-version-check", "setuptools==80.9.0", "cython==3.1.3"]);
	await runCommand(pythonBin, ["setup.py", "build_ext", "--inplace"], { cwd: parsed.outputPath });
	await runCommand(pythonBin, ["-m", "pip", "install", "--disable-pip-version-check", "-e", "."], { cwd: parsed.outputPath });
}

export async function runBenchmarkHelper(parsed: ParsedBenchmarkHelperArgs): Promise<void> {
	if (parsed.family === "terminal-bench" && parsed.taskId === "chess-best-move") {
		const recoveredRows = JSON.parse(await runPythonScript(CHESS_BEST_MOVE_PYTHON, [parsed.inputPath])) as string[][];
		const winningMoves = findWhiteMateInOneMoves(recoveredRows);
		if (winningMoves.length === 0) {
			throw new Error("No mate-in-one moves found from recovered board.");
		}
		await mkdir(dirname(parsed.outputPath), { recursive: true });
		await writeFile(parsed.outputPath, `${winningMoves.join("\n")}\n`, "utf-8");
		return;
	}
	if (parsed.family === "terminal-bench" && parsed.taskId === "build-cython-ext") {
		await runBuildCythonExtHelper(parsed);
		return;
	}
	if (parsed.family === "terminal-bench" && parsed.taskId === "qemu-alpine-ssh") {
		await runQemuAlpineSshHelper(parsed);
		return;
	}
	if (parsed.family === "terminal-bench" && parsed.taskId === "qemu-startup") {
		await runShellScript(QEMU_STARTUP_SCRIPT, [parsed.inputPath, parsed.outputPath]);
		return;
	}
	if (parsed.family === "terminal-bench" && parsed.taskId === "sqlite-with-gcov") {
		await runShellScript(SQLITE_WITH_GCOV_SCRIPT, [parsed.inputPath, parsed.outputPath]);
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
