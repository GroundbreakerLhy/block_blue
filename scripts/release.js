#!/usr/bin/env node
"use strict";

/**
 * Block Blue release script.
 *
 * Usage:
 *   npm run release           # prompt for patch / minor / major
 *   npm run release -- patch  # bump patch version
 *   npm run release -- minor  # bump minor version
 *   npm run release -- major  # bump major version
 *   npm run release -- 1.2.3  # set an explicit version
 *
 * The script updates:
 *   - manifest.json version
 *   - package.json version, if package.json exists
 *
 * Then it creates:
 *   - block-blue-v<version>.zip
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "manifest.json");
const packagePath = path.join(rootDir, "package.json");

const includes = [
  "manifest.json",
  "_locales",
  "background",
  "content",
  "icons",
  "popup",
];

const excludePatterns = ["*.DS_Store", "*__MACOSX*"];

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(
      `无法读取或解析 JSON 文件: ${path.relative(rootDir, filePath)}\n${error.message}`,
    );
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function assertRequiredFiles() {
  if (!fs.existsSync(manifestPath)) {
    fail("缺少 manifest.json");
  }

  for (const item of includes) {
    const itemPath = path.join(rootDir, item);
    if (!fs.existsSync(itemPath)) {
      fail(`缺少必要文件或目录: ${item}`);
    }
  }
}

function parseVersion(version) {
  if (typeof version !== "string") {
    return null;
  }

  const trimmed = version.trim();
  const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function bumpVersion(currentVersion, releaseType) {
  const parsed = parseVersion(currentVersion);
  if (!parsed) {
    fail(`当前版本号无效: ${currentVersion}。请使用 x.y.z 格式，例如 1.2.3`);
  }

  switch (releaseType) {
    case "major":
      return formatVersion({
        major: parsed.major + 1,
        minor: 0,
        patch: 0,
      });

    case "minor":
      return formatVersion({
        major: parsed.major,
        minor: parsed.minor + 1,
        patch: 0,
      });

    case "patch":
      return formatVersion({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch + 1,
      });

    default:
      fail(`未知版本递增类型: ${releaseType}`);
  }
}

async function promptForReleaseType(currentVersion) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      "未提供 release 参数，且当前环境无法交互选择。请使用 npm run release -- patch、minor 或 major",
    );
  }

  const choices = [
    { type: "patch", version: bumpVersion(currentVersion, "patch") },
    { type: "minor", version: bumpVersion(currentVersion, "minor") },
    { type: "major", version: bumpVersion(currentVersion, "major") },
  ];

  console.log("");
  console.log(`当前版本: v${currentVersion}`);
  console.log("请选择发布类型:");
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}) ${choice.type} -> v${choice.version}`);
  });
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (await rl.question("输入 1/2/3 或 patch/minor/major: "))
        .trim()
        .toLowerCase();
      const numberChoice = choices[Number(answer) - 1];
      const textChoice = choices.find((choice) => choice.type === answer);
      const choice = numberChoice || textChoice;

      if (choice) {
        return choice.type;
      }

      console.log("无效选择，请重新输入。");
    }
  } finally {
    rl.close();
  }
}

async function resolveNextVersion(currentVersion) {
  const arg = process.argv[2]?.trim();

  if (!arg) {
    const releaseType = await promptForReleaseType(currentVersion);
    return bumpVersion(currentVersion, releaseType);
  }

  if (["major", "minor", "patch"].includes(arg)) {
    return bumpVersion(currentVersion, arg);
  }

  if (parseVersion(arg)) {
    return arg;
  }

  fail(
    `无效 release 参数: ${arg}。请使用 major、minor、patch 或明确版本号，例如 1.2.3`,
  );
}

function updateVersions(nextVersion) {
  const manifest = readJson(manifestPath);
  manifest.version = nextVersion;
  writeJson(manifestPath, manifest);

  if (fs.existsSync(packagePath)) {
    const pkg = readJson(packagePath);
    pkg.version = nextVersion;
    writeJson(packagePath, pkg);
  }
}

function removeExistingZip(outputPath) {
  if (fs.existsSync(outputPath)) {
    fs.rmSync(outputPath);
  }
}

function ensureZipCommandAvailable() {
  const result = spawnSync("zip", ["-v"], {
    cwd: rootDir,
    stdio: "ignore",
  });

  if (result.error) {
    fail(
      "未找到 zip 命令。请先安装 zip，或在 macOS/Linux 环境下运行 release。",
    );
  }
}

function createZip(outputName) {
  const args = ["-r", outputName, ...includes, "-x", ...excludePatterns];

  const result = spawnSync("zip", args, {
    cwd: rootDir,
    stdio: "inherit",
  });

  if (result.error) {
    fail(`打包失败: ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(`zip 命令执行失败，退出码: ${result.status}`);
  }
}

function getFileSize(outputPath) {
  const bytes = fs.statSync(outputPath).size;
  const units = ["B", "KB", "MB", "GB"];

  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function main() {
  assertRequiredFiles();
  ensureZipCommandAvailable();

  const manifest = readJson(manifestPath);
  const currentVersion = manifest.version;
  const nextVersion = await resolveNextVersion(currentVersion);

  updateVersions(nextVersion);

  const outputName = `block-blue-v${nextVersion}.zip`;
  const outputPath = path.join(rootDir, outputName);

  removeExistingZip(outputPath);
  createZip(outputName);

  console.log("");
  console.log(`✅ Release 完成: ${outputName}`);
  console.log(`📦 版本: v${nextVersion}`);
  console.log(`📁 路径: ${outputPath}`);
  console.log(`📏 大小: ${getFileSize(outputPath)}`);
  console.log("");
}

main().catch((error) => {
  fail(error.message);
});
