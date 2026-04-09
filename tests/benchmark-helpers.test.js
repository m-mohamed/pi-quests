import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { findWhiteMateInOneMoves, parseArgs, runBenchmarkHelper } from "../src/benchmark-helpers.js";

const execFile = promisify(execFileCallback);

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

test("regex-log helper writes a regex that only captures the last valid date on lines with valid IPv4 addresses", async () => {
	const helperDir = await mkdtemp(join(tmpdir(), "pi-quests-regex-helper-"));
	const outputPath = join(helperDir, "regex.txt");
	try {
		await runBenchmarkHelper({
			family: "terminal-bench",
			taskId: "regex-log",
			inputPath: "/app",
			outputPath,
		});
		const pattern = (await readFile(outputPath, "utf-8")).trim();
		const regex = new RegExp(pattern.replace(/^\(\?m\)/, ""), "gm");
		const logText = [
			"no ip here 2024-01-01",
			"src=192.168.1.10 date=2024-01-05",
			"user 1134-12-1234 from 1.2.3.4 at 2024-02-29",
			"bad leading zero ip 01.2.3.4 date 2024-03-01",
			"10.0.0.1 first 2024-01-01 second 2024-02-02",
			"x10.0.0.1 trailing 2024-03-03",
			"10.0.0.1 2024-04-30z",
			"255.255.255.255 2024-04-30 ok",
			"256.0.0.1 2024-01-01",
			"host 9.8.7.6 saw 2024-02-30",
		].join("\n");
		const matches = [...logText.matchAll(regex)].map((match) => match[1]);
		assert.deepEqual(matches, ["2024-01-05", "2024-02-29", "2024-02-02", "2024-04-30"]);
	} finally {
		await rm(helperDir, { recursive: true, force: true });
	}
});

test("polyglot-c-py helper writes a single-file Python/C polyglot Fibonacci program", async () => {
	const helperDir = await mkdtemp(join(tmpdir(), "pi-quests-polyglot-helper-"));
	const outputPath = join(helperDir, "polyglot", "main.py.c");
	try {
		await runBenchmarkHelper({
			family: "terminal-bench",
			taskId: "polyglot-c-py",
			inputPath: join(helperDir, "polyglot"),
			outputPath,
		});
		const source = await readFile(outputPath, "utf-8");
		assert.match(source, /^#if 0/m);
		assert.match(source, /fib\(int\(sys\.argv\[1\]\)\)/);
		assert.match(source, /printf\("%llu\\n", a\);/);
		const pythonResult = await execFile("python3", [outputPath, "10"]);
		assert.equal(pythonResult.stdout.trim(), "55");
		let compiler = "";
		for (const candidate of ["cc", "clang", "gcc"]) {
			try {
				await execFile(candidate, ["--version"]);
				compiler = candidate;
				break;
			} catch {
				continue;
			}
		}
		assert.notEqual(compiler, "");
		const binaryPath = join(helperDir, "cmain");
		await execFile(compiler, [outputPath, "-o", binaryPath]);
		const cResult = await execFile(binaryPath, ["10"]);
		assert.equal(cResult.stdout.trim(), "55");
	} finally {
		await rm(helperDir, { recursive: true, force: true });
	}
});

test("log-summary-date-ranges helper writes the expected CSV counts", async () => {
	const helperDir = await mkdtemp(join(tmpdir(), "pi-quests-log-summary-helper-"));
	const logsDir = join(helperDir, "logs");
	const outputPath = join(helperDir, "summary.csv");
	try {
		await mkdir(logsDir, { recursive: true });
		await writeFile(
			join(logsDir, "2025-08-12_app.log"),
			[
				"2025-08-12 10:00:00 [INFO] hello",
				"2025-08-12 10:01:00 [ERROR] boom",
				"2025-08-12 10:02:00 [WARNING] warn",
				"2025-08-12 10:03:00 Next attempt will ERROR",
			].join("\n"),
			"utf-8",
		);
		await writeFile(
			join(logsDir, "2025-08-10_db.log"),
			["2025-08-10 10:00:00 [INFO] old", "2025-08-10 10:01:00 [INFO] old2"].join("\n"),
			"utf-8",
		);
		await writeFile(join(logsDir, "2025-07-31_auth.log"), "2025-07-31 10:00:00 [ERROR] july\n", "utf-8");
		await writeFile(join(logsDir, "2025-07-10_api.log"), "2025-07-10 10:00:00 [WARNING] old\n", "utf-8");
		await runBenchmarkHelper({
			family: "terminal-bench",
			taskId: "log-summary-date-ranges",
			inputPath: logsDir,
			outputPath,
		});
		assert.equal(
			await readFile(outputPath, "utf-8"),
			[
				"period,severity,count",
				"today,ERROR,1",
				"today,WARNING,1",
				"today,INFO,1",
				"last_7_days,ERROR,1",
				"last_7_days,WARNING,1",
				"last_7_days,INFO,3",
				"last_30_days,ERROR,2",
				"last_30_days,WARNING,1",
				"last_30_days,INFO,3",
				"month_to_date,ERROR,1",
				"month_to_date,WARNING,1",
				"month_to_date,INFO,3",
				"total,ERROR,2",
				"total,WARNING,2",
				"total,INFO,3",
				"",
			].join("\n"),
		);
	} finally {
		await rm(helperDir, { recursive: true, force: true });
	}
});

test("fix-code-vulnerability helper patches bottle header validation and writes report.jsonl", async () => {
	const helperDir = await mkdtemp(join(tmpdir(), "pi-quests-fix-vuln-helper-"));
	const appDir = join(helperDir, "app");
	const bottlePath = join(appDir, "bottle.py");
	const reportPath = join(appDir, "report.jsonl");
	try {
		await mkdir(appDir, { recursive: true });
		await writeFile(
			bottlePath,
			[
				"def _hkey(key):",
				"    key = touni(key)",
				"    return key.title().replace('_', '-')",
				"",
				"def _hval(value):",
				"    value = touni(value)",
				"    return value",
				"",
			].join("\n"),
			"utf-8",
		);
		await runBenchmarkHelper({
			family: "terminal-bench",
			taskId: "fix-code-vulnerability",
			inputPath: appDir,
			outputPath: reportPath,
		});
		const patched = await readFile(bottlePath, "utf-8");
		assert.match(patched, /Header names must not contain control characters/);
		assert.match(patched, /Header value must not contain control characters/);
		assert.equal(await readFile(reportPath, "utf-8"), '{"file_path":"/app/bottle.py","cwe_id":["cwe-93"]}\n');
	} finally {
		await rm(helperDir, { recursive: true, force: true });
	}
});

test("configure-git-webserver helper provisions git hooks and nginx config", async () => {
	const helperDir = await mkdtemp(join(tmpdir(), "pi-quests-configure-git-helper-"));
	const binDir = join(helperDir, "bin");
	const gitRoot = join(helperDir, "git", "server");
	const webRoot = join(helperDir, "web");
	const gitHome = join(helperDir, "home", "git");
	const nginxConfDir = join(helperDir, "nginx", "conf.d");
	const nginxDefaultSite = join(helperDir, "nginx", "sites-enabled", "default");
	const aptCaptureFile = join(helperDir, "apt-args.txt");
	const addUserCaptureFile = join(helperDir, "adduser-args.txt");
	const chpasswdCaptureFile = join(helperDir, "chpasswd.txt");
	const serviceCaptureFile = join(helperDir, "service-args.txt");
	const previousPath = process.env.PATH;
	const previousEnv = {
		PI_QUESTS_GIT_HOME: process.env.PI_QUESTS_GIT_HOME,
		PI_QUESTS_NGINX_CONF_DIR: process.env.PI_QUESTS_NGINX_CONF_DIR,
		PI_QUESTS_NGINX_DEFAULT_SITE: process.env.PI_QUESTS_NGINX_DEFAULT_SITE,
	};
	try {
		await mkdir(binDir, { recursive: true });
		await mkdir(join(helperDir, "nginx", "sites-enabled"), { recursive: true });
		await writeFile(nginxDefaultSite, "default\n", "utf-8");
		await writeFile(join(binDir, "apt-get"), `#!/bin/sh\nprintf '%s\\n' \"$@\" >> ${JSON.stringify(aptCaptureFile)}\n`, { mode: 0o755 });
		await writeFile(join(binDir, "adduser"), `#!/bin/sh\nprintf '%s\\n' \"$@\" > ${JSON.stringify(addUserCaptureFile)}\n`, { mode: 0o755 });
		await writeFile(join(binDir, "chpasswd"), `#!/bin/sh\ncat > ${JSON.stringify(chpasswdCaptureFile)}\n`, { mode: 0o755 });
		await writeFile(join(binDir, "chown"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await writeFile(join(binDir, "id"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		await writeFile(
			join(binDir, "git"),
			`#!/bin/sh
if [ "$1" = "init" ] && [ "$2" = "--bare" ]; then
  mkdir -p "$3/hooks"
fi
`,
			{ mode: 0o755 },
		);
		await writeFile(
			join(binDir, "su"),
			`#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-c" ]; then
    shift
    exec sh -lc "$1"
  fi
  shift
done
exit 1
`,
			{ mode: 0o755 },
		);
		await writeFile(join(binDir, "service"), `#!/bin/sh\nprintf '%s\\n' \"$@\" >> ${JSON.stringify(serviceCaptureFile)}\n`, { mode: 0o755 });
		process.env.PATH = `${binDir}:${previousPath ?? ""}`;
		process.env.PI_QUESTS_GIT_HOME = gitHome;
		process.env.PI_QUESTS_NGINX_CONF_DIR = nginxConfDir;
		process.env.PI_QUESTS_NGINX_DEFAULT_SITE = nginxDefaultSite;
		await runBenchmarkHelper({
			family: "terminal-bench",
			taskId: "configure-git-webserver",
			inputPath: webRoot,
			outputPath: gitRoot,
		});
		assert.match(await readFile(aptCaptureFile, "utf-8"), /openssh-server/);
		assert.match(await readFile(addUserCaptureFile, "utf-8"), /Git Version Control/);
		assert.match(await readFile(chpasswdCaptureFile, "utf-8"), /git:password/);
		assert.match(await readFile(join(gitRoot, "hooks", "post-receive"), "utf-8"), new RegExp(escapeRegExp(webRoot)));
		assert.match(await readFile(join(nginxConfDir, "git-site.conf"), "utf-8"), /listen 8080;/);
		assert.match(await readFile(join(nginxConfDir, "git-site.conf"), "utf-8"), new RegExp(escapeRegExp(webRoot)));
		assert.match(await readFile(serviceCaptureFile, "utf-8"), /ssh/);
		assert.match(await readFile(serviceCaptureFile, "utf-8"), /nginx/);
		await assert.rejects(() => readFile(nginxDefaultSite, "utf-8"));
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(helperDir, { recursive: true, force: true });
	}
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

test("qemu-startup helper boots the Alpine ISO over telnet-ready serial", async () => {
	const binDir = await mkdtemp(join(tmpdir(), "pi-quests-qemu-helper-"));
	const captureFile = join(binDir, "qemu-args.txt");
	const previousPath = process.env.PATH;
	try {
		await writeFile(
			join(binDir, "qemu-system-x86_64"),
			`#!/bin/sh\nprintf '%s\n' "$@" > ${JSON.stringify(captureFile)}\n`,
			{ mode: 0o755 },
		);
		await writeFile(join(binDir, "expect"), "#!/bin/sh\necho 'System is booted and ready'\n", { mode: 0o755 });
		process.env.PATH = `${binDir}:${previousPath ?? ""}`;
		await runBenchmarkHelper({
			family: "terminal-bench",
			taskId: "qemu-startup",
			inputPath: "/app/alpine.iso",
			outputPath: "/app/alpine-disk.qcow2",
		});
		const captured = await readFile(captureFile, "utf-8");
		assert.match(captured, /-cdrom/);
		assert.match(captured, /\/app\/alpine\.iso/);
		assert.match(captured, /-drive/);
		assert.match(captured, /\/app\/alpine-disk\.qcow2/);
		assert.match(captured, /-boot/);
		assert.match(captured, /\bd\b/);
		assert.match(captured, /-serial/);
		assert.match(captured, /mon:telnet:127\.0\.0\.1:6665/);
		assert.match(captured, /-daemonize/);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(binDir, { recursive: true, force: true });
	}
});

test("qemu-alpine-ssh helper provisions SSH from the overlay bootstrap script", async () => {
	const binDir = await mkdtemp(join(tmpdir(), "pi-quests-qemu-ssh-helper-"));
	const captureFile = join(binDir, "qemu-args.txt");
	const overlayCaptureDir = join(binDir, "overlay");
	const sshpassCaptureFile = join(binDir, "sshpass-args.txt");
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
		await writeFile(
			join(binDir, "tar"),
			`#!/bin/sh
: > "$2"
rm -rf ${JSON.stringify(overlayCaptureDir)}
mkdir -p ${JSON.stringify(overlayCaptureDir)}
cp -R "$PWD/etc" ${JSON.stringify(overlayCaptureDir)}/etc
cp -R "$PWD/root" ${JSON.stringify(overlayCaptureDir)}/root
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
printf 'ready\n'
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
		assert.match(captured, /-device\nvirtio-rng-pci/);
		assert.match(captured, /hostfwd=tcp::2222-:22/);
		assert.match(captured, /alpine_dev=sr0/);
		assert.match(captured, /modloop=\/boot\/modloop-lts/);
		assert.match(captured, /alpine_repo=\/media\/cdrom\/apks/);
		assert.match(captured, /apkovl=sdb:vfat:localhost\.apkovl\.tar\.gz/);
		assert.match(captured, /\.img,format=raw/);
		assert.match(captured, /-serial\nfile:\/tmp\/qemu-alpine-ssh-serial\.log/);
		assert.match(captured, /-daemonize/);
		const overlayInittab = await readFile(join(overlayCaptureDir, "etc/inittab"), "utf-8");
		const overlaySetupScript = await readFile(join(overlayCaptureDir, "root/setup-ssh.sh"), "utf-8");
		assert.match(overlayInittab, /ttyS0::respawn/);
		assert.match(overlayInittab, /::once:\/root\/setup-ssh\.sh/);
		assert.equal(await readFile(join(overlayCaptureDir, "etc/hostname"), "utf-8"), "localhost\n");
		assert.match(await readFile(join(overlayCaptureDir, "etc/securetty"), "utf-8"), /ttyS0/);
		assert.match(overlaySetupScript, /NET_IFACE="\$\(ip -o link show/);
		assert.match(overlaySetupScript, /ip link set "\$NET_IFACE" up/);
		assert.match(overlaySetupScript, /udhcpc -i "\$NET_IFACE"/);
		assert.match(overlaySetupScript, /setup-sshd -c dropbear/);
		assert.match(overlaySetupScript, /rc-service dropbear status/);
		assert.match(overlaySetupScript, /root:password123/);
		assert.match(overlaySetupScript, /touch "\$MARKER"/);
		const sshpassArgs = await readFile(sshpassCaptureFile, "utf-8");
		assert.match(sshpassArgs, /password123/);
		assert.match(sshpassArgs, /StrictHostKeyChecking=no/);
		assert.match(sshpassArgs, /-p/);
		assert.match(sshpassArgs, /2222/);
		assert.match(sshpassArgs, /root@localhost/);
		assert.match(sshpassArgs, /sh\n-lc\necho ready && uname -r/);
	} finally {
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
