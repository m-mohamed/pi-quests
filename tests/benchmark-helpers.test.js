import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs, runBenchmarkHelper } from "../src/benchmark-helpers.js";

test("benchmark helper CLI parses family, task, input, and output", () => {
	const parsed = parseArgs(["terminal-bench", "chess-best-move", "/app/chess_board.png", "/app/move.txt"]);
	assert.deepEqual(parsed, {
		family: "terminal-bench",
		taskId: "chess-best-move",
		inputPath: "/app/chess_board.png",
		outputPath: "/app/move.txt",
	});
});

test("benchmark helper rejects unsupported tasks", async () => {
	await assert.rejects(
		() =>
			runBenchmarkHelper({
				family: "terminal-bench",
				taskId: "unknown-task",
				inputPath: "/tmp/in",
				outputPath: "/tmp/out",
			}),
		/no native helper registered/i,
	);
});

test("qemu-startup helper boots extracted Alpine kernel over serial telnet", async () => {
	const binDir = await mkdtemp(join(tmpdir(), "pi-quests-qemu-helper-"));
	const captureFile = join(binDir, "qemu-args.txt");
	const previousPath = process.env.PATH;
	try {
		await writeFile(
			join(binDir, "qemu-system-x86_64"),
			`#!/bin/sh\nprintf '%s\n' "$@" > ${JSON.stringify(captureFile)}\n`,
			{ mode: 0o755 },
		);
		await writeFile(
			join(binDir, "bsdtar"),
			"#!/bin/sh\nprintf 'stub-archive'\n",
			{ mode: 0o755 },
		);
		await writeFile(join(binDir, "mkfs.vfat"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await writeFile(join(binDir, "mcopy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await writeFile(join(binDir, "expect"), "#!/bin/sh\necho 'System is booted and ready'\n", { mode: 0o755 });
		process.env.PATH = `${binDir}:${previousPath ?? ""}`;
		await runBenchmarkHelper({
			family: "terminal-bench",
			taskId: "qemu-startup",
			inputPath: "/app/alpine.iso",
			outputPath: "/app/alpine-disk.qcow2",
		});
		const captured = await readFile(captureFile, "utf-8");
		assert.match(captured, /-kernel/);
		assert.match(captured, /vmlinuz-lts/);
		assert.match(captured, /-initrd/);
		assert.match(captured, /initramfs-lts/);
		assert.match(captured, /\/app\/alpine\.iso/);
		assert.match(captured, /-drive/);
		assert.match(captured, /\/app\/alpine-disk\.qcow2/);
		assert.match(captured, /hostname=localhost/);
		assert.match(captured, /\.img,format=raw/);
		assert.match(captured, /-serial/);
		assert.match(captured, /127\.0\.0\.1:6665/);
		assert.doesNotMatch(captured, /mon:telnet/);
		assert.match(captured, /-daemonize/);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(binDir, { recursive: true, force: true });
	}
});
