#!/usr/bin/env node

import fs from "fs";
import path from "path";
import https from "https";
import { execSync } from "child_process";
import readline from "readline";
import chalk from "chalk";
import ora from "ora";
import boxen from "boxen";
import inquirer from "inquirer";

const CACHE_FILE = path.resolve(__dirname, ".dep-migrate-cache.json");
let cache: Record<string, any> = {};

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    } catch {
      cache = {};
    }
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function readPackageJson(): any {
  const pkgPath = path.resolve(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.error(chalk.red("❌ package.json not found in current directory"));
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
}

function writePackageJson(pkg: any) {
  const pkgPath = path.resolve(process.cwd(), "package.json");
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

function fetchNpmInfo(pkg: string, refresh = false): Promise<any> {
  if (!refresh && cache[`npmInfo:${pkg}`]) return Promise.resolve(cache[`npmInfo:${pkg}`]);

  return new Promise((resolve, reject) => {
    https.get(`https://registry.npmjs.org/${pkg}`, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          cache[`npmInfo:${pkg}`] = parsed;
          saveCache();
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

function fetchAlternative(pkg: string, refresh = false): Promise<string | null> {
  if (!refresh && cache[`alt:${pkg}`]) return Promise.resolve(cache[`alt:${pkg}`]);

  return new Promise((resolve) => {
    https.get(`https://api.npms.io/v2/search?q=${pkg}+replacement`, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          let suggestion: string | null = null;
          if (parsed.results && parsed.results.length > 0) {
            suggestion = parsed.results[0].package?.name || null;
          }
          cache[`alt:${pkg}`] = suggestion;
          saveCache();
          resolve(suggestion);
        } catch {
          resolve(null);
        }
      });
    }).on("error", () => resolve(null));
  });
}

function detectPackageManager(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function runInstall(pm: string) {
  console.log(chalk.blueBright(`📦 Running ${pm} install to update dependencies...`));
  try {
    if (pm === "yarn") execSync("yarn install", { stdio: "inherit" });
    else if (pm === "pnpm") execSync("pnpm install", { stdio: "inherit" });
    else if (pm === "bun") execSync("bun install", { stdio: "inherit" });
    else execSync("npm install", { stdio: "inherit" });
    console.log(chalk.greenBright("✅ Migration complete."));
  } catch (err) {
    console.error(chalk.red(`❌ Failed to install with ${pm}.`), err);
  }
}

function askQuestionRaw(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(chalk.cyanBright(query), answer => {
      rl.close();
      resolve(answer);
    });
  });
}

function askQuestion(query: string): Promise<boolean> {
  return askQuestionRaw(query).then(answer => answer.toLowerCase().startsWith("y"));
}

async function scanDependencies({ jsonOutput = false, refresh = false } = {}) {
  const pkg = readPackageJson();
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  const results: any[] = [];
  let deprecatedCount = 0;

  if (!jsonOutput) console.log(chalk.cyan("🔍 Scanning dependencies for deprecations...\n"));

  for (const dep of Object.keys(deps)) {
    const spinner = ora(`Checking ${dep}...`).start();
    try {
      const info = await fetchNpmInfo(dep, refresh);
      const latest = info["dist-tags"]?.latest;
      const deprecatedMsg = info.versions?.[latest]?.deprecated;

      if (deprecatedMsg) {
        deprecatedCount++;
        const alt = await fetchAlternative(dep, refresh);
        results.push({ dependency: dep, deprecated: true, message: deprecatedMsg, alternative: alt });
        spinner.stop();
        if (!jsonOutput) {
          console.log(
            boxen(
              chalk.redBright(`⚠️  ${dep} is deprecated`) +
                "\n" +
                chalk.gray(deprecatedMsg) +
                "\n" +
                (alt
                  ? chalk.greenBright(`→ Suggested replacement: ${alt}`)
                  : chalk.cyanBright("→ No suggestion available yet.")),
              { padding: 1, margin: 1, borderColor: "red" }
            )
          );
        }
      } else {
        spinner.succeed(`${dep} is healthy`);
        if (jsonOutput) results.push({ dependency: dep, deprecated: false });
      }
    } catch (err) {
      spinner.fail(`${dep} check failed`);
      if (!jsonOutput) console.error(chalk.red(`❌ Failed to fetch info for ${dep}`), err);
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(chalk.greenBright("✅ Scan complete.\n"));
    console.log(chalk.bold(`\nSummary:`));
    console.log(chalk.gray(`- Total dependencies: ${Object.keys(deps).length}`));
    console.log(chalk.cyanBright(`- Deprecated found: ${deprecatedCount}`));
    console.log(chalk.greenBright(`- Healthy: ${Object.keys(deps).length - deprecatedCount}`));
  }
}

async function migrateDependencies({ interactive = false, dryRun = false, jsonOutput = false, refresh = false } = {}) {
  const pkg = readPackageJson();
  let modified = false;

  const sections = ["dependencies", "devDependencies"] as const;
  const results: any[] = [];

  let replacedCount = 0;
  let skippedCount = 0;

  for (const section of sections) {
    if (!pkg[section]) continue;

    for (const dep of Object.keys(pkg[section])) {
      const spinner = ora(`Migrating ${dep}...`).start();
      try {
        const info = await fetchNpmInfo(dep, refresh);
        const latest = info["dist-tags"]?.latest;
        const deprecatedMsg = info.versions?.[latest]?.deprecated;

        if (deprecatedMsg) {
          const alt = await fetchAlternative(dep, refresh);
          let doReplace = true;
          if (interactive) {
            spinner.stop();
            doReplace = await askQuestion(`🔄 Replace ${dep} with ${alt || "<none>"}? (y/N) `);
          }
          if (doReplace && alt) {
            if (dryRun) {
              results.push({ dependency: dep, action: "would-replace", alternative: alt });
              if (!jsonOutput) console.log(chalk.cyanBright(`📝 [dry-run] Would replace ${dep} with ${alt}`));
              skippedCount++;
            } else {
              results.push({ dependency: dep, action: "replaced", alternative: alt });
              if (!jsonOutput) console.log(chalk.greenBright(`✔ Replacing ${dep} with ${alt}...`));
              delete pkg[section][dep];
              pkg[section][alt] = "latest";
              modified = true;
              replacedCount++;
            }
          } else {
            results.push({ dependency: dep, action: "skipped" });
            if (!jsonOutput) console.log(chalk.gray(`⏭ Skipped replacing ${dep}.`));
            skippedCount++;
          }
        } else {
          spinner.succeed(`${dep} is fine`);
        }
        spinner.stop();
      } catch (err) {
        spinner.fail(`${dep} migration check failed`);
        if (!jsonOutput) console.error(chalk.red(`❌ Failed to fetch info for ${dep}`), err);
      }
    }
  }

  if (!dryRun && modified) {
    writePackageJson(pkg);
    const pm = detectPackageManager();
    runInstall(pm);
  } else if (!modified && !jsonOutput) {
    console.log(dryRun ? chalk.blue("✨ Dry-run: No changes would be made.") : chalk.blue("✨ No deprecated dependencies migrated."));
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(chalk.bold("\nSummary:"));
    console.log(chalk.greenBright(`- Replaced: ${replacedCount}`));
    console.log(chalk.gray(`- Skipped: ${skippedCount}`));
  }
}

async function showMenu() {
  console.clear();
  console.log(chalk.cyanBright.bold("\n╔══════════════════════════════════╗"));
  console.log(chalk.cyanBright.bold("║     📦  Dep Migrate CLI Tool     ║"));
  console.log(chalk.cyanBright.bold("╚══════════════════════════════════╝\n"));

  console.log(chalk.cyanBright("Welcome to dep-migrate!"));
  console.log(chalk.gray("A migration assistant for deprecated npm packages."));
  console.log();

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Select an action:",
      choices: [
        { name: "1) Scan for deprecated packages (with flags)", value: "scan" },
        { name: "2) Migrate deprecated packages (with flags)", value: "migrate" },
        { name: "3) Help & Docs", value: "help" },
        { name: "Exit", value: "exit" }
      ]
    }
  ]);

  if (action === "scan" || action === "migrate") {
    const { flags } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "flags",
        message: "Select flags to use:",
        choices: [
          { name: "--interactive (ask before replacing)", value: "interactive" },
          { name: "--dry-run (simulate without changes)", value: "dryRun" },
          { name: "--json (output in JSON)", value: "json" },
          { name: "--refresh-cache (force re-fetch)", value: "refresh" }
        ]
      }
    ]);

    if (action === "scan") {
      await scanDependencies({
        jsonOutput: flags.includes("json"),
        refresh: flags.includes("refresh")
      });
    } else {
      await migrateDependencies({
        interactive: flags.includes("interactive"),
        dryRun: flags.includes("dryRun"),
        jsonOutput: flags.includes("json"),
        refresh: flags.includes("refresh")
      })
    }
  } else if (action === "help") {
    console.log(boxen(
      chalk.green("Available Flags:\n") +
      "--interactive → Ask before replacing each package\n" +
      "--dry-run     → Show changes without applying them\n" +
      "--json        → Output results as JSON\n" +
      "--refresh-cache → Force re-fetch package info\n",
      { padding: 1, borderColor: "green" }
    ));
  } else process.exit(0);
}

(async () => {
  loadCache();
  showMenu();
})();
