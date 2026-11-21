import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [input, output] = process.argv.slice(2);
if (!input || !output || input === output) {
	throw new Error("usage: bun android/patch-6.17-crop.ts <original libtwittermedia.so> <patched libtwittermedia.so>");
}

const library = Buffer.from(await Bun.file(input).arrayBuffer());
if (createHash("sha256").update(library).digest("hex") !== "927a38e2aa0690f096c3a31a390c3c751e65454a0029809c21389f14ddf2f8f2") {
	throw new Error("expected the original Twitter 6.17.0 arm64 libtwittermedia.so");
}

const executableSizeField = 0x60;
const helpersAddress = 0xfad88;
const nextSegmentOffset = 0xfb520;

function run(...args: string[]) {
	const command = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });
	if (command.exitCode !== 0) throw new Error(`${args[0]} failed`);
}

const temp = await mkdtemp(join(tmpdir(), "xitter-crop-"));
try {
	const object = join(temp, "crop.o");
	const linked = join(temp, "crop.elf");
	const binary = join(temp, "crop.bin");
	run("clang", "--target=aarch64-linux-gnu", "-c", join(import.meta.dir, "crop-fds-arm64.S"), "-o", object);
	run("ld.lld", "--image-base=0", `-Ttext=0x${helpersAddress.toString(16)}`, "-e", "crop_helpers", "--defsym=dup_plt=0xb870", "--defsym=fdopen_plt=0xbdb0",
		"--defsym=close_plt=0xb7c0", "--defsym=fclose_plt=0xbab0", "--defsym=crop_finish=0x16430", object, "-o", linked);
	run("llvm-objcopy", "-O", "binary", "--only-section=.text", linked, binary);
	const helpers = Buffer.from(await Bun.file(binary).arrayBuffer());
	const executableEnd = helpersAddress + helpers.length;
	if (helpers.length < 12 || executableEnd > nextSegmentOffset || library.subarray(helpersAddress, executableEnd).some((byte) => byte !== 0)) {
		throw new Error("crop helpers do not fit in the executable segment padding");
	}

	const cropCalls = [0x15d18, 0x15d2c, 0x15ecc];
	for (const [index, address] of cropCalls.entries()) {
		const displacement = (helpersAddress + index * 4 - address) / 4;
		library.writeUInt32LE(0x94000000 + displacement, address);
	}
	helpers.copy(library, helpersAddress);
	library.writeBigUInt64LE(BigInt(executableEnd), executableSizeField);
	library.writeBigUInt64LE(BigInt(executableEnd), executableSizeField + 8);
	await Bun.write(output, library);
} finally {
	await rm(temp, { recursive: true, force: true });
}
