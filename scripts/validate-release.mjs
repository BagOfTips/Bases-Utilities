import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readText = (name) => fs.readFileSync(path.join(root, name), "utf8");
const readJson = (name) => JSON.parse(readText(name));
const fail = (message) => {
  console.error(`Release validation failed: ${message}`);
  process.exitCode = 1;
};

const manifest = readJson("manifest.json");
const versions = readJson("versions.json");
const packageJson = readJson("package.json");
const semver = /^\d+\.\d+\.\d+$/;
const requiredFiles = [
  "LICENSE",
  "README.md",
  "main.js",
  "manifest.json",
  "styles.css",
  "versions.json",
];

for (const name of requiredFiles) {
  if (!fs.existsSync(path.join(root, name))) fail(`Missing required file: ${name}`);
}

if (!/^[a-z-]+$/.test(manifest.id)) fail("Plugin ID must use lowercase letters and hyphens only.");
if (manifest.id.includes("obsidian")) fail("Plugin ID cannot contain 'obsidian'.");
if (manifest.id.endsWith("plugin")) fail("Plugin ID cannot end with 'plugin'.");
if (!manifest.name || !/^[\x20-\x7E]+$/.test(manifest.name)) fail("Plugin name must use Basic Latin characters.");
if (manifest.name.toLocaleLowerCase().includes("obsidian")) fail("Plugin name cannot contain 'Obsidian'.");
if (!semver.test(manifest.version)) fail("Manifest version must use x.y.z semantic versioning.");
if (!semver.test(manifest.minAppVersion)) fail("Minimum app version must use x.y.z format.");
if (typeof manifest.description !== "string" || manifest.description.length > 250) {
  fail("Description must be a string of no more than 250 characters.");
}
if (!manifest.description.endsWith(".")) fail("Description must end with a period.");
if (typeof manifest.author !== "string" || !manifest.author.trim()) fail("Author is required.");
if (typeof manifest.isDesktopOnly !== "boolean") fail("isDesktopOnly must be a boolean.");
if (versions[manifest.version] !== manifest.minAppVersion) {
  fail("versions.json must map the current plugin version to minAppVersion.");
}
if (packageJson.version !== manifest.version) fail("package.json and manifest.json versions must match.");

const license = readText("LICENSE");
if (!license.includes("MIT License")) fail("LICENSE must identify the MIT license.");
if (!license.includes("Bag of Tips")) fail("LICENSE must identify Bag of Tips as the copyright holder.");

const readme = readText("README.md");
const demoPath = "assets/bases-utilities-demo.gif";
if (!readme.includes(demoPath)) fail("README must reference the demonstration GIF.");
if (!fs.existsSync(path.join(root, demoPath))) fail("The demonstration GIF is missing.");

if (!process.exitCode) console.log("Release metadata and required files are valid.");
