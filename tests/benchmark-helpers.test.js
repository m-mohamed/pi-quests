import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findWhiteMateInOneMoves, parseArgs, runBenchmarkHelper } from "../src/benchmark-helpers.js";

function boardRows(...rows) {
	return rows.map((row) => row.split("").map((cell) => (cell === "." ? "" : cell)));
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

test("findWhiteMateInOneMoves finds defended queen mates", () => {
	const moves = findWhiteMateInOneMoves(
		boardRows(
			".......k",
			"........",
			".....KQ.",
			"........",
			"........",
			"........",
			"........",
			"........",
		),
	);
	assert.deepEqual(moves, ["g6g7"]);
});

test("findWhiteMateInOneMoves filters out pseudo-mates that drop the queen", () => {
	const moves = findWhiteMateInOneMoves(
		boardRows(
			".......k",
			"........",
			"......Q.",
			"........",
			"........",
			"........",
			"....K...",
			"........",
		),
	);
	assert.deepEqual(moves, []);
});

test("findWhiteMateInOneMoves matches the terminal-bench sample board", () => {
	const moves = findWhiteMateInOneMoves(
		boardRows(
			"r.bq.r..",
			".p...pp.",
			"p.n.p...",
			"...nPkbP",
			"........",
			"P.N.....",
			".P..QPP.",
			"R.B.K..R",
		),
	);
	assert.deepEqual(moves, ["e2e4", "g2g4"]);
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

test("qemu-alpine-ssh helper boots Alpine and provisions SSH via overlay", async () => {
	const binDir = await mkdtemp(join(tmpdir(), "pi-quests-qemu-ssh-helper-"));
	const captureFile = join(binDir, "qemu-args.txt");
	const overlayCaptureDir = join(binDir, "overlay");
	const sshpassCaptureFile = join(binDir, "sshpass-args.txt");
	const serialCommands = [];
	const previousPath = process.env.PATH;
	const previousSerialPort = process.env.PI_QUESTS_QEMU_SERIAL_PORT;
	let serialPort = "0";
	const serialServer = createServer((socket) => {
		let buffer = "";
		let loggedIn = false;
		socket.setEncoding("utf8");
		socket.write("localhost login: ");
		socket.on("data", (chunk) => {
			buffer += String(chunk).replace(/\r/g, "\n");
			while (buffer.includes("\n")) {
				const newlineIndex = buffer.indexOf("\n");
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!loggedIn) {
					if (line === "root") {
						loggedIn = true;
						socket.write("localhost:~# ");
					} else if (!line) {
						socket.write("localhost login: ");
					}
					continue;
				}
				if (!line) {
					socket.write("localhost:~# ");
					continue;
				}
				serialCommands.push(line);
				if (line === "uname -r") {
					socket.write("6.6.4-1-lts\nlocalhost:~# ");
					continue;
				}
				socket.write("localhost:~# ");
			}
		});
	});
	try {
		await new Promise((resolvePromise, reject) => {
			serialServer.once("error", reject);
			serialServer.listen(0, "127.0.0.1", resolvePromise);
		});
		const address = serialServer.address();
		assert.ok(address && typeof address === "object");
		serialPort = String(address.port);
		process.env.PI_QUESTS_QEMU_SERIAL_PORT = serialPort;
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
		await writeFile(
			join(binDir, "tar"),
			`#!/bin/sh
: > "$2"
rm -rf ${JSON.stringify(overlayCaptureDir)}
mkdir -p ${JSON.stringify(overlayCaptureDir)}
cp -R "$PWD/etc" ${JSON.stringify(overlayCaptureDir)}/etc
`,
			{ mode: 0o755 },
		);
		await writeFile(
			join(binDir, "mcopy"),
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(join(binDir, "mcopy-args.txt"))}
exit 0
`,
			{ mode: 0o755 },
		);
		await writeFile(
			join(binDir, "sshpass"),
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(sshpassCaptureFile)}
printf '6.6.4-1-lts\n'
`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${binDir}:${previousPath ?? ""}`;
		await runBenchmarkHelper({
			family: "terminal-bench",
			taskId: "qemu-alpine-ssh",
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
		assert.match(captured, /hostfwd=tcp::2222-:22/);
		assert.match(captured, new RegExp(`127\\.0\\.0\\.1:${serialPort}`));
		assert.match(captured, /\.img,format=raw/);
		assert.doesNotMatch(captured, /mon:telnet/);
		assert.match(captured, /-daemonize/);
		const overlayInittab = await readFile(join(overlayCaptureDir, "etc/inittab"), "utf-8");
		assert.match(overlayInittab, /ttyS0::respawn/);
		assert.equal(await readFile(join(overlayCaptureDir, "etc/hostname"), "utf-8"), "localhost\n");
		assert.match(await readFile(join(overlayCaptureDir, "etc/securetty"), "utf-8"), /ttyS0/);
		const sshpassArgs = await readFile(sshpassCaptureFile, "utf-8");
		assert.match(sshpassArgs, /password123/);
		assert.match(sshpassArgs, /StrictHostKeyChecking=no/);
		assert.match(sshpassArgs, /-p/);
		assert.match(sshpassArgs, /2222/);
		assert.match(sshpassArgs, /root@localhost/);
		assert.match(sshpassArgs, /uname\n-r/);
		assert.deepEqual(serialCommands, [
			"ip link set eth0 up",
			"udhcpc -i eth0",
			"apk update",
			"apk add openssh",
			"ssh-keygen -A",
			"if grep -q '^#\\?PermitRootLogin' /etc/ssh/sshd_config; then sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config; else echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config; fi",
			"if grep -q '^#\\?PasswordAuthentication' /etc/ssh/sshd_config; then sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config; else echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config; fi",
			"echo 'root:password123' | chpasswd",
			"rc-update add sshd default",
			"service sshd restart",
			"uname -r",
		]);
	} finally {
		await new Promise((resolvePromise) => serialServer.close(resolvePromise));
		if (previousSerialPort === undefined) delete process.env.PI_QUESTS_QEMU_SERIAL_PORT;
		else process.env.PI_QUESTS_QEMU_SERIAL_PORT = previousSerialPort;
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(binDir, { recursive: true, force: true });
	}
});

test("build-cython-ext helper clones, patches, and builds pyknotid", async () => {
	const binDir = await mkdtemp(join(tmpdir(), "pi-quests-cython-helper-bin-"));
	const appDir = await mkdtemp(join(tmpdir(), "pi-quests-cython-helper-app-"));
	const targetDir = join(appDir, "pyknotid");
	const gitCaptureFile = join(binDir, "git-args.txt");
	const pythonCaptureFile = join(binDir, "python-args.txt");
	const pythonCwdFile = join(binDir, "python-cwd.txt");
	const previousPath = process.env.PATH;
	try {
		await writeFile(
			join(binDir, "git"),
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(gitCaptureFile)}
target="$7"
mkdir -p "$target/pyknotid/make" "$target/pyknotid/spacecurves" "$target/pyknotid/representations"
printf 'from fractions import gcd\n' > "$target/pyknotid/make/torus.py"
printf 'value = n.float)\n' > "$target/pyknotid/spacecurves/spacecurve.py"
printf 'arr = dtype=n.float)\n' > "$target/pyknotid/make/periodic_knot.py"
printf 'n.complex here\nn.float\ntrailing n.float\n' > "$target/pyknotid/invariants.py"
printf 'return n.int(value)\n' > "$target/pyknotid/representations/representation.py"
printf 'dtype = np.int\n' > "$target/pyknotid/spacecurves/periodiccell.py"
printf 'dtype = np.int\n' > "$target/pyknotid/spacecurves/ccomplexity.pyx"
printf 'from setuptools import setup\nsetup()\n' > "$target/setup.py"
`,
			{ mode: 0o755 },
		);
		await writeFile(
			join(binDir, "python3"),
			`#!/bin/sh
printf '%s\n' "$PWD" >> ${JSON.stringify(pythonCwdFile)}
printf '%s\n' "$@" >> ${JSON.stringify(pythonCaptureFile)}
if [ "$1" = "setup.py" ]; then
  mkdir -p "$PWD/pyknotid/spacecurves"
  : > "$PWD/pyknotid/cinvariants.so"
  : > "$PWD/pyknotid/spacecurves/chelpers.so"
  : > "$PWD/pyknotid/spacecurves/ccomplexity.so"
fi
`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${binDir}:${previousPath ?? ""}`;
		await runBenchmarkHelper({
			family: "terminal-bench",
			taskId: "build-cython-ext",
			inputPath: appDir,
			outputPath: targetDir,
		});
		const gitArgs = await readFile(gitCaptureFile, "utf-8");
		assert.match(gitArgs, /clone/);
		assert.match(gitArgs, /0\.5\.3/);
		assert.match(gitArgs, new RegExp(escapeRegExp(targetDir)));
		assert.equal(await readFile(join(targetDir, "pyknotid/make/torus.py"), "utf-8"), "from math import gcd\n");
		assert.equal(await readFile(join(targetDir, "pyknotid/spacecurves/spacecurve.py"), "utf-8"), "value = n.float64)\n");
		assert.equal(
			await readFile(join(targetDir, "pyknotid/make/periodic_knot.py"), "utf-8"),
			"arr = dtype=n.float64)\n",
		);
		assert.equal(
			await readFile(join(targetDir, "pyknotid/representations/representation.py"), "utf-8"),
			"return int(value)\n",
		);
		assert.equal(
			await readFile(join(targetDir, "pyknotid/spacecurves/periodiccell.py"), "utf-8"),
			"dtype = np.int64\n",
		);
		assert.equal(
			await readFile(join(targetDir, "pyknotid/spacecurves/ccomplexity.pyx"), "utf-8"),
			"dtype = np.int64\n",
		);
		const invariants = await readFile(join(targetDir, "pyknotid/invariants.py"), "utf-8");
		assert.match(invariants, /n\.complex128/);
		assert.match(invariants, /n\.float64/);
		assert.doesNotMatch(invariants, /n\.complex[^0-9]/);
		const pythonArgs = await readFile(pythonCaptureFile, "utf-8");
		assert.match(pythonArgs, /-m/);
		assert.match(pythonArgs, /pip/);
		assert.match(pythonArgs, /setuptools==80\.9\.0/);
		assert.match(pythonArgs, /cython==3\.1\.3/);
		assert.match(pythonArgs, /setup\.py/);
		assert.match(pythonArgs, /build_ext/);
		assert.match(pythonArgs, /--inplace/);
		assert.match(pythonArgs, /-e/);
		const pythonCwds = await readFile(pythonCwdFile, "utf-8");
		assert.match(pythonCwds, new RegExp(escapeRegExp(targetDir)));
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(binDir, { recursive: true, force: true });
		await rm(appDir, { recursive: true, force: true });
	}
});

test("sqlite-with-gcov helper unpacks, configures coverage flags, and installs sqlite3", async () => {
	const binDir = await mkdtemp(join(tmpdir(), "pi-quests-sqlite-helper-bin-"));
	const appDir = await mkdtemp(join(tmpdir(), "pi-quests-sqlite-helper-app-"));
	const archivePath = join(appDir, "sqlite-fossil-release.tar.gz");
	const targetDir = join(appDir, "sqlite");
	const aptCaptureFile = join(binDir, "apt-args.txt");
	const tarCaptureFile = join(binDir, "tar-args.txt");
	const configureCaptureFile = join(binDir, "configure-env.txt");
	const makeCaptureFile = join(binDir, "make-args.txt");
	const lnCaptureFile = join(binDir, "ln-args.txt");
	const previousPath = process.env.PATH;
	try {
		await writeFile(archivePath, "stub-archive");
		await writeFile(
			join(binDir, "apt-get"),
			`#!/bin/sh
printf '%s\n' "$@" >> ${JSON.stringify(aptCaptureFile)}
`,
			{ mode: 0o755 },
		);
		await writeFile(
			join(binDir, "tar"),
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(tarCaptureFile)}
target=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    target="$1"
    break
  fi
  shift
done
mkdir -p "$target"
cat <<'EOF' > "$target/configure"
#!/bin/sh
printf '%s\n' "$CFLAGS" > ${JSON.stringify(configureCaptureFile)}
EOF
chmod +x "$target/configure"
`,
			{ mode: 0o755 },
		);
		await writeFile(
			join(binDir, "nproc"),
			"#!/bin/sh\nprintf '8\n'",
			{ mode: 0o755 },
		);
		await writeFile(
			join(binDir, "make"),
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(makeCaptureFile)}
: > sqlite3
: > coverage.gcno
`,
			{ mode: 0o755 },
		);
		await writeFile(
			join(binDir, "ln"),
			`#!/bin/sh
printf '%s\n' "$@" > ${JSON.stringify(lnCaptureFile)}
`,
			{ mode: 0o755 },
		);
		process.env.PATH = `${binDir}:${previousPath ?? ""}`;
		await runBenchmarkHelper({
			family: "terminal-bench",
			taskId: "sqlite-with-gcov",
			inputPath: archivePath,
			outputPath: targetDir,
		});
		const aptArgs = await readFile(aptCaptureFile, "utf-8");
		assert.match(aptArgs, /update/);
		assert.match(aptArgs, /install/);
		assert.match(aptArgs, /gcc/);
		assert.match(aptArgs, /jimsh/);
		assert.match(aptArgs, /make/);
		assert.match(aptArgs, /tclsh/);
		assert.match(aptArgs, /tzdata/);
		const tarArgs = await readFile(tarCaptureFile, "utf-8");
		assert.match(tarArgs, /-xzf/);
		assert.match(tarArgs, new RegExp(escapeRegExp(archivePath)));
		assert.match(tarArgs, new RegExp(escapeRegExp(targetDir)));
		assert.match(await readFile(configureCaptureFile, "utf-8"), /-ftest-coverage -fprofile-arcs/);
		assert.match(await readFile(makeCaptureFile, "utf-8"), /-j8/);
		assert.match(await readFile(lnCaptureFile, "utf-8"), new RegExp(escapeRegExp(`${targetDir}/sqlite3`)));
		assert.match(await readFile(lnCaptureFile, "utf-8"), /\/usr\/local\/bin\/sqlite3/);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(binDir, { recursive: true, force: true });
		await rm(appDir, { recursive: true, force: true });
	}
});
