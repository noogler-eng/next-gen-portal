import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import { CompanyConfig, Job } from "./interfaces/index";

const ROOT_DIR = process.cwd();
const COMPANIES_PATH = path.join(ROOT_DIR, "data", "companies.json");
const SEEN_JOBS_PATH = path.join(ROOT_DIR, "data", "seen-jobs.json");
const README_PATH = path.join(ROOT_DIR, "README.md");

// Target filters (adjust regex to match your seniority & tech stack)
const TITLE_REGEX =
  /(software engineer|frontend|backend|fullstack|developer|junior)/i;
const EXCLUDE_REGEX = /(senior|staff|lead|principal|director|manager)/i;

async function fetchGreenhouseJobs(
  company: string,
  identifier: string,
): Promise<Job[]> {
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${identifier}/jobs`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { jobs: any[] };

    return data.jobs
      .filter(
        (j: any) => TITLE_REGEX.test(j.title) && !EXCLUDE_REGEX.test(j.title),
      )
      .map((j: any) => ({
        id: `gh-${identifier}-${j.id}`,
        company,
        title: j.title,
        url: j.absolute_url,
      }));
  } catch (e) {
    console.error(`Error fetching Greenhouse for ${company}:`, e);
    return [];
  }
}

async function fetchLeverJobs(
  company: string,
  identifier: string,
): Promise<Job[]> {
  try {
    const res = await fetch(
      `https://api.lever.co/v0/postings/${identifier}?mode=json`,
    );
    if (!res.ok) return [];
    const postings = (await res.json()) as any[];

    return postings
      .filter(
        (p: any) => TITLE_REGEX.test(p.text) && !EXCLUDE_REGEX.test(p.text),
      )
      .map((p: any) => ({
        id: `lever-${identifier}-${p.id}`,
        company,
        title: p.text,
        url: p.hostedUrl,
      }));
  } catch (e) {
    console.error(`Error fetching Lever for ${company}:`, e);
    return [];
  }
}

async function fetchHtmlJobs(company: string, url: string): Promise<Job[]> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Compatible; JobCrawlerBot/1.0)" },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const jobs: Job[] = [];

    $("a, h2, h3, li").each((_, el) => {
      const text = $(el).text().trim();
      if (
        TITLE_REGEX.test(text) &&
        !EXCLUDE_REGEX.test(text) &&
        text.length > 5 &&
        text.length < 100
      ) {
        let jobUrl = $(el).is("a")
          ? $(el).attr("href")
          : $(el).closest("a").attr("href") || url;
        if (jobUrl && !jobUrl.startsWith("http")) {
          const base = new URL(url);
          jobUrl = `${base.origin}${jobUrl.startsWith("/") ? "" : "/"}${jobUrl}`;
        }

        jobs.push({
          id: `html-${company.toLowerCase()}-${text.replace(/\s+/g, "-")}`,
          company,
          title: text.replace(/\s+/g, " ").trim(),
          url: jobUrl!,
        });
      }
    });

    return jobs;
  } catch (e) {
    console.error(`Error scraping HTML for ${company}:`, e);
    return [];
  }
}

async function run() {
  if (!fs.existsSync(COMPANIES_PATH)) {
    console.error("companies.json missing!");
    process.exit(1);
  }

  const companies: CompanyConfig[] = JSON.parse(
    fs.readFileSync(COMPANIES_PATH, "utf-8"),
  );

  // Load previously seen job IDs for state tracking
  let seenJobIds: string[] = [];
  if (fs.existsSync(SEEN_JOBS_PATH)) {
    seenJobIds = JSON.parse(fs.readFileSync(SEEN_JOBS_PATH, "utf-8"));
  }

  let allJobs: Job[] = [];

  for (const c of companies) {
    console.log(`Checking ${c.name} (${c.type})...`);
    if (c.type === "greenhouse" && c.identifier) {
      allJobs.push(...(await fetchGreenhouseJobs(c.name, c.identifier)));
    } else if (c.type === "lever" && c.identifier) {
      allJobs.push(...(await fetchLeverJobs(c.name, c.identifier)));
    } else if (c.type === "html" && c.url) {
      allJobs.push(...(await fetchHtmlJobs(c.name, c.url)));
    }
  }

  // Deduplicate jobs by ID
  const uniqueJobs = Array.from(
    new Map(allJobs.map((j) => [j.id, j])).values(),
  );

  // State Tracking & New Badge Detection
  const currentJobIds: string[] = [];
  const processedJobs: Job[] = uniqueJobs.map((job) => {
    currentJobIds.push(job.id);
    const isNew = !seenJobIds.includes(job.id);
    return { ...job, isNew };
  });

  // Save current run IDs back to seen-jobs.json
  fs.writeFileSync(
    SEEN_JOBS_PATH,
    JSON.stringify(currentJobIds, null, 2),
    "utf-8",
  );

  // Build a clean, high-end Markdown README UI
  let md = `# 🎯 Personal Automated Career Portal\n\n`;
  md += `> Live aggregator powered by GitHub Actions, TypeScript, APIs & HTML Scrapers.\n\n`;
  md += `**Last Checked:** \`${new Date().toUTCString()}\`  \n`;
  md += `**Active Positions Found:** \`${processedJobs.length}\`\n\n`;
  md += `---\n\n`;
  md += `| Status | Company | Role / Title | Direct Apply |\n`;
  md += `| :---: | :--- | :--- | :---: |\n`;

  if (processedJobs.length === 0) {
    md += `| — | No matching roles found at this moment. Check back tomorrow! | — | — |\n`;
  } else {
    for (const job of processedJobs) {
      const badge = job.isNew ? "🔥 **NEW**" : "✅ Active";
      md += `| ${badge} | **${job.company}** | ${job.title} | [Apply Here](${job.url}) |\n`;
    }
  }

  md += `\n\n---  \n*Maintained automatically via automated background workflows.*`;

  fs.writeFileSync(README_PATH, md, "utf-8");
  console.log(
    `README updated successfully with ${processedJobs.length} roles.`,
  );
}

run();
